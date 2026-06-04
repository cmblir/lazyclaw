import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaSandbox, buildDaytonaArgv } from '../sandbox/daytona.mjs';

test('buildDaytonaArgv targets daytona ssh <workspace> -- <cmd>', () => {
  const argv = buildDaytonaArgv(
    { workspace: 'lazyclaw-w1', persistent: true },
    ['claude', '-p', 'x'],
  );
  assert.equal(argv[0], 'daytona');
  assert.equal(argv[1], 'ssh');
  assert.equal(argv[2], 'lazyclaw-w1');
  const sepIdx = argv.indexOf('--');
  assert.ok(sepIdx > 0);
  assert.deepEqual(argv.slice(sepIdx + 1), ['claude', '-p', 'x']);
});

test('non-persistent workspace appends --auto-stop=true', () => {
  const argv = buildDaytonaArgv(
    { workspace: 'tmp', persistent: false },
    ['true'],
  );
  assert.ok(argv.includes('--auto-stop=true'));
});

test('DaytonaSandbox describe()', () => {
  const sb = new DaytonaSandbox({ kind: 'daytona', workspace: 'w' });
  assert.match(sb.describe(), /daytona.*w/);
});
