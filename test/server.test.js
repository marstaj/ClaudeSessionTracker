import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
const PORT = 47470;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let proj;

before(async () => {
  const claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-claude-'));
  proj = path.join(claudeDir, 'projects', '-Users-someone-development-personal-Widget');
  await fsp.mkdir(proj, { recursive: true });
  await fsp.mkdir(path.join(claudeDir, 'sessions'), { recursive: true });
  await fsp.copyFile(path.join(fixtures, 'titled.jsonl'), path.join(proj, 'aaaa1111.jsonl'));
  child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, TRACKER_PORT: String(PORT), TRACKER_CLAUDE_DIR: claudeDir,
           TRACKER_RECAP_CMD: path.join(fixtures, 'fake-claude.sh'),
           TRACKER_GROUPS_FILE: path.join(claudeDir, 'groups.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server never became healthy');
});

after(() => child?.kill());

test('GET / serves the page', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('GET /api/sessions returns the indexed session', async () => {
  const rows = await (await fetch(BASE + '/api/sessions')).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'aaaa1111');
  assert.equal(rows[0].name, 'widget builder');
  assert.equal(rows[0].status, 'ended');
});

test('POST /api/recap/:id returns recap; unknown id 404s', async () => {
  const ok = await fetch(BASE + '/api/recap/aaaa1111', { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).recap, 'FAKE RECAP');
  const missing = await fetch(BASE + '/api/recap/nope', { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('groups: empty by default, PUT persists, invalid payload 400s', async () => {
  assert.deepEqual(await (await fetch(BASE + '/api/groups')).json(), {});
  const put = await fetch(BASE + '/api/groups', {
    method: 'PUT',
    body: JSON.stringify({ Work: ['/Users/someone/development/personal/Widget'] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await fetch(BASE + '/api/groups')).json(),
    { Work: ['/Users/someone/development/personal/Widget'] });
  const bad = await fetch(BASE + '/api/groups', { method: 'PUT', body: '{"Work":"nope"}' });
  assert.equal(bad.status, 400);
  const garbage = await fetch(BASE + '/api/groups', { method: 'PUT', body: 'not json' });
  assert.equal(garbage.status, 400);
});

test('GET /api/events is an SSE stream that sends the session list', async () => {
  const res = await fetch(BASE + '/api/events');
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  // Trigger a broadcast by touching the watched dir is racy on CI; instead the
  // server sends the current list on connect — read until a data: frame arrives.
  let buf = '';
  const deadline = Date.now() + 5000;
  while (!buf.includes('data: ') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  reader.cancel();
  assert.ok(buf.includes('data: '), 'expected an SSE data frame');
  assert.ok(buf.includes('aaaa1111'));
});

test('a new session file triggers an SSE broadcast with the new session', async () => {
  const res = await fetch(BASE + '/api/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Drain the on-connect snapshot first so the next frame is a real broadcast.
  while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value);
  await fsp.copyFile(path.join(fixtures, 'untitled.jsonl'), path.join(proj, 'bbbb2222.jsonl'));
  // watch → 500 ms debounce → refresh → broadcast
  const deadline = Date.now() + 10000;
  while (!buf.includes('bbbb2222') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  reader.cancel();
  assert.ok(buf.includes('bbbb2222'), 'expected a broadcast frame containing the new session id');
});

// fetch() refuses to forge Host/Origin, so use a raw request for the guard tests.
function rawRequest({ method = 'GET', path: reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: reqPath, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a foreign Host header is rejected (DNS rebinding guard)', async () => {
  assert.equal(await rawRequest({ path: '/api/sessions', headers: { host: 'evil.example' } }), 403);
});

test('writes with a foreign Origin are rejected, same-origin allowed', async () => {
  const sameHost = { host: `127.0.0.1:${PORT}` };
  assert.equal(await rawRequest({
    method: 'POST', path: '/api/recap/aaaa1111',
    headers: { ...sameHost, origin: 'https://evil.example' },
  }), 403);
  assert.equal(await rawRequest({
    method: 'PUT', path: '/api/groups',
    headers: { ...sameHost, origin: `http://127.0.0.1:${PORT}` },
    body: '{}',
  }), 200);
});

test('POST /api/shutdown stops the server', async () => {
  const res = await fetch(BASE + '/api/shutdown', { method: 'POST' });
  assert.equal(res.status, 200);
  // The server force-exits 500 ms after responding even if connections linger.
  await new Promise(r => setTimeout(r, 800));
  await assert.rejects(() => fetch(BASE + '/api/health'));
});
