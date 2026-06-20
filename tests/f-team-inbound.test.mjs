import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamForChannel, registerTeam } from '../teams.mjs';
import { registerAgent } from '../agents.mjs';
import { routeInboundToTeam } from '../daemon/lib/team_inbound.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-tinb-')); }

test('teamForChannel matches a team by its slackChannel (or null)', () => {
  const teams = [
    { name: 'alpha', slackChannel: 'C1' },
    { name: 'beta', slackChannel: 'C2' },
    { name: 'nochan', slackChannel: '' },
  ];
  assert.equal(teamForChannel(teams, 'C2').name, 'beta');
  assert.equal(teamForChannel(teams, 'C9'), null);
  assert.equal(teamForChannel(teams, ''), null);
});

test('routeInboundToTeam returns null when no team is bound to the channel', async () => {
  const d = tmp();
  const out = await routeInboundToTeam({ cfg: {}, channel: 'C-unbound', text: 'hi', configDir: d });
  assert.equal(out, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('routeInboundToTeam drives runTaskTurn for a channel-bound team and returns the last reply', async () => {
  const d = tmp();
  registerAgent({ name: 'planner', provider: 'claude-cli' }, d);
  registerAgent({ name: 'backend', provider: 'claude-cli', manager: 'planner' }, d);
  registerTeam({ name: 'prod', agents: ['planner', 'backend'], lead: 'planner', slackChannel: 'C-prod' }, d);

  let seen = null;
  const fakeRunTaskTurn = async (args) => {
    seen = args;
    return { task: { id: args.task.id, turns: [
      { agent: 'user', text: args.userMessage },
      { agent: 'planner', text: 'analysed the backlog' },
    ] }, iterations: 1, stoppedBy: 'done' };
  };

  const out = await routeInboundToTeam({
    cfg: {}, channel: 'C-prod', text: 'analyse the backlog', configDir: d,
    _runTaskTurn: fakeRunTaskTurn,
  });

  assert.ok(out, 'a channel-bound team must be routed');
  assert.equal(out.team, 'prod');
  assert.equal(out.reply, 'analysed the backlog');
  // runTaskTurn received the team, its loaded agents, and the inbound text
  assert.equal(seen.team.name, 'prod');
  assert.equal(seen.userMessage, 'analyse the backlog');
  assert.equal(seen.agentsById.planner.name, 'planner');
  assert.equal(seen.agentsById.backend.name, 'backend');
  // default-on confinement is threaded into the team run
  assert.ok(seen.sandbox, 'a sandbox spec is threaded into the team task');
  fs.rmSync(d, { recursive: true, force: true });
});
