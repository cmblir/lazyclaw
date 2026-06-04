import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sched from '../mas/tools/scheduling.mjs';

test('exports 3 scheduling tools', () => {
  const names = sched.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['cron_add', 'cron_list', 'cron_remove']);
});

test('cron_add rejects bad spec', async () => {
  const t = sched.TOOLS.find(t => t.name === 'cron_add');
  const r = await t.exec({ name: 'x', spec: 'banana', command: 'echo hi' });
  assert.equal(r.ok, false);
});

test('cron_add accepts valid spec, returns marker', async () => {
  sched.__setCronBackend({
    add: async (j) => ({ ok: true, id: `lz:${j.name}` }),
    list: async () => [{ name: 'x', spec: '0 9 * * *' }],
    remove: async (n) => ({ ok: true, removed: n }),
  });
  const t = sched.TOOLS.find(t => t.name === 'cron_add');
  const r = await t.exec({ name: 'morning', spec: '0 9 * * *', command: 'echo hi' });
  assert.equal(r.ok, true);
  sched.__setCronBackend(null);
});

test('all sensitive=true', () => {
  for (const t of sched.TOOLS) assert.equal(t.sensitive, true);
});
