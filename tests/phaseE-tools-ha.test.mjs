import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ha from '../mas/tools/ha.mjs';

test('exports 2 ha tools', () => {
  const names = ha.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['ha_call_service', 'ha_get_state']);
});

test('all return "v5.1" deferred error', async () => {
  for (const t of ha.TOOLS) {
    const r = await t.exec({});
    assert.equal(r.ok, false);
    assert.match(r.error, /v5\.1|deferred/i);
  }
});
