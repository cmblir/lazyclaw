import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSandbox } from '../sandbox/local.mjs';
import * as seatbelt from '../sandbox/confiners/seatbelt.mjs';
import * as bubblewrap from '../sandbox/confiners/bubblewrap.mjs';
import * as firejail from '../sandbox/confiners/firejail.mjs';
import * as landlock from '../sandbox/confiners/landlock.mjs';

test('confiner=none → no wrapping; argv passes through', async () => {
  const sb = new LocalSandbox({ kind: 'local', confiner: 'none' });
  const sess = await sb.open();
  const wrapped = sess._wrap(['echo', 'hi']);
  assert.deepEqual(wrapped, ['echo', 'hi']);
  await sess.close();
});

test('seatbelt confiner emits sandbox-exec with -p profile', () => {
  const out = seatbelt.buildArgv(['claude', '-p', 'x'], {
    readOnly: ['/etc'], readWrite: ['/Users/me/proj'], allowNet: false,
  });
  assert.equal(out[0], 'sandbox-exec');
  assert.equal(out[1], '-p');
  assert.match(out[2], /\(version 1\)/);
  assert.match(out[2], /\(deny default\)/);
  assert.match(out[2], /\(allow file-read\* \(subpath "\/etc"\)\)/);
  assert.match(out[2], /\(allow file-read\* file-write\* \(subpath "\/Users\/me\/proj"\)\)/);
  assert.deepEqual(out.slice(3), ['claude', '-p', 'x']);
});

test('bubblewrap confiner emits bwrap --bind / --ro-bind', () => {
  const out = bubblewrap.buildArgv(['claude'], {
    readOnly: ['/usr'], readWrite: ['/work'], allowNet: false,
  });
  assert.equal(out[0], 'bwrap');
  assert.ok(out.includes('--ro-bind'));
  assert.ok(out.includes('/usr'));
  assert.ok(out.includes('--bind'));
  assert.ok(out.includes('/work'));
  assert.ok(out.includes('--unshare-net'));
  assert.equal(out.at(-1), 'claude');
});

test('firejail confiner emits firejail --private --net=none', () => {
  const out = firejail.buildArgv(['claude'], { allowNet: false });
  assert.equal(out[0], 'firejail');
  assert.ok(out.includes('--net=none'));
  assert.ok(out.includes('--private'));
  assert.equal(out.at(-1), 'claude');
});

test('seatbelt.available() gates on platform and a real no-op probe (not -h)', () => {
  // Regression: the probe ran `sandbox-exec -h`, but -h is an illegal option on
  // macOS (non-zero exit), so available() threw → returned false on EVERY mac
  // and auto-confiner selection could never pick seatbelt. The probe must
  // exercise a real sandbox invocation. A probe seam lets us assert the
  // try/catch + platform gate without a real sandbox-exec on every host.
  assert.equal(seatbelt.available({ platform: 'darwin', probe: () => {} }), true);
  assert.equal(seatbelt.available({ platform: 'darwin', probe: () => { throw new Error('broken'); } }), false);
  assert.equal(seatbelt.available({ platform: 'linux', probe: () => {} }), false);
});

test('seatbelt.available() reports true on a real macOS host (catches the -h regression)', () => {
  // sandbox-exec is a core macOS binary; the fixed real probe must succeed.
  // Off darwin the confiner is legitimately unavailable.
  if (process.platform === 'darwin') {
    assert.equal(seatbelt.available(), true);
  } else {
    assert.equal(seatbelt.available(), false);
  }
});

test('landlock confiner is unavailable and refuses to build argv (no silent no-op)', () => {
  // It used to return the argv UNCHANGED, so selecting confiner:landlock ran
  // the command with zero confinement while reporting itself available — a
  // false security guarantee. It now fails closed: unavailable + throws.
  assert.equal(landlock.available(), false);
  assert.throws(() => landlock.buildArgv(['claude'], { readWrite: ['/work'] }), /not implemented|unconfined/i);
});

test('seatbelt escapes SBPL string metacharacters and rejects control chars (no profile injection)', () => {
  const out = seatbelt.buildArgv(['claude'], { readWrite: ['/tmp/x") (allow network*) ("'] });
  // The injected `")` must be escaped (\") rather than closing the subpath
  // string and re-enabling the network.
  assert.match(out[2], /\\"/);
  assert.doesNotMatch(out[2], /subpath "\/tmp\/x"\) \(allow network/);
  assert.throws(() => seatbelt.buildArgv(['claude'], { readWrite: ['/tmp/\nrc'] }), /control characters/i);
});

test('LocalSandbox dispatches by confiner key', async () => {
  const sb = new LocalSandbox({
    kind: 'local',
    confiner: 'firejail',
    readWrite: ['/work'],
    allowNet: false,
  });
  const sess = await sb.open();
  const wrapped = sess._wrap(['claude']);
  assert.equal(wrapped[0], 'firejail');
  await sess.close();
});

test('LocalSandbox throws on unknown confiner', () => {
  assert.throws(() => new LocalSandbox({ kind: 'local', confiner: 'doesnotexist' }),
    /unknown confiner/i);
});
