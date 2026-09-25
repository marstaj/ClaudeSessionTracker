import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

// Index cache format version. Bump whenever parsed session data gains or
// changes fields: entries written by an older format are re-parsed instead of
// served from a cache that predates them.
export const INDEX_FORMAT = 3;

// The display name is a short slice of the first prompt; searchText keeps a
// longer slice so the filter can match words the truncated name drops. It
// rides in every SSE broadcast, so the limit is a deliberate trade: 500 chars
// covers a normal opening prompt for ~60% more payload, where 2000 tripled it.
const NAME_MAX = 80;
const SEARCH_TEXT_MAX = 500;

export function demungeDirName(dirName) {
  // Best-effort only: directory names encode '/' as '-', so path segments
  // containing '-' cannot be recovered. Used only when no cwd line exists.
  return dirName.replace(/-/g, '/');
}

export function messageText(message) {
  if (!message) return null;
  const c = message.content;
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    for (const block of c) {
      if (block?.type === 'text' && block.text?.trim()) return block.text.trim();
    }
  }
  return null;
}

function toMs(t) {
  return typeof t === 'number' ? t : Date.parse(t);
}

export async function parseSessionFile(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');
  let cwd = null, customTitle = null, firstPrompt = null, searchText = null, createdAt = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle;
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
    if (createdAt === null && obj.timestamp != null) {
      const ms = toMs(obj.timestamp);
      if (Number.isFinite(ms)) createdAt = ms;
    }
    if (!firstPrompt && obj.type === 'user' && !obj.isSidechain) {
      const text = messageText(obj.message);
      if (text && !text.startsWith('<')) {
        firstPrompt = text.slice(0, NAME_MAX);
        searchText = text.slice(0, SEARCH_TEXT_MAX);
      }
    }
  }
  const stat = await fsp.stat(filePath);
  return {
    sessionId,
    source: 'claude',
    filePath,
    cwd,
    customTitle,
    firstPrompt,
    searchText,
    createdAt: createdAt ?? stat.birthtimeMs,
    lastActivity: stat.mtimeMs,
    size: stat.size,
  };
}

// Parse one session file with the mtime+size cache in front of it — `parse`
// owns the file format, so both session sources share the caching rule.
// Returns null when the file can't be stat'd or parsed (caller skips it).
export async function cachedParse(filePath, cache, parse) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return null; }
  const cached = cache?.v === INDEX_FORMAT ? cache?.files?.[filePath] : null;
  let data;
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    data = cached.data;
  } else {
    try { data = await parse(filePath); } catch { return null; }
  }
  return { entry: { mtime: stat.mtimeMs, size: stat.size, data }, data };
}

export async function buildIndex(projectsDir, cache) {
  const files = {};
  const sessions = [];
  let dirs = [];
  try { dirs = await fsp.readdir(projectsDir); }
  catch { return { sessions, cache: { v: INDEX_FORMAT, files } }; }
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    let entries = [];
    try { entries = await fsp.readdir(dirPath); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = path.join(dirPath, entry);
      const res = await cachedParse(fp, cache, parseSessionFile);
      if (!res) continue;
      files[fp] = res.entry;
      sessions.push({ ...res.data, project: res.data.cwd ?? demungeDirName(dir) });
    }
  }
  return { sessions, cache: { v: INDEX_FORMAT, files } };
}

export async function loadCache(cachePath) {
  try { return JSON.parse(await fsp.readFile(cachePath, 'utf8')); } catch { return { files: {} }; }
}

export async function saveCache(cachePath, cache) {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  await fsp.writeFile(cachePath, JSON.stringify(cache));
}
