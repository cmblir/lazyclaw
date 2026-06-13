// f-sandbox-application — a configured sandbox must reach bash tool exec.
//
// Pre-fix: mas/tools/bash.mjs always bare-spawned `sh -c <cmd>` and ignored
// any sandbox spec, so a --sandbox docker:... run executed the agent's shell
// command on the HOST. These tests pin that the spec threads down:
//   (a) ctx.sandbox=null  → bare path, real `echo hi` returns stdout (unchanged)
//   (b) ctx.sandbox=<spec> → routed through spawnSandboxed, NOT bare-spawned
//   (c) runTool forwards ctx.sandbox into the tool exec ctx

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as bash from '../mas/tools/bash.mjs';
import { runTool } from '../mas/tool_runner.mjs';
import * as registry from '../mas/tools/registry.mjs';

// Build a fake child process that the bash streaming/close logic can drive.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('(a) bash.exec with ctx.sandbox=null runs the bare path (real echo hi)', async () => {
  const r = await bash.exec({ command: 'echo hi' }, { sandbox: null });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), 'hi');
  assert.equal(r.exitCode, 0);
});

test('(b) bash.exec with a ctx.sandbox spec routes through spawnSandboxed', async () => {
  const calls = [];
  const spec = { kind: 'docker', image: 'alpine:3.20', network: 'none', mounts: [], envPassthrough: [] };
  const child = fakeChild();
  // Injected sandbox spawner stands in for sandbox.mjs spawnSandboxed.
  const spawnSandboxed = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('sandboxed-out'));
      child.emit('close', 0);
    });
    return child;
  };
  const r = await bash.exec(
    { command: 'echo hi' },
    { cwd: '/work', sandbox: spec, _spawnSandboxed: spawnSandboxed }
  );
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'sandboxed-out');
  assert.equal(calls.length, 1, 'spawnSandboxed must be called exactly once');
  assert.equal(calls[0].s, spec, 'the parsed spec must be passed through');
  assert.equal(calls[0].bin, 'sh');
  assert.deepEqual(calls[0].args, ['-c', 'echo hi']);
  assert.equal(calls[0].opts.cwd, '/work');
  // scrubbed env must still be applied inside the sandbox
  assert.equal(typeof calls[0].opts.env, 'object');
});

test('(c) runTool threads ctx.sandbox down into the tool exec ctx', async () => {
  const spec = { kind: 'docker', image: 'alpine:3.20' };
  let seenCtx = null;
  // Register a non-sensitive probe tool that captures the ctx runTool builds.
  registry.register({
    name: 'probe_sandbox_ctx',
    category: 'exec',
    sensitive: false,
    description: 'test probe',
    parameters: { type: 'object', properties: {} },
    exec: async (_args, ctx) => { seenCtx = ctx; return { ok: true }; },
  });
  try {
    const agent = { name: 'a', tools: ['probe_sandbox_ctx'] };
    const r = await runTool({ agent, tool: 'probe_sandbox_ctx', args: {}, sandbox: spec });
    assert.equal(r.ok, true);
    assert.ok(seenCtx, 'exec must have been called');
    assert.equal(seenCtx.sandbox, spec, 'runTool must forward `sandbox` onto the exec ctx');
  } finally {
    registry.unregister('probe_sandbox_ctx');
  }
});

test('(c2) runTool default ctx.sandbox is undefined (byte-stable when omitted)', async () => {
  let seenCtx = null;
  registry.register({
    name: 'probe_sandbox_default',
    category: 'exec',
    sensitive: false,
    description: 'test probe',
    parameters: { type: 'object', properties: {} },
    exec: async (_args, ctx) => { seenCtx = ctx; return { ok: true }; },
  });
  try {
    const agent = { name: 'a', tools: ['probe_sandbox_default'] };
    await runTool({ agent, tool: 'probe_sandbox_default', args: {} });
    assert.ok(seenCtx);
    // null/undefined both mean "no sandbox" → bare path. Pin it is falsy.
    assert.ok(!seenCtx.sandbox, 'omitting sandbox must leave it falsy (current behavior)');
  } finally {
    registry.unregister('probe_sandbox_default');
  }
});
