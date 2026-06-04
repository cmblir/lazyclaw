import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_KINDS, Sandbox, SandboxSession, SandboxError } from '../sandbox/base.mjs';

test('SANDBOX_KINDS is the canonical 6-enum from spec C8', () => {
  assert.deepEqual(
    [...SANDBOX_KINDS].sort(),
    ['daytona', 'docker', 'local', 'modal', 'singularity', 'ssh'],
  );
});

test('Sandbox is an abstract class — direct construction throws', () => {
  assert.throws(() => new Sandbox({ kind: 'local' }), /abstract/i);
});

test('Sandbox subclass must implement open() and exec()', async () => {
  class Half extends Sandbox {}
  const s = new Half({ kind: 'local' }, { _skipAbstract: true });
  await assert.rejects(() => s.open(), /not implemented/i);
});

test('SandboxSession enforces close() contract', async () => {
  class S extends SandboxSession {}
  const sess = new S();
  await assert.rejects(() => sess.exec(['true']), /not implemented/i);
  await assert.rejects(() => sess.close(), /not implemented/i);
});

test('SandboxError carries a stable code', () => {
  const e = new SandboxError('boom', 'SANDBOX_BAD_SPEC');
  assert.equal(e.name, 'SandboxError');
  assert.equal(e.code, 'SANDBOX_BAD_SPEC');
});
