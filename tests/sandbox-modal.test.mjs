import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModalSandbox, buildModalArgv, idleWakeUrl } from '../sandbox/modal.mjs';

test('buildModalArgv wraps argv in modal run --detach=false', () => {
  const argv = buildModalArgv(
    { app: 'lazyclaw-worker', region: 'us-east' },
    ['claude', '-p', 'x'],
  );
  assert.equal(argv[0], 'modal');
  assert.equal(argv[1], 'run');
  assert.ok(argv.includes('--detach=false'));
  assert.ok(argv.includes('lazyclaw-worker'));
  // The wrapped command is passed via -- separator.
  const sepIdx = argv.indexOf('--');
  assert.ok(sepIdx > 0);
  assert.deepEqual(argv.slice(sepIdx + 1), ['claude', '-p', 'x']);
});

test('idleWakeUrl encodes app + token for 30-min hibernation wake hook', () => {
  const url = idleWakeUrl({ app: 'lazyclaw-worker', token: 'tok123' });
  assert.match(url, /^https:\/\/.*modal\.run\/wake\?app=lazyclaw-worker&token=tok123$/);
});

test('ModalSandbox describe()', () => {
  const sb = new ModalSandbox({ kind: 'modal', app: 'a' });
  assert.match(sb.describe(), /modal.*app=a/);
});
