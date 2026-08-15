import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractConversation } from '../lib/recap.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('extractConversation: labels turns, skips sidechains/tool-only/<...> content', async () => {
  const convo = await extractConversation(path.join(fixtures, 'convo.jsonl'));
  assert.equal(convo,
    'User: add a dark mode\n\n' +
    'Assistant: Adding dark mode now.\n\n' +
    'User: looks great, ship it');
});

test('extractConversation: truncates long conversations keeping head and tail', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-recap-'));
  const fp = path.join(dir, 'long.jsonl');
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push(JSON.stringify({ type: 'user', isSidechain: false,
      message: { role: 'user', content: `message number ${i} ` + 'x'.repeat(100) } }));
  }
  await fsp.writeFile(fp, lines.join('\n'));
  const convo = await extractConversation(fp, 5000);
  assert.ok(convo.length <= 5000 + 30); // marker allowance
  assert.ok(convo.includes('[... truncated ...]'));
  assert.ok(convo.includes('message number 0'));
  assert.ok(convo.includes('message number 199'));
});

import { runClaudeRecap, getRecap } from '../lib/recap.js';

const fakeClaude = path.join(fixtures, 'fake-claude.sh');

test('runClaudeRecap: parses .result from the JSON envelope', async () => {
  assert.equal(await runClaudeRecap('User: hi', { command: fakeClaude }), 'FAKE RECAP');
});

test('runClaudeRecap: rejects on non-zero exit', async () => {
  await assert.rejects(() => runClaudeRecap('x', { command: 'false' }), /exited/);
});

test('getRecap: caches by mtime, regenerates when the log grows', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-recapcache-'));
  const log = path.join(dir, 'sess.jsonl');
  const cacheDir = path.join(dir, 'recaps');
  await fsp.writeFile(log, JSON.stringify(
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'hello' } }) + '\n');

  const first = await getRecap(log, 'sess', cacheDir, { command: fakeClaude });
  assert.equal(first, 'FAKE RECAP');

  // Second call with a *broken* command must still succeed — served from cache.
  const cached = await getRecap(log, 'sess', cacheDir, { command: 'false' });
  assert.equal(cached, 'FAKE RECAP');

  // force:true bypasses a fresh cache — the broken command must actually run and fail.
  await assert.rejects(() => getRecap(log, 'sess', cacheDir, { command: 'false', force: true }));

  // Grow the log (bump mtime): cache is stale, the broken command now fails.
  await new Promise(r => setTimeout(r, 20));
  await fsp.appendFile(log, JSON.stringify(
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'more' } }) + '\n');
  await assert.rejects(() => getRecap(log, 'sess', cacheDir, { command: 'false' }));
});

test('runClaudeRecap: rejects when output has no .result field', async () => {
  const fakeNoResult = path.join(fixtures, 'fake-claude-noresult.sh');
  await assert.rejects(() => runClaudeRecap('x', { command: fakeNoResult }), /no result/);
});
