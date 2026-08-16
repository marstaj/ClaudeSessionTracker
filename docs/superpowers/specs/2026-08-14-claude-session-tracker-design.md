# Claude Session Tracker — Design

**Date:** 2026-08-14 (updated 2026-08-16 to match the implementation as built)
**Status:** Implemented

## Purpose

A local web dashboard that tracks all Claude Code sessions on this machine —
historical and live — showing each session's ID, name, project, live status,
and last activity, filterable by name and project. Includes an on-demand
AI recap of any session's conversation.

## Constraints

- Zero runtime dependencies: Node.js built-ins only, no npm install, no build step.
- No API keys: the recap feature uses headless `claude -p` on the user's
  subscription, never the Anthropic API.
- Never commits automatically — all git commits are done by the user.

## Architecture

```
ClaudeSessionTracker/
├── server.js           # HTTP server + SSE, fs.watch refresh loop (Node built-ins only)
├── lib/
│   ├── indexer.js      # .jsonl transcript parsing, incremental index cache
│   ├── registry.js     # live registry, PID liveness, merge + name resolution
│   ├── recap.js        # conversation extraction + headless claude -p recap
│   └── groups.js       # load/validate/save of project pill groups
├── public/index.html   # Single-page UI (vanilla JS + CSS, one file)
├── bin/cst             # Launcher command (bash), symlinked onto PATH
├── test/               # node:test unit + server integration tests, fixtures/
├── groups.json         # user-defined project groups — user data, gitignored
├── .cache/             # index.json, recaps/, server.log, server.pid — gitignored
└── docs/superpowers/specs/  # this document
```

Server listens on `http://localhost:4747`. Runtime state (pidfile, log) lives
in `.cache/`; `groups.json` deliberately lives *outside* `.cache/` so clearing
the cache can't delete user data.

Configuration is via environment variables, all optional: `TRACKER_PORT`
(default 4747), `TRACKER_CLAUDE_DIR` (default `~/.claude`), `TRACKER_RECAP_CMD`
(default `claude`), `TRACKER_RECAP_MODEL` (default `haiku`),
`TRACKER_GROUPS_FILE` (default `groups.json` in the repo root).

## Data sources

1. **Historical sessions:** `~/.claude/projects/<munged-path>/<session-id>.jsonl`
   — one file per session (~97 files, ~222 MB currently).
2. **Live registry:** `~/.claude/sessions/<pid>.json` — one file per running
   Claude Code process, containing `pid`, `sessionId`, `cwd`, `name`, `status`
   (`busy`/`idle`), `kind`, timestamps. Entries are stale unless the PID is
   alive.

## Indexing

On startup, scan all project `.jsonl` files. Per file, extract:

- **Session ID** — the filename.
- **Project** — the `cwd` field from a log line; fallback: de-munge the
  directory name (`-Users-someone-development-foo` → best-effort path).
  `/` and macOS temp dirs (`/var/folders/…/T`, the cwd of headless
  `claude -p` runs) are normalized to the label `<headless-temp>`.
- **Name** — resolution order:
  1. last `{"type":"custom-title"}` entry in the log (`customTitle` field),
  2. `name` from the live registry (matched by sessionId),
  3. first user prompt, truncated (~80 chars),
  4. `<no name>`.
- **Last activity** — file mtime.
- **Created** — first timestamp found in the log (fallback: file birthtime).

Files are streamed line-by-line (never loaded whole). The index is cached at
`.cache/index.json` keyed by file path with `{mtime, size, fields}`; on
refresh, only files whose mtime or size changed are re-parsed. First full scan
is a one-time cost; subsequent startups and refreshes are incremental.

## Live status

Read every `~/.claude/sessions/*.json`, keep entries whose PID responds to
`process.kill(pid, 0)`, merge into the index by session ID. Each session row
gets a state: **busy**, **idle**, or **ended** (no live entry).

## Real-time updates

- `fs.watch` on `~/.claude/sessions/` (status/name changes rewrite these
  files) and on `~/.claude/projects/` subdirectories (activity touches the
  jsonl).
- Watch events are debounced (~500 ms), trigger an incremental re-index, and
  push the updated session list to connected browsers via Server-Sent Events
  (`GET /api/events`).
- Fallback: if `fs.watch` proves unreliable on macOS, a 2-second poll of
  directory mtimes replaces it. No chokidar.
- The browser's `EventSource` auto-reconnects; on reconnect the client
  re-fetches the full list.

## HTTP API

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `public/index.html` |
| `/api/sessions` | GET | Full session list (JSON) |
| `/api/events` | SSE | Pushes updated session lists on change |
| `/api/recap/:sessionId` | POST | Generates (or returns cached) recap; `?force=1` regenerates |
| `/api/groups` | GET/PUT | Read / replace the project pill groups (persisted to `groups.json`) |
| `/api/health` | GET | `200 OK` — used by the `cst` launcher |
| `/api/shutdown` | POST | Graceful exit — used by `cst stop` |

## Recap (on demand)

- Extract user and assistant message text from the session's jsonl (skip tool
  results, attachments, sidechains), truncated to a bounded size (~50k chars,
  keeping the start and end of the conversation).
- Spawn hermetic headless Claude:
  `claude -p --model haiku --strict-mcp-config --setting-sources "" --output-format json`
  with cwd set to the OS temp dir (prevents the 20-minute MCP/skill loading
  hang), prompt asking for a short recap. Parse the `.result` field of the
  JSON envelope. Haiku keeps recaps fast; override via `TRACKER_RECAP_MODEL`.
- Cache the recap in `.cache/recaps/<sessionId>.json` keyed by the log file's
  mtime — re-clicking an unchanged session returns instantly; a session that
  grew regenerates. A regenerate button (↻) forces a fresh recap via
  `?force=1`, bypassing the cache.
- One recap runs at a time (simple queue); the UI shows a spinner.

## UI

Single page, table of sessions sorted by last activity, newest first.

- **Top bar:** free-text filter (case-insensitive substring match on name),
  a row of project pills (populated from the index, multi-select; empty
  selection = all projects), "live only" toggle, live/total counts.
- **Pill groups:** user-defined groups of projects, edited in the dashboard
  itself (✎ groups → create/delete groups, toggle project membership) and
  persisted server-side via `PUT /api/groups` so they survive restarts.
  Clicking a group pill selects/deselects all of its member projects.
- **Row:** status dot (green = busy, amber = idle, grey = ended), name,
  project short name (last path segment; full path on hover), truncated
  session ID (click copies the full ID), relative last-activity time
  ("3m ago"), Recap button.
- **Recap:** expands inline under the row — spinner while generating, then
  the summary text; errors shown in place.
- Updates arrive over SSE; no manual refresh needed.

## `cst` command

Bash script at `bin/cst`, symlinked onto PATH.

- `cst start` — if `/api/health` doesn't respond: start `node server.js`
  detached (`nohup`, output to `.cache/server.log`, PID to
  `.cache/server.pid`), wait for health. Then `open http://localhost:4747`.
- `cst stop` — POST `/api/shutdown`; if the server doesn't respond, kill
  the pidfile PID. Cleans up the pidfile.
- `cst status` — prints running/stopped and the URL.

## Security

- Binds `127.0.0.1` only.
- Requests with a `Host` header other than `localhost:<port>` /
  `127.0.0.1:<port>` are rejected with 403 (DNS-rebinding guard).
- Non-GET requests with a foreign `Origin` header are rejected with 403
  (cross-site write guard — blocks web pages from firing side-effect POSTs
  at the local server).
- Unhandled request errors return a generic `500 internal error`; details go
  to the server log only.
- All session-derived strings (names, projects, recaps) are rendered with
  `textContent` — never `innerHTML` — since transcript content is untrusted.

## Error handling

- Malformed jsonl lines: skipped silently.
- Missing/unreadable session or project files: tolerated, row omitted or
  partial.
- Stale live-registry files (dead PID): ignored.
- Recap failure (claude exits non-zero, timeout ~120 s): error message shown
  inline in the UI; nothing cached.
- Port 4747 already in use: server exits with a clear message (`cst`
  treats an occupied healthy port as "already running").

## Testing

- `node --test` unit tests per lib module (indexer, registry/name resolution,
  recap, groups), run against small fixture `.jsonl` files in `test/fixtures/`
  (custom-title present / absent, malformed lines, empty file).
- Recap logic tested against fake `claude` shell stubs (no real `claude -p`
  in tests), covering the JSON envelope, error paths, and cache behavior.
- Server integration tests spawn the real server on a test port with env
  overrides and exercise every route, including the watch → debounce →
  refresh → SSE broadcast pipeline (a new session file must produce a
  broadcast frame).
- UI and launcher verified by manual smoke test.

## Out of scope (YAGNI)

- Historical browsing of message contents, search within conversations.
- Sorting options beyond last-activity, pagination.
- Auto-start at login (LaunchAgent) — can be added later if wanted.
- Multi-machine or remote access; the server binds localhost only.
