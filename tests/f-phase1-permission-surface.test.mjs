// tests/f-phase1-permission-surface.test.mjs
//
// Phase 1c — default-provider security hardening.
//
// DEFECT: the claude-cli tool-use adapter hardcodes --permission-mode
// bypassPermissions, so on an UNATTENDED surface (daemon/gateway answering an
// inbound channel message from a possibly-untrusted sender) the spawned `claude`
// runs its ENTIRE tool loop (bash, writes, …) ungated — a message-to-RCE path.
// The fix is a surface-aware resolver that fail-closes unattended runs to the
// read-only "plan" mode unless the operator explicitly sets
// security.unattendedExec=true. Interactive use stays byte-stable (bypass).
//
// Proven here:
//   (a) surface "interactive" == resolvePermissionMode(cfg) exactly.
//   (b) surface "unattended" without the opt-in -> "plan" (fail-closed).
//   (c) surface "unattended" WITH cfg.security.unattendedExec=true -> the
//       configured/interactive mode (operator accepts host exec).
//   (d) runAgentTurn forwards opts.permissionMode into the spawned claude's
//       --permission-mode argument (end-to-end via a recording shim).
//   (e) mention_router.runTaskTurn with attended:false resolves the
//       fail-closed mode and forwards it into runAgentTurn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolvePermissionMode,
  resolvePermissionModeForSurface,
} from '../lib/permission_mode.mjs';
import { runAgentTurn } from '../mas/agent_turn.mjs';
import { runTaskTurn } from '../mas/mention_router.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

// Seed a task on disk so the router's tasksMod.appendTurn / patchTask
// (which read + rewrite the task file) find it — mirrors the seedTask helper
// in tests/f-phase1-control-protocol.test.mjs.
function seedTask(cfgDir, id, team, lead) {
  fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
  const task = {
    version: 1, id, title: 't', description: '', team, lead,
    status: 'running', slackChannel: '', slackThreadTs: '',
    createdAt: '', updatedAt: '', turns: [],
  };
  fs.writeFileSync(path.join(cfgDir, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

// (a) interactive surface delegates to resolvePermissionMode unchanged.
test('resolvePermissionModeForSurface("interactive") == resolvePermissionMode(cfg)', () => {
  for (const cfg of [
    undefined,
    {},
    { chat: {} },
    { chat: { permissionMode: 'default' } },
    { chat: { permissionMode: 'acceptEdits' } },
    { chat: { permissionMode: 'plan' } },
    { chat: { permissionMode: 'bypassPermissions' } },
    { chat: { permissionMode: 'junk' } },
  ]) {
    assert.equal(resolvePermissionModeForSurface(cfg, 'interactive'), resolvePermissionMode(cfg));
    // Omitted surface behaves like interactive.
    assert.equal(resolvePermissionModeForSurface(cfg), resolvePermissionMode(cfg));
  }
});

// (b) unattended without the opt-in fails closed to the read-only mode.
test('resolvePermissionModeForSurface("unattended") without unattendedExec -> "plan" (fail-closed, not bypass)', () => {
  assert.equal(resolvePermissionModeForSurface(undefined, 'unattended'), 'plan');
  assert.equal(resolvePermissionModeForSurface({}, 'unattended'), 'plan');
  assert.equal(resolvePermissionModeForSurface({ chat: { permissionMode: 'bypassPermissions' } }, 'unattended'), 'plan');
  assert.equal(resolvePermissionModeForSurface({ security: {} }, 'unattended'), 'plan');
  assert.equal(resolvePermissionModeForSurface({ security: { unattendedExec: false } }, 'unattended'), 'plan');
  // Must NOT be tripped by a truthy-but-not-true value.
  assert.equal(resolvePermissionModeForSurface({ security: { unattendedExec: 'yes' } }, 'unattended'), 'plan');
});

// (c) unattended WITH the explicit opt-in resolves the configured/interactive mode.
test('resolvePermissionModeForSurface("unattended") with unattendedExec=true -> configured/interactive mode', () => {
  assert.equal(
    resolvePermissionModeForSurface({ security: { unattendedExec: true } }, 'unattended'),
    'bypassPermissions', // unset chat -> interactive default
  );
  assert.equal(
    resolvePermissionModeForSurface({ security: { unattendedExec: true }, chat: { permissionMode: 'acceptEdits' } }, 'unattended'),
    'acceptEdits',
  );
  assert.equal(
    resolvePermissionModeForSurface({ security: { unattendedExec: true }, chat: { permissionMode: 'plan' } }, 'unattended'),
    'plan',
  );
});

// (d) runAgentTurn forwards opts.permissionMode into the spawned claude argv.
test('runAgentTurn forwards opts.permissionMode into the claude_cli --permission-mode argument', async () => {
  const FAKE = path.join(HERE, 'fixtures', 'fake-claude-record-argv.mjs');
  const argvOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-perm-')), 'argv.json');
  const prevBin = process.env.LAZYCLAW_CLAUDE_BIN;
  const prevOut = process.env.LAZYCLAW_ARGV_OUT;
  process.env.LAZYCLAW_CLAUDE_BIN = FAKE;
  process.env.LAZYCLAW_ARGV_OUT = argvOut;
  try {
    const cliAgent = { name: 'c', role: 'R', provider: 'claude-cli', model: 'sonnet', tools: [] };
    const r = await runAgentTurn({ agent: cliAgent, userMessage: 'hi', permissionMode: 'plan' });
    assert.equal(r.stoppedBy, 'final');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    const i = argv.indexOf('--permission-mode');
    assert.ok(i >= 0, '--permission-mode must be present in the spawned argv');
    assert.equal(argv[i + 1], 'plan', 'the forwarded mode must reach claude');
  } finally {
    if (prevBin === undefined) delete process.env.LAZYCLAW_CLAUDE_BIN; else process.env.LAZYCLAW_CLAUDE_BIN = prevBin;
    if (prevOut === undefined) delete process.env.LAZYCLAW_ARGV_OUT; else process.env.LAZYCLAW_ARGV_OUT = prevOut;
  }
});

// (d') the adapter fallback contract is preserved: no permissionMode opt still
// spawns with bypassPermissions (existing interactive/CLI callers unchanged).
test('runAgentTurn without a permissionMode opt keeps the bypassPermissions fallback', async () => {
  const FAKE = path.join(HERE, 'fixtures', 'fake-claude-record-argv.mjs');
  const argvOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-perm-')), 'argv.json');
  const prevBin = process.env.LAZYCLAW_CLAUDE_BIN;
  const prevOut = process.env.LAZYCLAW_ARGV_OUT;
  process.env.LAZYCLAW_CLAUDE_BIN = FAKE;
  process.env.LAZYCLAW_ARGV_OUT = argvOut;
  try {
    const cliAgent = { name: 'c', role: 'R', provider: 'claude-cli', model: 'sonnet', tools: [] };
    await runAgentTurn({ agent: cliAgent, userMessage: 'hi' });
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    const i = argv.indexOf('--permission-mode');
    assert.equal(argv[i + 1], 'bypassPermissions', 'default fallback must stay bypassPermissions');
  } finally {
    if (prevBin === undefined) delete process.env.LAZYCLAW_CLAUDE_BIN; else process.env.LAZYCLAW_CLAUDE_BIN = prevBin;
    if (prevOut === undefined) delete process.env.LAZYCLAW_ARGV_OUT; else process.env.LAZYCLAW_ARGV_OUT = prevOut;
  }
});

// (e) mention_router with attended:false resolves the fail-closed mode and
// threads it into runAgentTurn.
test('runTaskTurn attended:false resolves the fail-closed unattended mode and forwards it to runAgentTurn', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-router-'));
  const task = seedTask(cfgDir, 't_20260710_perm01', 'team', 'lead');
  const seen = [];
  const fakeRunAgentTurn = async (opts) => {
    seen.push(opts.permissionMode);
    return { text: 'done [[TASK_DONE]]', iterations: 1, stoppedBy: 'final', toolCalls: [] };
  };
  const agentRecord = { name: 'lead', displayName: 'Lead', provider: 'claude-cli', model: 'sonnet', role: 'R', tools: [] };
  const team = { name: 'team', displayName: 'Team', lead: 'lead', agents: ['lead'] };

  // No unattendedExec in cfg -> fail-closed "plan".
  await runTaskTurn({
    task, team, agentsById: { lead: agentRecord },
    userMessage: 'hi', configDir: cfgDir, cfg: {},
    attended: false,
    runAgentTurnImpl: fakeRunAgentTurn,
  });
  assert.ok(seen.length > 0, 'the fake turn runner must have been invoked');
  assert.equal(seen[0], 'plan', 'attended:false without unattendedExec must fail closed to plan');
});

// (e') attended (default) leaves permissionMode undefined -> today's behavior.
test('runTaskTurn attended default does NOT inject a permissionMode (byte-stable)', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-router-'));
  const task = seedTask(cfgDir, 't_20260710_perm02', 'team', 'lead');
  const seen = [];
  const fakeRunAgentTurn = async (opts) => {
    seen.push('permissionMode' in opts ? opts.permissionMode : '__ABSENT__');
    return { text: 'done [[TASK_DONE]]', iterations: 1, stoppedBy: 'final', toolCalls: [] };
  };
  const agentRecord = { name: 'lead', displayName: 'Lead', provider: 'claude-cli', model: 'sonnet', role: 'R', tools: [] };
  const team = { name: 'team', displayName: 'Team', lead: 'lead', agents: ['lead'] };

  await runTaskTurn({
    task, team, agentsById: { lead: agentRecord },
    userMessage: 'hi', configDir: cfgDir, cfg: {},
    // attended omitted -> defaults true
    runAgentTurnImpl: fakeRunAgentTurn,
  });
  // Byte-stable: the router must NOT inject a permissionMode key at all on an
  // attended run, so the claude-cli adapter keeps its own bypass default.
  assert.equal(seen[0], '__ABSENT__', 'attended default must not inject a permissionMode key (no flip)');
});
