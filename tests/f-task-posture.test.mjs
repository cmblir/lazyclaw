// tests/f-task-posture.test.mjs — a channel-originated task runs read-only
// unless security.unattendedExec is set, and that was only ever visible in the
// daemon log. Surfacing it means putting the EFFECTIVE posture on the task,
// never the config values themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTask } from '../tasks.mjs';
import { registerTeam } from '../teams.mjs';
import { registerAgent } from '../agents.mjs';
import * as registry from '../daemon/routes/registry.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-posture-')); }
function mockRes() {
  return { code: 0, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
}

// registerTask() validates `team` against the team registry (and `lead`
// against that team's agents) — see tasks.mjs registerTask + teams.mjs
// validateAgentRefs. The brief's Step-1 test called registerTask() straight
// against a fresh tmp configDir with no "ship-it" team registered, which
// throws TASK_NO_TEAM before any assertion runs (confirmed by running the
// test as originally written). This helper mirrors the fixture pattern
// already used by tests/f-phase0-state-locks.test.mjs (registerAgent then
// registerTeam) so registerTask succeeds.
function seedTeam(dir) {
  registerAgent({ name: 'orchestrator', displayName: 'Orchestrator' }, dir);
  registerTeam({ name: 'ship-it', displayName: 'Ship It', agents: ['orchestrator'], lead: 'orchestrator' }, dir);
}

test('a channel-originated task reports attended:false and its read-only mode', async () => {
  const dir = tmp();
  seedTeam(dir);
  registerTask({ title: 'from slack', team: 'ship-it', lead: 'orchestrator',
    slackChannel: '#ship-it', slackThreadTs: '1785743812.004200' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({}) }, gwConfigDir: dir, res });
  assert.equal(res.code, 200);
  const [t] = JSON.parse(res.body);
  assert.equal(t.slackChannel, '#ship-it');
  assert.equal(t.slackThreadTs, '1785743812.004200');
  assert.equal(t.attended, false, 'an inbound surface has no human watching');
  assert.equal(typeof t.permissionMode, 'string');
  assert.ok(t.permissionMode.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Fix round 1: the original cut of withPosture computed
// `attended: !fromChannel || execEnabled`, so this test (as first written)
// asserted `t.attended === true` here — i.e. it claimed a human was watching
// an inbound Slack message purely because the operator had opted into
// unattended execution. That is exactly backwards: nobody was in the loop
// either way. security.unattendedExec changes what the task is ALLOWED to
// do (permissionMode), never whether a human was present (attended).
// resolvePermissionModeForSurface already resolves the effective mode for
// the opt-in case, so this asserts both fields the UI actually keys off.
test('security.unattendedExec=true changes the effective mode, not attended', async () => {
  const dir = tmp();
  seedTeam(dir);
  registerTask({ title: 'from slack', team: 'ship-it', lead: 'orchestrator',
    slackChannel: '#ship-it' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({ security: { unattendedExec: true } }) },
    gwConfigDir: dir, res });
  const [t] = JSON.parse(res.body);
  assert.equal(t.attended, false, 'still nobody was watching — opting in does not add a human');
  assert.equal(t.permissionMode, 'bypassPermissions', 'opting in changes what the task could do');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The other half of the same regression: an operator who opts into
// unattendedExec but leaves permissionMode at "plan" is STILL read-only —
// the effective mode, not the opt-in flag, is what must gate the UI's danger
// signal (permissionChip / isUnattendedWithExec in
// web/ui/panels/tasks.mjs).
test('unattendedExec=true with permissionMode "plan" still resolves to the safe read-only mode', async () => {
  const dir = tmp();
  seedTeam(dir);
  registerTask({ title: 'from slack', team: 'ship-it', lead: 'orchestrator',
    slackChannel: '#ship-it' }, dir);
  const res = mockRes();
  await registry.tasksList({
    ctx: { readConfig: () => ({ security: { unattendedExec: true }, chat: { permissionMode: 'plan' } }) },
    gwConfigDir: dir, res,
  });
  const [t] = JSON.parse(res.body);
  assert.equal(t.attended, false);
  assert.equal(t.permissionMode, 'plan', 'still read-only — opting in did not grant exec here');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CLI-started task has no channel and is treated as attended', async () => {
  const dir = tmp();
  seedTeam(dir);
  registerTask({ title: 'local', team: 'ship-it', lead: 'orchestrator' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({}) }, gwConfigDir: dir, res });
  const [t] = JSON.parse(res.body);
  assert.equal(t.slackChannel, '');
  assert.equal(t.attended, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the response never echoes the config flag itself', async () => {
  const dir = tmp();
  seedTeam(dir);
  registerTask({ title: 'x', team: 'ship-it', lead: 'orchestrator', slackChannel: '#x' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({ security: { unattendedExec: false } }) },
    gwConfigDir: dir, res });
  assert.doesNotMatch(String(res.body), /unattendedExec/,
    'expose the effective posture, not the configuration');
  fs.rmSync(dir, { recursive: true, force: true });
});
