import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SshSandbox, buildSshArgv } from '../sandbox/ssh.mjs';

test('buildSshArgv injects ControlMaster reuse flags', () => {
  const argv = buildSshArgv(
    { host: 'box.local', user: 'me', identityFile: '/h/.ssh/id_ed25519' },
    ['claude', '-p', 'hi'],
  );
  assert.equal(argv[0], 'ssh');
  assert.ok(argv.includes('-o') && argv.includes('ControlMaster=auto'));
  const cmIdx = argv.indexOf('ControlPath=~/.ssh/cm-%h-%p-%r');
  assert.ok(cmIdx > 0);
  assert.ok(argv.includes('ControlPersist=10m'));
  assert.ok(argv.includes('-i'));
  assert.ok(argv.includes('/h/.ssh/id_ed25519'));
  assert.equal(argv.at(-2), 'me@box.local');
  assert.equal(argv.at(-1), 'claude -p hi');
});

test('SshSandbox describe() shows host', () => {
  const sb = new SshSandbox({ kind: 'ssh', host: 'box.local', user: 'me' });
  assert.match(sb.describe(), /ssh.*me@box\.local/);
});
