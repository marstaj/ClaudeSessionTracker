import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

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
  let cwd = null, customTitle = null, firstPrompt = null, createdAt = null;
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
      if (text && !text.startsWith('<')) firstPrompt = text.slice(0, 80);
    }
  }
  const stat = await fsp.stat(filePath);
  return {
    sessionId,
    cwd,
    customTitle,
    firstPrompt,
    createdAt: createdAt ?? stat.birthtimeMs,
    lastActivity: stat.mtimeMs,
    size: stat.size,
  };
}

export async function buildIndex(projectsDir, cache) {
  const files = {};
  const sessions = [];
  let dirs = [];
  try { dirs = await fsp.readdir(projectsDir); } catch { return { sessions, cache: { files } }; }
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    let entries = [];
    try { entries = await fsp.readdir(dirPath); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = path.join(dirPath, entry);
      let stat;
      try { stat = await fsp.stat(fp); } catch { continue; }
      const cached = cache?.files?.[fp];
      let data;
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        data = cached.data;
      } else {
        try { data = await parseSessionFile(fp); } catch { continue; }
      }
      files[fp] = { mtime: stat.mtimeMs, size: stat.size, data };
      sessions.push({ ...data, project: data.cwd ?? demungeDirName(dir) });
    }
  }
  return { sessions, cache: { files } };
}

export async function loadCache(cachePath) {
  try { return JSON.parse(await fsp.readFile(cachePath, 'utf8')); } catch { return { files: {} }; }
}

export async function saveCache(cachePath, cache) {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  await fsp.writeFile(cachePath, JSON.stringify(cache));
}
