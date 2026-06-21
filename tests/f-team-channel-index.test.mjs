// tests/f-team-channel-index.test.mjs
//
// Every inbound Slack message resolved its team via
// teamForChannel(listTeams(configDir), channel) — a full teams/ directory
// readdir + N readFileSync + N JSON.parse + sort + linear scan, on EVERY
// message. teamForChannelCached builds a slackChannel→team index once and
// reuses it until the teams/ dir changes (register/patch/remove all bust it),
// turning the per-inbound cost into an O(1) Map.get.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '../agents.mjs';
import { registerTeam, patchTeam, teamForChannelCached } from '../teams.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-tidx-'));

test('teamForChannelCached resolves the team bound to a channel', () => {
  const d = tmp();
  registerAgent({ name: 'lead', provider: 'claude-cli' }, d);
  registerTeam({ name: 'prod', agents: ['lead'], lead: 'lead', slackChannel: 'C-prod' }, d);
  assert.equal(teamForChannelCached('C-prod', d)?.name, 'prod');
  assert.equal(teamForChannelCached('C-nope', d), null);
  assert.equal(teamForChannelCached('', d), null);
});

test('the channel index is built once across repeated lookups', () => {
  const d = tmp();
  registerAgent({ name: 'lead', provider: 'claude-cli' }, d);
  registerTeam({ name: 'prod', agents: ['lead'], lead: 'lead', slackChannel: 'C-prod' }, d);
  const realReaddir = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (p, ...rest) => { if (String(p).endsWith('teams')) scans++; return realReaddir(p, ...rest); };
  try {
    teamForChannelCached('C-prod', d);
    teamForChannelCached('C-prod', d);
    teamForChannelCached('C-prod', d);
    assert.equal(scans, 1, 'teams/ dir must be scanned once, not per lookup');
  } finally {
    fs.readdirSync = realReaddir;
  }
});

test('registering a new team busts the index', () => {
  const d = tmp();
  registerAgent({ name: 'a', provider: 'claude-cli' }, d);
  registerTeam({ name: 'one', agents: ['a'], lead: 'a', slackChannel: 'C1' }, d);
  assert.equal(teamForChannelCached('C1', d)?.name, 'one');
  assert.equal(teamForChannelCached('C2', d), null);  // primes the cache with a miss
  registerAgent({ name: 'b', provider: 'claude-cli' }, d);
  registerTeam({ name: 'two', agents: ['b'], lead: 'b', slackChannel: 'C2' }, d);
  assert.equal(teamForChannelCached('C2', d)?.name, 'two', 'new team must be visible after register');
});

test('patching a team channel busts the index', () => {
  const d = tmp();
  registerAgent({ name: 'a', provider: 'claude-cli' }, d);
  registerTeam({ name: 'one', agents: ['a'], lead: 'a', slackChannel: 'C1' }, d);
  assert.equal(teamForChannelCached('C1', d)?.name, 'one');  // primes
  patchTeam('one', { slackChannel: 'C9' }, d);
  assert.equal(teamForChannelCached('C9', d)?.name, 'one', 'new channel must resolve');
  assert.equal(teamForChannelCached('C1', d), null, 'old channel must stop resolving');
});
