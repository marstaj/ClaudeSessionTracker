import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { parseSessionFile, messageText, demungeDirName, buildIndex, loadCache, saveCache } from '../lib/indexer.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('parseSessionFile: titled session — last custom-title wins, cwd + firstPrompt extracted', async () => {
  const r = await parseSessionFile(path.join(fixtures, 'titled.jsonl'));
  assert.equal(r.sessionId, 'titled');
  assert.equal(r.customTitle, 'widget builder');
  assert.equal(r.cwd, '/Users/someone/development/personal/Widget');
  assert.equal(r.firstPrompt, 'build me a widget');
  assert.equal(r.createdAt, Date.parse('2026-08-13T10:00:00.000Z'));
  assert.ok(r.lastActivity > 0);
  assert.ok(r.size > 0);
});

test('parseSessionFile: untitled — skips <...> prompts, truncates to 80 chars, numeric timestamp', async () => {
  const r = await parseSessionFile(path.join(fixtures, 'untitled.jsonl'));
  assert.equal(r.customTitle, null);
  assert.ok(r.firstPrompt.startsWith('fix the login bug'));
  assert.equal(r.firstPrompt.length, 80);
  assert.equal(r.createdAt, 1755079200000);
});

test('parseSessionFile: malformed lines and sidechains skipped', async () => {
  const r = await parseSessionFile(path.join(fixtures, 'messy.jsonl'));
  assert.equal(r.firstPrompt, 'real prompt');
  assert.equal(r.cwd, '/tmp/x');
});

test('parseSessionFile: empty file yields nulls but valid stat fields', async () => {
  const r = await parseSessionFile(path.join(fixtures, 'empty.jsonl'));
  assert.equal(r.customTitle, null);
  assert.equal(r.firstPrompt, null);
  assert.equal(r.cwd, null);
  assert.ok(r.createdAt > 0); // falls back to file birthtime
});

test('messageText: string, array, and empty content', () => {
  assert.equal(messageText({ content: '  hi  ' }), 'hi');
  assert.equal(messageText({ content: [{ type: 'tool_use' }, { type: 'text', text: 'from block' }] }), 'from block');
  assert.equal(messageText({ content: '' }), null);
  assert.equal(messageText(null), null);
});

test('demungeDirName: best-effort path', () => {
  assert.equal(demungeDirName('-Users-someone-development-foo'), '/Users/someone/development/foo');
});

async function makeProjectsDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-'));
  const p1 = path.join(dir, '-Users-someone-development-personal-Widget');
  await fsp.mkdir(p1, { recursive: true });
  await fsp.copyFile(path.join(fixtures, 'titled.jsonl'), path.join(p1, 'aaaa1111.jsonl'));
  await fsp.copyFile(path.join(fixtures, 'untitled.jsonl'), path.join(p1, 'bbbb2222.jsonl'));
  // Create a session file without cwd to test demungeDirName fallback
  await fsp.writeFile(path.join(p1, 'cccc3333.jsonl'), '{"type":"user","isSidechain":false,"message":{"role":"user","content":"no cwd here"}}\n');
  return dir;
}

test('buildIndex: scans dirs, sets project from cwd, falls back to demunged dir name', async () => {
  const dir = await makeProjectsDir();
  const { sessions, cache } = await buildIndex(dir, { files: {} });
  assert.equal(sessions.length, 3);
  const titled = sessions.find(s => s.sessionId === 'aaaa1111');
  assert.equal(titled.project, '/Users/someone/development/personal/Widget'); // from cwd
  const nocwd = sessions.find(s => s.sessionId === 'cccc3333');
  assert.equal(nocwd.project, '/Users/someone/development/personal/Widget'); // from demungeDirName fallback
  assert.equal(Object.keys(cache.files).length, 3);
});

test('buildIndex: unchanged files come from cache, changed files re-parse', async () => {
  const dir = await makeProjectsDir();
  const first = await buildIndex(dir, { files: {} });
  // Poison the cache: if buildIndex re-parsed, the marker would disappear.
  for (const entry of Object.values(first.cache.files)) entry.data.customTitle = 'CACHED-MARKER';
  const second = await buildIndex(dir, first.cache);
  assert.ok(second.sessions.every(s => s.customTitle === 'CACHED-MARKER'));
  // Now touch one file: it must re-parse (marker gone on that one).
  const fp = Object.keys(second.cache.files)[0];
  await fsp.appendFile(fp, '\n');
  const third = await buildIndex(dir, second.cache);
  const reparsed = third.sessions.find(s => s.sessionId === path.basename(fp, '.jsonl'));
  assert.notEqual(reparsed.customTitle, 'CACHED-MARKER');
});

test('buildIndex: missing projects dir yields empty result', async () => {
  const { sessions } = await buildIndex('/nonexistent/nowhere', { files: {} });
  assert.deepEqual(sessions, []);
});

test('cache round-trips through disk; missing cache file yields empty cache', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-cache-'));
  const cachePath = path.join(dir, 'sub', 'index.json');
  assert.deepEqual(await loadCache(cachePath), { files: {} });
  await saveCache(cachePath, { files: { '/a': { mtime: 1, size: 2, data: { sessionId: 'x' } } } });
  const loaded = await loadCache(cachePath);
  assert.equal(loaded.files['/a'].data.sessionId, 'x');
});
