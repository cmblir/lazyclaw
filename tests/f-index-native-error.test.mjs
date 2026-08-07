import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isNativeAbiError, _warnIndexFailure, _resetNativeHint } from '../mas/index_db.mjs';

// The exact message better-sqlite3 raises when node_modules was built against a
// different Node.js ABI than the one running pompos (the user's report).
const abiErr = new Error(
  "The module '/Users/o/prj/pompos/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  'was compiled against a different Node.js version using\n' +
  'NODE_MODULE_VERSION 141. This version of Node.js requires\nNODE_MODULE_VERSION 137.');

test('_isNativeAbiError matches the ABI / native-binding messages, not ordinary db errors', () => {
  assert.equal(_isNativeAbiError(abiErr), true);
  assert.equal(_isNativeAbiError(new Error('database is locked')), false);
  assert.equal(_isNativeAbiError(new Error('SQLITE_CORRUPT: database disk image is malformed')), false);
});

// Capture console.warn while running fn, with LAZYCLAW_DEBUG forced to `dbg`.
function capWarn(dbg, fn) {
  _resetNativeHint();
  const prevDbg = process.env.LAZYCLAW_DEBUG;
  if (dbg) process.env.LAZYCLAW_DEBUG = '1'; else delete process.env.LAZYCLAW_DEBUG;
  const seen = [];
  const orig = console.warn; console.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally {
    console.warn = orig;
    if (prevDbg === undefined) delete process.env.LAZYCLAW_DEBUG; else process.env.LAZYCLAW_DEBUG = prevDbg;
  }
  return seen;
}

test('_warnIndexFailure stays SILENT for the user (no LAZYCLAW_DEBUG) — internals never hit the screen', () => {
  const seen = capWarn(false, () => {
    _warnIndexFailure('indexTrajectory failed', abiErr);
    _warnIndexFailure('indexSkill failed', new Error('database is locked'));
  });
  assert.equal(seen.length, 0, 'index errors are logged to disk + doctor, not printed to users');
});

test('_warnIndexFailure prints the rebuild hint ONCE under LAZYCLAW_DEBUG (no per-op spam)', () => {
  const seen = capWarn(true, () => {
    _warnIndexFailure('indexTrajectory failed', abiErr);
    _warnIndexFailure('indexSkill failed', abiErr);
    _warnIndexFailure('indexMemory failed', abiErr);
  });
  assert.equal(seen.length, 1, 'the ABI error warns exactly once, not on every index op');
  assert.match(seen[0], /npm rebuild better-sqlite3/);
});

test('_warnIndexFailure warns per-op for ordinary errors under LAZYCLAW_DEBUG', () => {
  const seen = capWarn(true, () => {
    _warnIndexFailure('indexSkill failed', new Error('database is locked'));
    _warnIndexFailure('indexSkill failed', new Error('database is locked'));
  });
  assert.equal(seen.length, 2, 'ordinary errors keep their per-op warning under debug');
  assert.match(seen[0], /indexSkill failed/);
});
