import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadGroups, saveGroups, isValidGroups } from '../lib/groups.js';

test('isValidGroups: accepts name->paths maps, rejects everything else', () => {
  assert.equal(isValidGroups({}), true);
  assert.equal(isValidGroups({ Work: ['/a', '/b'], Personal: [] }), true);
  assert.equal(isValidGroups(null), false);
  assert.equal(isValidGroups([]), false);
  assert.equal(isValidGroups({ Work: 'not-an-array' }), false);
  assert.equal(isValidGroups({ Work: [1, 2] }), false);
  assert.equal(isValidGroups({ '  ': ['/a'] }), false);
});

test('groups round-trip through disk; missing or corrupt file yields {}', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cst-groups-'));
  const fp = path.join(dir, 'groups.json');
  assert.deepEqual(await loadGroups(fp), {});
  await saveGroups(fp, { Work: ['/p/a'], Personal: ['/p/b', '/p/c'] });
  assert.deepEqual(await loadGroups(fp), { Work: ['/p/a'], Personal: ['/p/b', '/p/c'] });
  await fsp.writeFile(fp, 'not json');
  assert.deepEqual(await loadGroups(fp), {});
  await assert.rejects(() => saveGroups(fp, { Bad: 'shape' }), /invalid groups/);
});
