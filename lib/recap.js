import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { messageText } from './indexer.js';

export async function extractConversation(filePath, maxChars = 50_000) {
  const parts = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.isSidechain) continue;
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const text = messageText(obj.message);
    if (!text || text.startsWith('<')) continue;
    parts.push(`${obj.type === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  let convo = parts.join('\n\n');
  if (convo.length > maxChars) {
    const head = Math.floor(maxChars * 0.4);
    const tail = Math.floor(maxChars * 0.6);
    convo = convo.slice(0, head) + '\n\n[... truncated ...]\n\n' + convo.slice(-tail);
  }
  return convo;
}

const PROMPT =
  'Below is a transcript of a Claude Code session. Write a short recap: ' +
  'what the user wanted, what was done, and where it ended up. ' +
  '3-6 sentences, plain text, no headings.';

export function runClaudeRecap(conversation, { command = 'claude', model = 'haiku', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['-p', PROMPT, '--model', model, '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json'],
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('recap timed out after 120s'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    // If claude exits before draining stdin, the pipe emits EPIPE; without a
    // listener that's an uncaught exception that kills the whole server.
    child.stdin.on('error', () => {}); // 'close'/'error' above own the rejection
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      try {
        const result = JSON.parse(out).result;
        if (typeof result !== 'string' || !result) return reject(new Error('claude output had no result'));
        resolve(result);
      } catch { reject(new Error('could not parse claude JSON output')); }
    });
    child.stdin.end(conversation);
  });
}

// Memo so the refresh loop doesn't re-parse unchanged recap files: full
// path -> { fileMtime, cachedMtime }. Entries for deleted files just stop
// being visited; the map stays one entry per recap file ever seen.
const recapMetaMemo = new Map();

// Which of the given sessions have a cached recap that is still current —
// same mtime-match rule getRecap serves from, so a flagged session's recap
// loads instantly. mtimeById: sessionId -> transcript mtimeMs.
export async function cachedRecapIds(cacheDir, mtimeById) {
  const ids = new Set();
  let entries = [];
  try { entries = await fsp.readdir(cacheDir); } catch { return ids; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    const mtime = mtimeById.get(id);
    if (mtime === undefined) continue;
    const fp = path.join(cacheDir, entry);
    let stat;
    try { stat = await fsp.stat(fp); } catch { continue; }
    let memo = recapMetaMemo.get(fp);
    if (!memo || memo.fileMtime !== stat.mtimeMs) {
      let cachedMtime = null;
      try { cachedMtime = JSON.parse(await fsp.readFile(fp, 'utf8')).mtime; }
      catch { /* unreadable cache entry — treat as absent */ }
      memo = { fileMtime: stat.mtimeMs, cachedMtime };
      recapMetaMemo.set(fp, memo);
    }
    if (memo.cachedMtime === mtime) ids.add(id);
  }
  return ids;
}

let queue = Promise.resolve();

export async function getRecap(filePath, sessionId, cacheDir, opts = {}) {
  const stat = await fsp.stat(filePath);
  const cacheFile = path.join(cacheDir, `${sessionId}.json`);
  if (!opts.force) {
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      if (cached.mtime === stat.mtimeMs) return cached.recap;
    } catch { /* no cache */ }
  }
  const run = queue.then(async () => {
    const convo = await extractConversation(filePath);
    if (!convo) throw new Error('no conversation content found in this session');
    const recap = await runClaudeRecap(convo, opts);
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify({ mtime: stat.mtimeMs, recap }));
    return recap;
  });
  queue = run.catch(() => {}); // one at a time; a failure doesn't wedge the queue
  return run;
}
