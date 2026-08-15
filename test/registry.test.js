import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLiveSessions, mergeLive, defaultIsPidAlive, normalizeProject } from '../lib/registry.js';

test('readLiveSessions: keeps only alive PIDs, skips malformed files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-reg-'));
  await fsp.writeFile(path.join(dir, '100.json'),
    JSON.stringify({ pid: 100, sessionId: 's-alive', cwd: '/p/a', name: 'Alive one', status: 'busy' }));
  await fsp.writeFile(path.join(dir, '200.json'),
    JSON.stringify({ pid: 200, sessionId: 's-dead', cwd: '/p/b', name: 'Dead one', status: 'idle' }));
  await fsp.writeFile(path.join(dir, 'garbage.json'), 'not json');
  const live = await readLiveSessions(dir, pid => pid === 100);
  assert.equal(live.length, 1);
  assert.equal(live[0].sessionId, 's-alive');
});

test('readLiveSessions: missing dir yields empty list', async () => {
  assert.deepEqual(await readLiveSessions('/nonexistent/nowhere'), []);
});

test('mergeLive: statuses, name resolution order, sorting, registry-only sessions', () => {
  const sessions = [
    { sessionId: 'a', customTitle: 'Custom A', firstPrompt: 'prompt a', cwd: '/p/a', project: '/p/a', lastActivity: 300 },
    { sessionId: 'b', customTitle: null, firstPrompt: 'prompt b', cwd: '/p/b', project: '/p/b', lastActivity: 100 },
    { sessionId: 'c', customTitle: null, firstPrompt: 'prompt c', cwd: '/p/c', project: '/p/c', lastActivity: 200 },
  ];
  const live = [
    { pid: 1, sessionId: 'a', name: 'Live A', status: 'busy', cwd: '/p/a' },
    { pid: 2, sessionId: 'b', name: 'Live B', status: 'idle', cwd: '/p/b' },
    { pid: 3, sessionId: 'fresh', name: 'Brand new', status: 'busy', cwd: '/p/new', startedAt: 400, updatedAt: 450 },
  ];
  const rows = mergeLive(sessions, live);
  const byId = Object.fromEntries(rows.map(r => [r.sessionId, r]));
  assert.equal(byId.a.status, 'busy');
  assert.equal(byId.a.name, 'Custom A');        // customTitle beats live name
  assert.equal(byId.b.status, 'idle');
  assert.equal(byId.b.name, 'Live B');          // live name beats firstPrompt
  assert.equal(byId.c.status, 'ended');
  assert.equal(byId.c.name, 'prompt c');        // firstPrompt fallback
  assert.equal(byId.fresh.status, 'busy');      // registry-only session included
  assert.equal(byId.fresh.project, '/p/new');
  assert.deepEqual(rows.map(r => r.sessionId), ['fresh', 'a', 'c', 'b']); // lastActivity desc
});

test('mergeLive: nameless session gets <no name>, temp-dir projects get <headless-temp>', () => {
  const sessions = [
    { sessionId: 'deadbeef-1234', customTitle: null, firstPrompt: null, cwd: null,
      project: '/private/var/folders/0s/2t1dl6t972b1t7hfrwwtnx7h0000gn/T', lastActivity: 100 },
    { sessionId: 'e', customTitle: null, firstPrompt: 'prompt e', cwd: '/', project: '/', lastActivity: 200 },
  ];
  const rows = mergeLive(sessions, []);
  const byId = Object.fromEntries(rows.map(r => [r.sessionId, r]));
  assert.equal(byId['deadbeef-1234'].name, '<no name>');
  assert.equal(byId['deadbeef-1234'].project, '<headless-temp>');
  assert.equal(byId.e.project, '<headless-temp>');
});

test('normalizeProject: temp and root collapse, real paths untouched', () => {
  assert.equal(normalizeProject('/var/folders/ab/xyz/T'), '<headless-temp>');
  assert.equal(normalizeProject('/private/var/folders/ab/xyz/T/'), '<headless-temp>');
  assert.equal(normalizeProject('/'), '<headless-temp>');
  assert.equal(normalizeProject('/Users/someone/development/Timelines'), '/Users/someone/development/Timelines');
  assert.equal(normalizeProject(null), null);
});

test('defaultIsPidAlive: own pid alive, absurd pid dead', () => {
  assert.equal(defaultIsPidAlive(process.pid), true);
  assert.equal(defaultIsPidAlive(2 ** 22 - 5), false); // beyond real pid range
});
