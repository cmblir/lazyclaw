// f-os-sandbox — a configured sandbox spec must reach the os_* tools.
//
// CAPABILITY-ONLY: no caller threads ctx.sandbox yet, so absent-sandbox runs
// take the bare spawn/spawnSync path and remain byte-identical. These tests pin
// the injection seam (mirroring f-git-sandbox.test.mjs):
//   - ctx.sandbox=<spec> → routed through spawnSyncSandboxed / spawnSandboxed
//     (the injected seam), the SAME cmd+args+options the bare path used
//   - ctx without sandbox → bare path, the fake is NEVER invoked
//
// Tests are host-independent: routing is asserted via the injected fakes and
// ctx.platform override, so no real pbpaste / pbcopy / osascript is required.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TOOLS } from '../mas/tools/os.mjs';

const clipboard_read = TOOLS.find((t) => t.name === 'clipboard_read');
const clipboard_write = TOOLS.find((t) => t.name === 'clipboard_write');
const notify = TOOLS.find((t) => t.name === 'notify');
const file_dialog = TOOLS.find((t) => t.name === 'file_dialog');

test('clipboard_read routes pbpaste through the injected sync sandbox spawner', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    return { status: 0, stdout: 'hi', stderr: '' };
  };
  const r = await clipboard_read.exec(
    {},
    { platform: 'darwin', sandbox: spec, _spawnSyncSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hi');
  assert.equal(calls.length, 1, 'spawnSyncSandboxed must be called exactly once');
  assert.equal(calls[0].s, spec, 'the spec must be passed through by identity');
  assert.equal(calls[0].bin, 'pbpaste', 'bin must be pbpaste');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].opts.encoding, 'utf8', 'utf8 encoding must still be applied');
});

test('clipboard_read with NO sandbox takes the bare path (never calls the fake)', async () => {
  let called = false;
  const fake = () => { called = true; return { status: 0, stdout: '', stderr: '' }; };
  // No sandbox in ctx → must take the bare spawnSync branch. The real pbpaste
  // runs on darwin hosts; what we assert is only that the fake was NOT touched.
  await clipboard_read.exec(
    {},
    { platform: 'darwin', _spawnSyncSandboxed: fake }
  );
  assert.equal(called, false, 'absent sandbox must NOT route through spawnSyncSandboxed');
});

test('clipboard_write routes pbcopy through the injected async sandbox spawner', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const fakeAsync = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    // Resolve on the next tick with a clean close.
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const r = await clipboard_write.exec(
    { text: 'x' },
    { platform: 'darwin', sandbox: spec, _spawnSandboxed: fakeAsync }
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'spawnSandboxed must be called exactly once');
  assert.equal(calls[0].s, spec, 'the spec must be passed through by identity');
  assert.equal(calls[0].bin, 'pbcopy', 'bin must be pbcopy');
  assert.deepEqual(calls[0].args, []);
});

test('clipboard_write with NO sandbox never calls the async fake', async () => {
  let called = false;
  const fakeAsync = () => { called = true; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write() {}, end() {} }; setImmediate(() => c.emit('close', 0)); return c; };
  await clipboard_write.exec(
    { text: 'x' },
    { platform: 'darwin', _spawnSandboxed: fakeAsync }
  );
  assert.equal(called, false, 'absent sandbox must NOT route through spawnSandboxed');
});

test('notify routes osascript through the injected sync sandbox spawner', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = await notify.exec(
    { title: 'T', body: 'B' },
    { platform: 'darwin', sandbox: spec, _spawnSyncSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'notify must thread the seam exactly once');
  assert.equal(calls[0].s, spec, 'the spec must be passed through by identity');
  assert.equal(calls[0].bin, 'osascript');
});

test('file_dialog routes osascript through the injected sync sandbox spawner', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    return { status: 0, stdout: '/tmp/picked.txt\n', stderr: '' };
  };
  const r = await file_dialog.exec(
    { kind: 'open', prompt: 'Pick' },
    { platform: 'darwin', sandbox: spec, _spawnSyncSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(r.path, '/tmp/picked.txt');
  assert.equal(calls.length, 1, 'file_dialog must thread the seam exactly once');
  assert.equal(calls[0].s, spec, 'the spec must be passed through by identity');
  assert.equal(calls[0].bin, 'osascript');
});

test('notify with NO sandbox never calls the sync fake', async () => {
  // notify is best-effort and non-blocking even with a real osascript, but we
  // assert host-independently: absent sandbox must not touch the seam. Use a
  // win32 platform so no real binary is spawned at all and the test is fast.
  let called = false;
  const fake = () => { called = true; return { status: 0, stdout: '', stderr: '' }; };
  await notify.exec(
    { title: 'T' },
    { platform: 'win32', _spawnSyncSandboxed: fake }
  );
  assert.equal(called, false, 'absent sandbox must NOT route through spawnSyncSandboxed');
});
