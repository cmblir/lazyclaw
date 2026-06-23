import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isNativeAbiError, _warnIndexFailure, _resetNativeHint } from '../mas/index_db.mjs';

// The exact message better-sqlite3 raises when node_modules was built against a
// different Node.js ABI than the one running lazyclaw (the user's report).
const abiErr = new Error(
  "The module '/Users/o/prj/lazyclaw/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  'was compiled against a different Node.js version using\n' +
  'NODE_MODULE_VERSION 141. This version of Node.js requires\nNODE_MODULE_VERSION 137.');

test('_isNativeAbiError matches the ABI / native-binding messages, not ordinary db errors', () => {
  assert.equal(_isNativeAbiError(abiErr), true);
  assert.equal(_isNativeAbiError(new Error('database is locked')), false);
  assert.equal(_isNativeAbiError(new Error('SQLITE_CORRUPT: database disk image is malformed')), false);
});

test('_warnIndexFailure prints the rebuild hint ONCE for repeated ABI errors (no per-op spam)', () => {
  _resetNativeHint();
  const seen = [];
  const orig = console.warn; console.warn = (...a) => seen.push(a.join(' '));
  try {
    _warnIndexFailure('indexTrajectory failed', abiErr);
    _warnIndexFailure('indexSkill failed', abiErr);
    _warnIndexFailure('indexMemory failed', abiErr);
  } finally { console.warn = orig; }
  assert.equal(seen.length, 1, 'the ABI error warns exactly once, not on every index op');
  assert.match(seen[0], /npm rebuild better-sqlite3/);
});

test('_warnIndexFailure still warns per-op for ordinary (non-native) errors', () => {
  _resetNativeHint();
  const seen = [];
  const orig = console.warn; console.warn = (...a) => seen.push(a.join(' '));
  try {
    _warnIndexFailure('indexSkill failed', new Error('database is locked'));
    _warnIndexFailure('indexSkill failed', new Error('database is locked'));
  } finally { console.warn = orig; }
  assert.equal(seen.length, 2, 'ordinary errors keep their per-op warning');
  assert.match(seen[0], /indexSkill failed/);
});
