import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as del from '../mas/tools/delegation.mjs';

test('exports 3 delegation tools', () => {
  const names = del.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['delegate', 'spawn_subagent', 'task_spawn']);
});

test('task_spawn requires agent + prompt', async () => {
  const t = del.TOOLS.find(t => t.name === 'task_spawn');
  const r = await t.exec({});
  assert.equal(r.ok, false);
});

test('delegate routes through injected dispatcher', async () => {
  const calls = [];
  del.__setDispatcher(async (job) => { calls.push(job); return { ok: true, output: 'done' }; });
  const t = del.TOOLS.find(t => t.name === 'delegate');
  const r = await t.exec({ worker: 'codex-cli', prompt: 'do x' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].worker, 'codex-cli');
  del.__setDispatcher(null);
});

test('both sensitive=true', () => {
  for (const t of del.TOOLS) assert.equal(t.sensitive, true);
});
