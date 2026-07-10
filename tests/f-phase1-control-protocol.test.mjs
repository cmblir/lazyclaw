// f-phase1-control-protocol — structured multi-agent control protocol.
//
// DEFECT: coordination was a fragile string protocol — a task ended only
// when the model emitted the literal "[[TASK_DONE]]" and handed off via an
// @mention regex. This suite proves the new first-class control tools
// (finish / handoff) drive termination + handoff, while the legacy marker
// path remains a working fallback (existing tests pin it).
//
// Coverage:
//   control.mjs   — finish/handoff return structured {ok, control, ...} results
//   toolsets.mjs  — the agentic (team) toolset exposes finish + handoff
//   registry.mjs  — both tools resolve by name
//   mention_router — (a) a `finish` tool-call ends a team turn (status done);
//                    (b) a `handoff` tool-call enqueues the named teammate;
//                    (c) the legacy [[TASK_DONE]] marker STILL terminates.
//   loops.mjs     — structured stop signal helper detects a finish tool-call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as control from '../mas/tools/control.mjs';
import * as registry from '../mas/tools/registry.mjs';
import { resolveToolset } from '../mas/toolsets.mjs';
import { runTaskTurn } from '../mas/mention_router.mjs';
import * as loops from '../loops.mjs';
import * as tasksMod from '../tasks.mjs';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function makeAgent(name, role) {
  return {
    version: 1, name, displayName: name, role,
    provider: 'anthropic', model: 'claude-opus-4-7',
    tools: ['finish', 'handoff'], tags: [], createdAt: '', updatedAt: '',
  };
}

function makeTeam(name, agents, lead) {
  return {
    version: 1, name, displayName: name, agents, lead,
    slackChannel: '', createdAt: '', updatedAt: '',
  };
}

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

// A fake runAgentTurn: returns queued { text, toolCalls } shapes in order,
// mirroring the real runAgentTurn return contract the router consumes.
function makeFakeRunner(queue) {
  let i = 0;
  return async () => {
    const next = queue[i++] || { text: '', toolCalls: [] };
    return { text: next.text || '', toolCalls: next.toolCalls || [], stoppedBy: 'final', usage: null };
  };
}

// ── control.mjs unit contract ────────────────────────────────────────────

test('finish tool returns a structured finish control result', async () => {
  const t = registry.lookup('finish');
  assert.ok(t, 'finish must be registered');
  assert.equal(t.sensitive, false, 'finish is non-sensitive (no approval gate)');
  const r = await t.exec({ summary: 'all shipped' });
  assert.deepEqual(r, { ok: true, control: 'finish', summary: 'all shipped' });
});

test('handoff tool returns a structured handoff control result', async () => {
  const t = registry.lookup('handoff');
  assert.ok(t, 'handoff must be registered');
  assert.equal(t.sensitive, false, 'handoff is non-sensitive');
  const r = await t.exec({ to: 'backend', brief: 'wire the API' });
  assert.deepEqual(r, { ok: true, control: 'handoff', to: 'backend', brief: 'wire the API' });
});

test('finish requires a summary; handoff requires a to', async () => {
  assert.equal((await control.TOOLS.find(x => x.name === 'finish').exec({})).ok, false);
  assert.equal((await control.TOOLS.find(x => x.name === 'handoff').exec({})).ok, false);
});

// ── toolset membership ────────────────────────────────────────────────────

test('agentic (team) toolset exposes finish + handoff', () => {
  const tools = resolveToolset('agentic');
  assert.ok(tools.includes('finish'), 'agentic toolset must include finish');
  assert.ok(tools.includes('handoff'), 'agentic toolset must include handoff');
});

// ── router: structured control is primary ─────────────────────────────────

test('(a) a finish tool-call terminates a team turn with status done', async () => {
  const cfg = tmpDir('ctrl-finish');
  const task = seedTask(cfg, 't_20260710_ctrf01', 'shop', 'planner');
  const r = await runTaskTurn({
    task,
    team: makeTeam('shop', ['planner', 'backend'], 'planner'),
    agentsById: { planner: makeAgent('planner', 'P'), backend: makeAgent('backend', 'B') },
    userMessage: 'go',
    configDir: cfg,
    apiKey: 'sk-test',
    // structured finish call — NO [[TASK_DONE]] marker in the text.
    runAgentTurnImpl: makeFakeRunner([
      { text: 'wrapping up', toolCalls: [{ name: 'finish', input: { summary: 'done' }, result: { ok: true, control: 'finish', summary: 'done' }, ok: true }] },
    ]),
  });
  assert.equal(r.stoppedBy, 'done');
  assert.equal(r.iterations, 1);
  assert.equal(r.task.status, 'done');
});

test('(b) a handoff tool-call enqueues the named teammate', async () => {
  const cfg = tmpDir('ctrl-handoff');
  const task = seedTask(cfg, 't_20260710_ctrh01', 'shop', 'planner');
  const r = await runTaskTurn({
    task,
    team: makeTeam('shop', ['planner', 'backend'], 'planner'),
    agentsById: { planner: makeAgent('planner', 'P'), backend: makeAgent('backend', 'B') },
    userMessage: 'go',
    configDir: cfg,
    apiKey: 'sk-test',
    runAgentTurnImpl: makeFakeRunner([
      // planner hands off to backend (no @mention, no marker).
      { text: 'over to you', toolCalls: [{ name: 'handoff', input: { to: 'backend' }, result: { ok: true, control: 'handoff', to: 'backend' }, ok: true }] },
      // backend finishes.
      { text: 'done', toolCalls: [{ name: 'finish', input: { summary: 'ok' }, result: { ok: true, control: 'finish', summary: 'ok' }, ok: true }] },
    ]),
  });
  assert.equal(r.stoppedBy, 'done');
  const speakers = r.task.turns.map((t) => t.agent);
  assert.deepEqual(speakers, ['user', 'planner', 'backend']);
});

test('(b2) a handoff to an unknown agent is ignored (validated against team)', async () => {
  const cfg = tmpDir('ctrl-handoff-bad');
  const task = seedTask(cfg, 't_20260710_ctrh02', 'shop', 'planner');
  const r = await runTaskTurn({
    task,
    team: makeTeam('shop', ['planner', 'backend'], 'planner'),
    agentsById: { planner: makeAgent('planner', 'P'), backend: makeAgent('backend', 'B') },
    userMessage: 'go',
    configDir: cfg,
    apiKey: 'sk-test',
    maxAgentTurns: 5,
    runAgentTurnImpl: makeFakeRunner([
      // lead hands off to a ghost — must NOT enqueue anyone; lead is not
      // re-queued (lead speaking without a valid handoff), so queue drains.
      { text: 'over to ghost', toolCalls: [{ name: 'handoff', input: { to: 'ghost' }, result: { ok: true, control: 'handoff', to: 'ghost' }, ok: true }] },
    ]),
  });
  // No valid handoff, no marker, lead spoke → queue empties → idle.
  assert.equal(r.stoppedBy, 'idle');
  assert.deepEqual(r.task.turns.map((t) => t.agent), ['user', 'planner']);
});

test('(c) the legacy [[TASK_DONE]] marker STILL terminates (fallback intact)', async () => {
  const cfg = tmpDir('ctrl-legacy');
  const task = seedTask(cfg, 't_20260710_ctrl01', 'shop', 'planner');
  const r = await runTaskTurn({
    task,
    team: makeTeam('shop', ['planner', 'backend'], 'planner'),
    agentsById: { planner: makeAgent('planner', 'P'), backend: makeAgent('backend', 'B') },
    userMessage: 'go',
    configDir: cfg,
    apiKey: 'sk-test',
    // no control tool-calls — only the text marker.
    runAgentTurnImpl: makeFakeRunner([
      { text: 'all clear [[TASK_DONE]]', toolCalls: [] },
    ]),
  });
  assert.equal(r.stoppedBy, 'done');
  assert.equal(r.task.status, 'done');
});

test('(c2) legacy @mention handoff still enqueues (fallback intact)', async () => {
  const cfg = tmpDir('ctrl-legacy-mention');
  const task = seedTask(cfg, 't_20260710_ctrl02', 'shop', 'planner');
  const r = await runTaskTurn({
    task,
    team: makeTeam('shop', ['planner', 'backend'], 'planner'),
    agentsById: { planner: makeAgent('planner', 'P'), backend: makeAgent('backend', 'B') },
    userMessage: 'go',
    configDir: cfg,
    apiKey: 'sk-test',
    runAgentTurnImpl: makeFakeRunner([
      { text: 'need code from @backend', toolCalls: [] },
      { text: 'shipped [[TASK_DONE]]', toolCalls: [] },
    ]),
  });
  assert.equal(r.stoppedBy, 'done');
  assert.deepEqual(r.task.turns.map((t) => t.agent), ['user', 'planner', 'backend']);
});

// ── loops.mjs structured stop helper ──────────────────────────────────────

test('loops.detectControlStop finds a finish tool-call in a turn result', () => {
  assert.equal(typeof loops.detectControlStop, 'function');
  const stop = loops.detectControlStop({
    toolCalls: [{ name: 'finish', result: { ok: true, control: 'finish', summary: 's' } }],
  });
  assert.deepEqual(stop, { control: 'finish', summary: 's' });
  // No control call → null (byte-stable: callers fall back to --until regex).
  assert.equal(loops.detectControlStop({ toolCalls: [{ name: 'bash', result: { ok: true } }] }), null);
  assert.equal(loops.detectControlStop({}), null);
  assert.equal(loops.detectControlStop(null), null);
});
