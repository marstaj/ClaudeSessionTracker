import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { cachedParse, INDEX_FORMAT } from './indexer.js';

// Codex CLI keeps one "rollout" jsonl per session under
// <codexDir>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl, plus a flat
// <codexDir>/session_index.jsonl of human thread names. Its records are
// {timestamp, ordinal, type, payload}: `session_meta` carries the session id
// and cwd, `response_item` carries the conversation turns, and the rest
// (token counts, world state, events) is noise for our purposes.

const NAME_MAX = 80;
const SEARCH_TEXT_MAX = 500; // see lib/indexer.js — same trade-off

// The first non-empty text block of a Codex message payload. User turns use
// `input_text`, assistant turns `output_text`; images and other block types
// have no text to summarize.
export function codexMessageText(payload) {
  if (!Array.isArray(payload?.content)) return null;
  for (const block of payload.content) {
    if (typeof block?.text === 'string' && block.text.trim()) return block.text.trim();
  }
  return null;
}

// Harness-authored text Codex files under the `user` role: the AGENTS.md
// instructions injected into every session, and the prompts of its
// approval-review sub-agent. Neither is the user talking — these are the
// counterpart of Claude's sidechain and <system-reminder> records.
const HARNESS_PREFIXES = [
  '# AGENTS.md instructions',
  'The following is the Codex agent history',
];

// A conversation turn from a Codex record, or null for anything that isn't
// one. `developer` messages are Codex's own injected instructions, and
// <...>-wrapped user text is harness context (<environment_context> etc.),
// both of which would drown out the actual conversation.
export function codexTurn(obj) {
  if (obj?.type !== 'response_item') return null;
  const p = obj.payload;
  if (p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) return null;
  const text = codexMessageText(p);
  if (!text || text.startsWith('<')) return null;
  if (p.role === 'user' && HARNESS_PREFIXES.some(prefix => text.startsWith(prefix))) return null;
  return { role: p.role, text };
}

// Rollout file names end in the session's uuid — the fallback when a file has
// no session_meta record (interrupted writes, format drift).
function idFromFileName(filePath) {
  const base = path.basename(filePath, '.jsonl');
  const m = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return m ? m[0] : base;
}

export async function parseCodexSessionFile(filePath) {
  let sessionId = null, cwd = null, firstPrompt = null, searchText = null, createdAt = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'session_meta') {
      const p = obj.payload ?? {};
      sessionId ??= p.session_id ?? p.id ?? null;
      if (!cwd && typeof p.cwd === 'string' && p.cwd) cwd = p.cwd;
      if (createdAt === null) {
        const ms = Date.parse(p.timestamp ?? obj.timestamp);
        if (Number.isFinite(ms)) createdAt = ms;
      }
    }
    if (!firstPrompt) {
      const turn = codexTurn(obj);
      if (turn?.role === 'user') {
        firstPrompt = turn.text.slice(0, NAME_MAX);
        searchText = turn.text.slice(0, SEARCH_TEXT_MAX);
      }
    }
  }
  const stat = await fsp.stat(filePath);
  return {
    sessionId: sessionId ?? idFromFileName(filePath),
    source: 'codex',
    filePath,
    cwd,
    customTitle: null, // filled from session_index.jsonl by buildCodexIndex
    firstPrompt,
    searchText,
    createdAt: createdAt ?? stat.birthtimeMs,
    lastActivity: stat.mtimeMs,
    size: stat.size,
  };
}

// sessionId -> thread name, from the newest entry per id (the file appends a
// fresh record on every rename). Missing file means no names, not an error.
export async function loadThreadNames(indexFile) {
  const names = new Map();
  let raw;
  try { raw = await fsp.readFile(indexFile, 'utf8'); } catch { return names; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.id && obj.thread_name) names.set(obj.id, obj.thread_name);
    } catch { /* skip malformed line */ }
  }
  return names;
}

// Rollout files are nested year/month/day deep, so walk rather than readdir.
async function rolloutFiles(dir) {
  const found = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await rolloutFiles(fp));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(fp);
  }
  return found;
}

// Resuming a Codex session appends a *new* rollout file under the same
// session id, so one session can span several files. Collapse them into one
// row: the newest rollout represents the session — its file is the one a
// recap should read — carrying the earliest start, the combined size, and the
// opening prompt from the oldest rollout that has one.
function collapseRollouts(rows) {
  const byId = new Map();
  for (const row of rows) {
    const prev = byId.get(row.sessionId);
    if (!prev) { byId.set(row.sessionId, row); continue; }
    const newest = row.lastActivity > prev.lastActivity ? row : prev;
    const earliest = prev.createdAt <= row.createdAt ? prev : row;
    byId.set(row.sessionId, {
      ...newest,
      createdAt: Math.min(prev.createdAt, row.createdAt),
      size: prev.size + row.size,
      firstPrompt: earliest.firstPrompt ?? newest.firstPrompt,
      searchText: earliest.searchText ?? newest.searchText,
    });
  }
  return [...byId.values()];
}

export async function buildCodexIndex(codexDir, cache) {
  const files = {};
  const sessions = [];
  const names = await loadThreadNames(path.join(codexDir, 'session_index.jsonl'));
  for (const fp of await rolloutFiles(path.join(codexDir, 'sessions'))) {
    const res = await cachedParse(fp, cache, parseCodexSessionFile);
    if (!res) continue;
    files[fp] = res.entry;
    sessions.push(res.data);
  }
  // Thread names live in a file the per-rollout cache can't see, so they are
  // applied after the cache — a rename shows up without re-parsing.
  const rows = collapseRollouts(sessions).map(s => ({
    ...s,
    customTitle: names.get(s.sessionId) ?? null,
    project: s.cwd,
  }));
  return { sessions: rows, cache: { v: INDEX_FORMAT, files } };
}
