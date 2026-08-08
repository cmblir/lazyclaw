import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerAgent, patchAgent, getAgent, AgentError } from '../agents.mjs';
import { teamTree } from '../teams.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-hier-')); }
const CLI = new URL('../cli.mjs', import.meta.url).pathname;

test('CLI: agent add --manager persists the manager (hierarchy from the command line)', () => {
  const d = tmp();
  const run = (args) => spawnSync('node', [CLI, ...args], { env: { ...process.env, POMPOS_CONFIG_DIR: d }, encoding: 'utf8' });
  assert.equal(run(['agent', 'add', 'boss', '--provider', 'claude-cli']).status, 0);
  const r = run(['agent', 'add', 'report', '--provider', 'claude-cli', '--manager', 'boss']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(getAgent('report', d).manager, 'boss', 'CLI --manager must reach registerAgent');
  fs.rmSync(d, { recursive: true, force: true });
});

test('registerAgent stores an optional manager (parent agent)', () => {
  const d = tmp();
  registerAgent({ name: 'planner', provider: 'claude-cli' }, d);
  const data = registerAgent({ name: 'backend', provider: 'claude-cli', manager: 'planner' }, d);
  assert.equal(data.manager, 'planner');
  assert.equal(getAgent('backend', d).manager, 'planner');
  fs.rmSync(d, { recursive: true, force: true });
});

test('manager defaults to empty (no hierarchy) and stays byte-stable for existing agents', () => {
  const d = tmp();
  const data = registerAgent({ name: 'solo' }, d);
  assert.equal(data.manager, '');
  fs.rmSync(d, { recursive: true, force: true });
});

test('registerAgent rejects an unknown manager', () => {
  const d = tmp();
  assert.throws(() => registerAgent({ name: 'x', manager: 'ghost' }, d), /unknown manager|no agent/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an agent cannot manage itself', () => {
  const d = tmp();
  registerAgent({ name: 'a' }, d);
  assert.throws(() => patchAgent('a', { manager: 'a' }, d), /itself|self/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('patchAgent rejects a manager cycle', () => {
  const d = tmp();
  registerAgent({ name: 'a' }, d);
  registerAgent({ name: 'b', manager: 'a' }, d);
  registerAgent({ name: 'c', manager: 'b' }, d);
  // a → b → c; making a report to c closes a cycle a→b→c→a
  assert.throws(() => patchAgent('a', { manager: 'c' }, d), /cycle/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('teamTree nests members under their manager, rooted at the lead', () => {
  const d = tmp();
  registerAgent({ name: 'planner', provider: 'claude-cli' }, d);
  registerAgent({ name: 'data', provider: 'gemini-cli', manager: 'planner' }, d);
  registerAgent({ name: 'backend', provider: 'claude-cli', manager: 'planner' }, d);
  const agentsById = {
    planner: getAgent('planner', d), data: getAgent('data', d), backend: getAgent('backend', d),
  };
  const team = { name: 't', lead: 'planner', agents: ['planner', 'data', 'backend'] };
  const tree = teamTree(team, agentsById);
  assert.equal(tree.agent.name, 'planner');
  const kids = tree.children.map((c) => c.agent.name).sort();
  assert.deepEqual(kids, ['backend', 'data']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('teamTree attaches a member with no (or external) manager directly under the lead', () => {
  const d = tmp();
  registerAgent({ name: 'lead' }, d);
  registerAgent({ name: 'free' }, d); // no manager
  const agentsById = { lead: getAgent('lead', d), free: getAgent('free', d) };
  const tree = teamTree({ name: 't', lead: 'lead', agents: ['lead', 'free'] }, agentsById);
  assert.deepEqual(tree.children.map((c) => c.agent.name), ['free']);
  fs.rmSync(d, { recursive: true, force: true });
});
