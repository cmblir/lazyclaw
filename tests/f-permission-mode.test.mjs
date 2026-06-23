import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolvePermissionMode, PERMISSION_MODES, parsePermissionChoice } from '../lib/permission_mode.mjs';
import { buildArgs } from '../providers/claude_cli.mjs';
import { getSession, _resetSessions } from '../providers/claude_cli_session.mjs';

function fakeChild() {
  const c = new EventEmitter();
  c.killed = false;
  c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
  c.stdin = { write: () => true, end: () => {} };
  c.kill = () => { c.killed = true; };
  return c;
}

test('PERMISSION_MODES lists the claude-cli choices', () => {
  for (const m of ['default', 'acceptEdits', 'bypassPermissions', 'plan']) assert.ok(PERMISSION_MODES.includes(m));
});

test('resolvePermissionMode: unset → bypassPermissions (lazyclaw is an autonomous-agent CLI)', () => {
  assert.equal(resolvePermissionMode(undefined), 'bypassPermissions');
  assert.equal(resolvePermissionMode({}), 'bypassPermissions');
  assert.equal(resolvePermissionMode({ chat: {} }), 'bypassPermissions');
});

test('resolvePermissionMode: honors a valid configured mode, rejects junk', () => {
  assert.equal(resolvePermissionMode({ chat: { permissionMode: 'default' } }), 'default');
  assert.equal(resolvePermissionMode({ chat: { permissionMode: 'acceptEdits' } }), 'acceptEdits');
  assert.equal(resolvePermissionMode({ chat: { permissionMode: 'plan' } }), 'plan');
  assert.equal(resolvePermissionMode({ chat: { permissionMode: 'nonsense' } }), 'bypassPermissions');
});

test('buildArgs passes --permission-mode when set, omits it when not', () => {
  const a = buildArgs('hi', { permissionMode: 'bypassPermissions' });
  const i = a.indexOf('--permission-mode');
  assert.ok(i >= 0 && a[i + 1] === 'bypassPermissions', 'flag + value present');
  assert.equal(buildArgs('hi', {}).includes('--permission-mode'), false, 'omitted when unset');
});

test('parsePermissionChoice maps wizard answers (Enter → bypass), null on junk', () => {
  assert.equal(parsePermissionChoice(''), 'bypassPermissions');
  assert.equal(parsePermissionChoice('bypass'), 'bypassPermissions');
  assert.equal(parsePermissionChoice('ask'), 'default');
  assert.equal(parsePermissionChoice('acceptEdits'), 'acceptEdits');
  assert.equal(parsePermissionChoice('PLAN'), 'plan');
  assert.equal(parsePermissionChoice('huh?'), null);
});

test('persistent session spawns claude with --permission-mode', () => {
  _resetSessions();
  let captured = null;
  const _spawn = (_bin, args) => { captured = args; return fakeChild(); };
  const s = getSession('perm', { _spawn, permissionMode: 'bypassPermissions' });
  const i = captured.indexOf('--permission-mode');
  assert.ok(i >= 0 && captured[i + 1] === 'bypassPermissions', 'session spawn carries the flag');
  s.close();
});
