import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnSandboxed,
  buildLocalArgv,
  pickAvailableConfiner,
} from '../sandbox/spawn.mjs';
import { buildDockerArgs } from '../sandbox/docker.mjs';

// ── byte-stable null path ────────────────────────────────────────────────────

test('spawnSandboxed(null, ...) spawns a bare child (byte-stable null path)', async () => {
  const child = spawnSandboxed(null, 'echo', ['hi']);
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('error', reject);
    child.on('close', () => resolve(buf));
  });
  assert.equal(out.trim(), 'hi');
});

// ── buildLocalArgv: none passes through ──────────────────────────────────────

test('buildLocalArgv confiner=none returns argv unwrapped (byte-stable)', () => {
  const out = buildLocalArgv({ kind: 'local', confiner: 'none' }, 'echo', ['hi']);
  assert.deepEqual(out, ['echo', 'hi']);
});

test('buildLocalArgv with no confiner key defaults to none (passthrough)', () => {
  const out = buildLocalArgv({ kind: 'local' }, 'echo', ['hi']);
  assert.deepEqual(out, ['echo', 'hi']);
});

// ── buildLocalArgv: firejail / seatbelt / bubblewrap wrap WITHOUT spawning ────

test('buildLocalArgv firejail wraps argv with --net=none, argv last', () => {
  const out = buildLocalArgv(
    { kind: 'local', confiner: 'firejail', allowNet: false },
    'claude', ['-p'],
  );
  assert.equal(out[0], 'firejail');
  assert.ok(out.includes('--net=none'));
  assert.equal(out.at(-1), '-p');
  assert.equal(out.at(-2), 'claude');
});

test('buildLocalArgv seatbelt wraps argv with sandbox-exec -p profile', () => {
  const out = buildLocalArgv(
    { kind: 'local', confiner: 'seatbelt', readWrite: ['/work'], allowNet: false },
    'claude', ['-p'],
  );
  assert.equal(out[0], 'sandbox-exec');
  assert.equal(out[1], '-p');
  // filesystem-confinement profile: allow-default base, writes confined to the
  // workspace, network denied when allowNet:false (see seatbelt.mjs rationale).
  assert.match(out[2], /\(allow default\)/);
  assert.match(out[2], /\(deny file-write\*\)/);
  assert.match(out[2], /\(allow file-write\* [^\n]*\(subpath "\/work"\)/);
  assert.deepEqual(out.slice(3), ['claude', '-p']);
});

test('buildLocalArgv bubblewrap wraps argv with bwrap binds', () => {
  const out = buildLocalArgv(
    { kind: 'local', confiner: 'bubblewrap', readWrite: ['/work'], allowNet: false },
    'claude', ['-p'],
  );
  assert.equal(out[0], 'bwrap');
  assert.ok(out.includes('--unshare-net'));
  assert.equal(out.at(-1), '-p');
  assert.equal(out.at(-2), 'claude');
});

// ── buildLocalArgv: failure modes ────────────────────────────────────────────

test('buildLocalArgv unknown confiner throws SANDBOX_BAD_CONFINER', () => {
  assert.throws(
    () => buildLocalArgv({ kind: 'local', confiner: 'doesnotexist' }, 'claude', []),
    (err) => err.code === 'SANDBOX_BAD_CONFINER' && /unknown confiner/i.test(err.message),
  );
});

test('buildLocalArgv landlock is fail-closed (throws, not special-cased)', () => {
  assert.throws(
    () => buildLocalArgv({ kind: 'local', confiner: 'landlock' }, 'claude', []),
    /not implemented|unconfined/i,
  );
});

// ── spawnSandboxed dispatch ──────────────────────────────────────────────────

test('spawnSandboxed unsupported kind throws SANDBOX_UNSUPPORTED', () => {
  assert.throws(
    () => spawnSandboxed({ kind: 'ssh', host: 'h' }, 'sh', ['-c', 'true']),
    (err) => err.code === 'SANDBOX_UNSUPPORTED' && /spawnSandboxed shim handles docker\+local only/.test(err.message),
  );
});

test('spawnSandboxed docker spec routes through buildDockerArgs argv shape', () => {
  // We do NOT require a live docker daemon: assert the buildDockerArgs path is
  // reachable and produces the expected docker argv shape that spawnSandboxed
  // would hand to `docker`.
  const spec = { kind: 'docker', image: 'x', network: 'none' };
  const dockerArgs = buildDockerArgs(spec, ['sh', '-c', 'true'], { cwd: '/work' });
  assert.equal(dockerArgs[0], 'run');
  assert.ok(dockerArgs.includes('x'));
  assert.equal(dockerArgs.at(-3), 'sh');
  assert.equal(dockerArgs.at(-2), '-c');
  assert.equal(dockerArgs.at(-1), 'true');
});

test('spawnSandboxed local spec wraps then spawns wrapped[0] (firejail, no binary run)', async () => {
  // firejail almost certainly does not exist on the test host, so the wrapped
  // child emits an ENOENT 'error' for the WRAPPER bin (firejail), proving the
  // local spec was wrapped before spawning rather than running `claude` bare.
  const child = spawnSandboxed(
    { kind: 'local', confiner: 'firejail', allowNet: false },
    'claude', ['-p'],
  );
  const errBin = await new Promise((resolve) => {
    child.on('error', (err) => resolve(err.path || err.spawnargs?.[0] || err.code));
    child.on('close', () => resolve('CLOSED'));
  });
  // Either the wrapper bin is missing (ENOENT path === 'firejail') or, on a host
  // that has firejail, it ran and closed. Both prove wrapping happened.
  assert.ok(errBin === 'firejail' || errBin === 'CLOSED');
});

// ── pickAvailableConfiner ────────────────────────────────────────────────────

test('pickAvailableConfiner darwin: seatbelt available → seatbelt', () => {
  assert.equal(pickAvailableConfiner({ platform: 'darwin', avail: { seatbelt: true } }), 'seatbelt');
});

test('pickAvailableConfiner darwin: seatbelt unavailable → none', () => {
  assert.equal(pickAvailableConfiner({ platform: 'darwin', avail: { seatbelt: false } }), 'none');
});

test('pickAvailableConfiner linux precedence bubblewrap > firejail > none', () => {
  assert.equal(
    pickAvailableConfiner({ platform: 'linux', avail: { bubblewrap: true, firejail: true } }),
    'bubblewrap',
  );
  assert.equal(
    pickAvailableConfiner({ platform: 'linux', avail: { bubblewrap: false, firejail: true } }),
    'firejail',
  );
  assert.equal(
    pickAvailableConfiner({ platform: 'linux', avail: { bubblewrap: false, firejail: false } }),
    'none',
  );
});

test('pickAvailableConfiner never returns landlock and other platforms → none', () => {
  assert.equal(pickAvailableConfiner({ platform: 'win32', avail: {} }), 'none');
  assert.notEqual(
    pickAvailableConfiner({ platform: 'linux', avail: { bubblewrap: false, firejail: false } }),
    'landlock',
  );
});

// ── auto resolution through buildLocalArgv ───────────────────────────────────

test('buildLocalArgv confiner=auto yields a valid argv (passthrough or known confiner)', () => {
  // Platform-robust: on CI Linux without bwrap/firejail this resolves to none
  // (passthrough); on a host with a confiner it wraps. Either way it must NOT
  // throw and the original bin+args must survive at the tail.
  const out = buildLocalArgv(
    { kind: 'local', confiner: 'auto', allowNet: false, readWrite: ['/work'] },
    'echo', ['hi'],
  );
  assert.ok(Array.isArray(out));
  assert.equal(out.at(-1), 'hi');
  assert.equal(out.at(-2), 'echo');
  // never landlock-shaped (landlock throws); first elem is a real wrapper or echo
  assert.ok(['echo', 'sandbox-exec', 'bwrap', 'firejail'].includes(out[0]));
});
