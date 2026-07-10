// f-phase0-sandbox-scrubenv.test.mjs — every SandboxSession child spawn must
// route its composed env through scrubEnv, so secret-bearing keys are never
// shipped to a remote host / container by default.
//
// The bash tool already pre-scrubs before spawnSandboxed; the session tree
// (local/docker/ssh/singularity/modal/daytona) previously passed
// {...process.env, ...opts.env} UNSCRUBBED. The fix routes every
// env-composition site through the shared composeSessionEnv() helper, which
// wraps scrubEnv. These tests assert:
//   (1) the shared helper drops secret-bearing keys from both parent env and
//       caller-supplied opts.env, while keeping operational vars, and
//   (2) a real local session exec ships a scrubbed env to its child.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scrubEnv, isSecretKey } from '../mas/scrub_env.mjs';
import { composeSessionEnv } from '../sandbox/base.mjs';
import { LocalSandbox } from '../sandbox/local.mjs';

const SECRET = 'ANTHROPIC_API_KEY';

// Sanity: the key we probe with is one scrubEnv actually targets, so a passing
// test means the fix works — not that the probe key is simply absent.
test('probe key is a key scrubEnv drops', () => {
  assert.equal(isSecretKey(SECRET), true);
});

test('composeSessionEnv drops parent-env secrets, keeps operational vars', () => {
  const env = composeSessionEnv(
    { [SECRET]: 'sk-leak', PATH: '/usr/bin', HOME: '/home/x' },
    {},
  );
  assert.equal(SECRET in env, false);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
});

test('composeSessionEnv scrubs caller opts.env secrets too', () => {
  const env = composeSessionEnv(
    { PATH: '/usr/bin' },
    { env: { MY_TOKEN: 'sk-leak', SAFE_FLAG: '1' } },
  );
  assert.equal('MY_TOKEN' in env, false, 'secret-shaped opts.env key must be dropped');
  assert.equal(env.SAFE_FLAG, '1');
  assert.equal(env.PATH, '/usr/bin');
});

test('composeSessionEnv lets opts.env override a non-secret parent var', () => {
  const env = composeSessionEnv(
    { FOO: 'parent' },
    { env: { FOO: 'child' } },
  );
  assert.equal(env.FOO, 'child');
});

// A real spawn: the local session actually runs the argv. We ask the child to
// print its own environment and assert the secret is absent from it.
test('local session exec ships a scrubbed env to the child', async () => {
  const prev = process.env[SECRET];
  process.env[SECRET] = 'sk-should-not-leak';
  try {
    const session = await new LocalSandbox({ kind: 'local', confiner: 'none' }).open();
    // `env` with no args prints the child environment, one VAR=value per line.
    const r = await session.exec(['env'], {});
    await session.close();
    assert.equal(r.code, 0, `env exited ${r.code}: ${r.stderr}`);
    const names = r.stdout.split('\n').map((l) => l.split('=')[0]);
    assert.equal(names.includes(SECRET), false, `${SECRET} leaked to child env`);
    assert.equal(names.includes('PATH'), true, 'PATH must still pass through');
  } finally {
    if (prev === undefined) delete process.env[SECRET];
    else process.env[SECRET] = prev;
  }
});
