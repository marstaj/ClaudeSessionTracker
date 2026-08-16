import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadCache, saveCache } from './lib/indexer.js';
import { readLiveSessions, mergeLive } from './lib/registry.js';
import { getRecap } from './lib/recap.js';
import { loadGroups, saveGroups, isValidGroups } from './lib/groups.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TRACKER_PORT ?? 4747);
const CLAUDE_DIR = process.env.TRACKER_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
const RECAP_CMD = process.env.TRACKER_RECAP_CMD ?? 'claude';
const RECAP_MODEL = process.env.TRACKER_RECAP_MODEL ?? 'haiku';
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const CACHE_DIR = path.join(__dirname, '.cache');
const INDEX_CACHE = path.join(CACHE_DIR, 'index.json');
const RECAP_DIR = path.join(CACHE_DIR, 'recaps');
const GROUPS_FILE = process.env.TRACKER_GROUPS_FILE ?? path.join(__dirname, 'groups.json');

let cache = { files: {} };
let sessions = [];
let filePathById = new Map();
const sseClients = new Set();
let refreshing = false;
let refreshQueued = false;

async function refresh() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const res = await buildIndex(PROJECTS_DIR, cache);
    cache = res.cache;
    filePathById = new Map(
      Object.entries(cache.files).map(([fp, v]) => [v.data.sessionId, fp]),
    );
    const live = await readLiveSessions(SESSIONS_DIR);
    sessions = mergeLive(res.sessions, live);
    await saveCache(INDEX_CACHE, cache);
    broadcast();
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh();
    }
  }
}

function broadcast() {
  const frame = `data: ${JSON.stringify(sessions)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

let debounceTimer = null;
function scheduleRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => refresh().catch(err => console.error('refresh failed:', err)), 500);
}

function watchDir(dir) {
  // fs.watch recursive works on macOS; fall back to polling if it throws.
  try { fs.watch(dir, { recursive: true }, scheduleRefresh); }
  catch { setInterval(scheduleRefresh, 2000).unref(); }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Browsers can reach 127.0.0.1 from any web page, so trust only our own names:
// a foreign Host means DNS rebinding (the page could then read our responses),
// a foreign Origin on a write means a cross-site request with side effects.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) {
      return json(res, 403, { error: 'forbidden host' });
    }
    if (req.method !== 'GET' && req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
      return json(res, 403, { error: 'forbidden origin' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const body = await fsp.readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.method === 'GET' && url.pathname === '/api/sessions') {
      json(res, 200, sessions);
    } else if (req.method === 'GET' && url.pathname === '/api/groups') {
      json(res, 200, await loadGroups(GROUPS_FILE));
    } else if (req.method === 'PUT' && url.pathname === '/api/groups') {
      let groups;
      try { groups = JSON.parse(await readBody(req)); } catch { groups = null; }
      if (!isValidGroups(groups)) return json(res, 400, { error: 'invalid groups payload' });
      await saveGroups(GROUPS_FILE, groups);
      json(res, 200, groups);
    } else if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200); res.end('ok');
    } else if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(sessions)}\n\n`); // current list on connect
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      res.on('error', () => sseClients.delete(res));
    } else if (req.method === 'POST' && url.pathname.startsWith('/api/recap/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/recap/'.length));
      const fp = filePathById.get(id);
      if (!fp) return json(res, 404, { error: 'unknown session' });
      try {
        json(res, 200, { recap: await getRecap(fp, id, RECAP_DIR,
          { command: RECAP_CMD, model: RECAP_MODEL, force: url.searchParams.get('force') === '1' }) });
      } catch (e) {
        json(res, 500, { error: String(e.message ?? e) });
      }
    } else if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      res.writeHead(200); res.end('bye');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    console.error('request failed:', e);
    try {
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error'); // details stay in the log, not the response
    } catch {
      // connection lost; nothing more to send
    }
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is the tracker already running?`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', async () => {
  cache = await loadCache(INDEX_CACHE);
  await refresh();
  console.log(`Claude Session Tracker on http://localhost:${PORT}`);
  watchDir(SESSIONS_DIR);
  watchDir(PROJECTS_DIR);
});
