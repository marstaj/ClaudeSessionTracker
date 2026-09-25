import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCodexSessionFile, buildCodexIndex, loadThreadNames, codexTurn } from '../lib/codex.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const codexDir = path.join(fixtures, 'codex');
const rollout = path.join(codexDir, 'sessions', '2026', '09', '01',
  'rollout-2026-09-01T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
const metaless = path.join(codexDir, 'sessions', '2026', '09', '01',
  'rollout-2026-09-01T11-00-00-11111111-2222-3333-4444-555555555555.jsonl');

test('parseCodexSessionFile: id/cwd/createdAt from session_meta, first real user prompt as name', async () => {
  const r = await parseCodexSessionFile(rollout);
  assert.equal(r.sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(r.source, 'codex');
  assert.equal(r.cwd, '/Users/someone/development/Widget');
  assert.equal(r.createdAt, Date.parse('2026-09-01T10:00:00.000Z'));
  // developer instructions, <environment_context>, injected AGENTS.md rules and
  // approval-review prompts are all harness noise, not the user's prompt.
  assert.equal(r.firstPrompt, 'add retry logic to the uploader');
  assert.equal(r.searchText, 'add retry logic to the uploader');
  assert.ok(r.lastActivity > 0 && r.size > 0);
});

test('parseCodexSessionFile: falls back to the uuid in the filename without session_meta', async () => {
  const r = await parseCodexSessionFile(metaless);
  assert.equal(r.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.cwd, null);
  assert.equal(r.firstPrompt, null);
  assert.ok(r.createdAt > 0); // file birthtime
});

test('codexTurn: keeps user/assistant text, drops developer, harness and non-message records', () => {
  const msg = (role, text, type = 'input_text') => ({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type, text }] },
  });
  assert.deepEqual(codexTurn(msg('user', 'hello')), { role: 'user', text: 'hello' });
  assert.deepEqual(codexTurn(msg('assistant', 'hi', 'output_text')), { role: 'assistant', text: 'hi' });
  assert.equal(codexTurn(msg('developer', 'internal')), null);
  assert.equal(codexTurn(msg('user', '<environment_context>x</environment_context>')), null);
  // Harness text Codex files under the user role — instructions and the
  // approval-review sub-agent's prompts — is not the user talking.
  assert.equal(codexTurn(msg('user', '# AGENTS.md instructions\n\nrules')), null);
  assert.equal(codexTurn(msg('user', 'The following is the Codex agent history added since…')), null);
  assert.equal(codexTurn(msg('user', '   ')), null);
  assert.equal(codexTurn({ type: 'token_usage_record', payload: { total: 1 } }), null);
  assert.equal(codexTurn({ type: 'response_item', payload: { type: 'reasoning' } }), null);
  assert.equal(codexTurn(null), null);
});

test('loadThreadNames: newest entry per id wins; malformed lines and missing file tolerated', async () => {
  const names = await loadThreadNames(path.join(codexDir, 'session_index.jsonl'));
  assert.equal(names.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'Uploader retries');
  assert.equal(names.get('unknown-session'), 'Not on disk');
  assert.equal((await loadThreadNames(path.join(codexDir, 'nope.jsonl'))).size, 0);
});

test('buildCodexIndex: walks the date tree, applies thread names, caches by mtime+size', async () => {
  const { sessions, cache } = await buildCodexIndex(codexDir, null);
  assert.equal(sessions.length, 2);
  const s = sessions.find(x => x.sessionId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(s.customTitle, 'Uploader retries'); // from session_index.jsonl
  assert.equal(s.project, '/Users/someone/development/Widget');
  assert.equal(s.source, 'codex');
  assert.equal(Object.keys(cache.files).length, 2);

  // A thread rename must show through even when the rollout is served from cache.
  const renamed = await buildCodexIndex(codexDir, cache);
  assert.equal(renamed.sessions.length, 2);
  assert.equal(renamed.sessions.find(x => x.sessionId === s.sessionId).customTitle, 'Uploader retries');

  // Missing codex dir is "no sessions", not an error.
  const absent = await buildCodexIndex(path.join(os.tmpdir(), 'cst-no-codex-here'), null);
  assert.deepEqual(absent.sessions, []);
});

test('buildCodexIndex: rollouts sharing a session id collapse into the newest', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-codex-resume-'));
  const day = path.join(dir, 'sessions', '2026', '09', '03');
  await fsp.mkdir(day, { recursive: true });
  const id = '77777777-6666-5555-4444-333333333333';
  const write = async (name, startedAt, prompt) => {
    const fp = path.join(day, name);
    await fsp.writeFile(fp, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: '/w', timestamp: startedAt } }),
      JSON.stringify({ type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
    ].join('\n') + '\n');
    return fp;
  };
  // Resuming writes a second rollout under the same id; the first one is older.
  const older = await write(`rollout-2026-09-03T09-00-00-${id}.jsonl`, '2026-09-03T09:00:00.000Z', 'the original prompt');
  await new Promise(r => setTimeout(r, 20));
  const newer = await write(`rollout-2026-09-03T10-00-00-${id}.jsonl`, '2026-09-03T10:00:00.000Z', 'picking this back up');

  const { sessions, cache } = await buildCodexIndex(dir, null);
  assert.equal(sessions.length, 1, 'one session, not one per rollout');
  const s = sessions[0];
  // Recaps must read the newest rollout, while the session still starts and
  // is named from the original one.
  assert.equal(s.filePath, newer);
  assert.equal(s.createdAt, Date.parse('2026-09-03T09:00:00.000Z'));
  assert.equal(s.firstPrompt, 'the original prompt');
  assert.equal(s.lastActivity, (await fsp.stat(newer)).mtimeMs);
  assert.equal(s.size, (await fsp.stat(older)).size + (await fsp.stat(newer)).size);
  // Both files stay cached, so neither is re-parsed on the next refresh.
  assert.equal(Object.keys(cache.files).length, 2);
});

test('buildCodexIndex: a rewritten rollout is re-parsed, not served stale', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-codex-'));
  const day = path.join(dir, 'sessions', '2026', '09', '02');
  await fsp.mkdir(day, { recursive: true });
  const fp = path.join(day, 'rollout-2026-09-02T09-00-00-99999999-8888-7777-6666-555555555555.jsonl');
  const line = text => JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }) + '\n';
  await fsp.writeFile(fp, line('first version of the prompt'));

  const first = await buildCodexIndex(dir, null);
  assert.equal(first.sessions[0].firstPrompt, 'first version of the prompt');

  await new Promise(r => setTimeout(r, 20)); // ensure the mtime changes
  await fsp.writeFile(fp, line('a totally different prompt now'));
  const second = await buildCodexIndex(dir, first.cache);
  assert.equal(second.sessions[0].firstPrompt, 'a totally different prompt now');
});
