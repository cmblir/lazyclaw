// v5.2 — composePromptStack wired into runtime callers (canonical decision C5).
//
// Validates that the 8-layer stack actually reaches the provider:
//   - agent_turn.runAgentTurn with usePromptStack:true composes the stack
//     into the `system` argument passed to adapter.callOnce
//   - mention_router.buildTurnContext prepends the stack ahead of agent.role
//   - composePromptStack returns '' on a fresh install so legacy callers
//     stay byte-identical when no source files exist on disk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agentTurn from '../mas/agent_turn.mjs';
import { buildTurnContext } from '../mas/mention_router.mjs';

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pstack-wire-'));
}

// Build a minimal anthropic-shaped fakeFetch that records the body it
// receives and returns a final text reply on the first call.
function recordingFetch(observe) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    observe.push({ system: body.system, model: body.model });
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    };
  };
}

test('runAgentTurn with usePromptStack:true sends a system containing USER.md when it exists', async () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'USER_FACTS_FROM_DISK');

  const observe = [];
  await agentTurn.runAgentTurn({
    agent: { name: 'a', provider: 'anthropic', model: 'claude-opus-4-7', role: 'AGENT_ROLE_X', tools: [] },
    userMessage: 'hi',
    configDir: cfgDir,
    apiKey: 'k',
    fetchImpl: recordingFetch(observe),
    usePromptStack: true,
  });
  assert.equal(observe.length, 1);
  assert.ok(observe[0].system.includes('USER_FACTS_FROM_DISK'),
    `expected system to include USER_FACTS_FROM_DISK, got: ${observe[0].system.slice(0, 400)}`);
  assert.ok(observe[0].system.includes('AGENT_ROLE_X'),
    `expected system to retain agent.role, got: ${observe[0].system.slice(0, 400)}`);
});

test('runAgentTurn with usePromptStack:true includes the skill index when skills exist', async () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'demo-skill.md'),
    '---\nname: demo-skill\ndescription: a marker skill for the wiring test\n---\nbody\n',
  );

  const observe = [];
  await agentTurn.runAgentTurn({
    agent: { name: 'a', provider: 'anthropic', model: 'claude-opus-4-7', role: 'R', tools: [] },
    userMessage: 'hi',
    configDir: cfgDir,
    apiKey: 'k',
    fetchImpl: recordingFetch(observe),
    usePromptStack: true,
  });
  assert.ok(observe[0].system.includes('demo-skill'),
    `expected skill index to land in system, got: ${observe[0].system.slice(0, 400)}`);
});

test('runAgentTurn with usePromptStack:false (default) preserves byte-stable system=agent.role', async () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'SHOULD_NOT_LEAK');

  const observe = [];
  await agentTurn.runAgentTurn({
    agent: { name: 'a', provider: 'anthropic', model: 'claude-opus-4-7', role: 'BARE_ROLE', tools: [] },
    userMessage: 'hi',
    configDir: cfgDir,
    apiKey: 'k',
    fetchImpl: recordingFetch(observe),
    // usePromptStack omitted → default false
  });
  assert.equal(observe[0].system, 'BARE_ROLE',
    `default (usePromptStack:false) must keep agent.role as the system slot verbatim`);
});

test('mention_router.buildTurnContext prepends the personality layer when agentRecord.personality is set', () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'personalities', 'pirate.md'), 'YAR_PIRATE_PERSONA');

  const ctx = buildTurnContext({
    task: { id: 't1', title: 'do the thing', description: '', turns: [], workspace: '' },
    team: { name: 'team1', displayName: 'Team 1' },
    agent: 'alice',
    agentRecord: { name: 'alice', displayName: 'Alice', role: 'ALICE_ROLE', personality: 'pirate' },
    teammates: ['bob'],
    configDir: cfgDir,
  });
  assert.ok(ctx.system.includes('YAR_PIRATE_PERSONA'),
    `expected personality block in system, got: ${ctx.system.slice(0, 600)}`);
  assert.ok(ctx.system.includes('ALICE_ROLE'),
    `expected agent.role to remain in system, got: ${ctx.system.slice(0, 600)}`);
  // Personality must precede agent.role per spec §9.3 layer ordering.
  const persoIdx = ctx.system.indexOf('YAR_PIRATE_PERSONA');
  const roleIdx = ctx.system.indexOf('ALICE_ROLE');
  assert.ok(persoIdx >= 0 && roleIdx > persoIdx,
    'personality layer must precede agent.role per spec §9.3');
});

test('mention_router.buildTurnContext keeps agent.role exactly once on a fresh configDir (no duplication)', () => {
  const cfgDir = tmpCfg();
  const ctx = buildTurnContext({
    task: { id: 't1', title: 'do the thing', description: '', turns: [] },
    team: { name: 'team1', displayName: 'Team 1' },
    agent: 'alice',
    agentRecord: { name: 'alice', displayName: 'Alice', role: 'BARE_ROLE_UNIQUE_TOKEN' },
    teammates: [],
    configDir: cfgDir,
  });
  // With no stack source files, composePromptStack still emits a Role
  // layer because agent.role is non-empty. The router must NOT then
  // also append a bare second copy of role — agent.role should appear
  // exactly once in the system string.
  const occurrences = ctx.system.split('BARE_ROLE_UNIQUE_TOKEN').length - 1;
  assert.equal(occurrences, 1,
    `agent.role must appear exactly once in system, found ${occurrences}: ${ctx.system.slice(0, 400)}`);
});

test('mention_router.buildTurnContext includes USER.md when present', () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'WHAT_USER_TOLD_ME');
  const ctx = buildTurnContext({
    task: { id: 't1', title: 't', description: '', turns: [] },
    team: { name: 'team1', displayName: 'Team 1' },
    agent: 'alice',
    agentRecord: { name: 'alice', displayName: 'Alice', role: 'R' },
    teammates: [],
    configDir: cfgDir,
  });
  assert.ok(ctx.system.includes('WHAT_USER_TOLD_ME'),
    `expected USER.md content in system, got: ${ctx.system.slice(0, 400)}`);
});
