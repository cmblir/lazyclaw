// tests/f-slash-panel-grammar.test.mjs — the grammar the dashboard panels compose.
//
// Task 8 discovered its composers named commands that did not exist: an agent
// could not be given a provider or model, a team member could not be added, and
// /workflow was not a slash command at all. The dashboard would have lost
// capability the REST surface already had. These pin the grammar the panels
// speak, so a composer and its command cannot drift apart again.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchSlash, SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-grammar-'));
process.env.POMPOS_CONFIG_DIR = CFG;
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

const ctx = () => ({ cfgDir: CFG, cfg: {}, readConfig: () => ({}), writeConfig: () => {} });

test('/agent add takes --provider and --model', async () => {
  await dispatchSlash('/agent', 'add scout --provider anthropic --model opus researcher', ctx(), () => {});
  const { getAgent } = await import('../agents.mjs');
  const a = getAgent('scout', CFG);
  assert.equal(a.provider, 'anthropic');
  assert.equal(a.model, 'opus');
  assert.match(a.role, /researcher/, 'the trailing free text is still the role');
});

test('/agent add without the flags keeps its existing defaults', async () => {
  await dispatchSlash('/agent', 'add plain just a role', ctx(), () => {});
  const { getAgent } = await import('../agents.mjs');
  const a = getAgent('plain', CFG);
  assert.equal(a.provider, 'claude-cli', 'unchanged default');
  assert.equal(a.role, 'just a role');
});

test('/team member add and remove change membership', async () => {
  await dispatchSlash('/agent', 'add m1', ctx(), () => {});
  await dispatchSlash('/agent', 'add m2', ctx(), () => {});
  await dispatchSlash('/team', 'add crew --agents m1', ctx(), () => {});

  await dispatchSlash('/team', 'member add crew m2', ctx(), () => {});
  const { getTeam } = await import('../teams.mjs');
  assert.deepEqual(getTeam('crew', CFG).agents.sort(), ['m1', 'm2']);

  await dispatchSlash('/team', 'member remove crew m2', ctx(), () => {});
  assert.deepEqual(getTeam('crew', CFG).agents, ['m1']);
});

test('/team member reports a missing team or agent instead of silently doing nothing', async () => {
  const a = await dispatchSlash('/team', 'member add nosuchteam m1', ctx(), () => {});
  assert.match(String(a), /nosuchteam/, 'names what was not found');
  const b = await dispatchSlash('/team', 'member add crew nosuchagent', ctx(), () => {});
  assert.match(String(b), /nosuchagent/);
});

test('/workflow is a registered command with run, resume and clear', async () => {
  assert.ok(SLASH_HANDLERS.has('/workflow'), 'the panels compose /workflow lines');
  const usage = await dispatchSlash('/workflow', '', ctx(), () => {});
  for (const sub of ['run', 'resume', 'clear']) {
    assert.match(String(usage), new RegExp(sub), `usage must mention ${sub}`);
  }
});

test('/workflow names an unknown workflow rather than reporting success', async () => {
  const out = await dispatchSlash('/workflow', 'run nosuchworkflow', ctx(), () => {});
  assert.match(String(out), /nosuchworkflow/);
  assert.doesNotMatch(String(out), /^✓/, 'a failure must not read as success');
  const c = ctx();
  await dispatchSlash('/workflow', 'run nosuchworkflow', c, () => {});
  assert.ok(c.__persistFailed, 'a missing workflow must not report ok:true over HTTP');
});

// Fix round 1 — the flag-value validation gap: a --provider/--model whose
// "value" is itself another recognized flag (an empty composer field can
// produce exactly this shape) used to be swallowed silently: provider got set
// to the literal string "--model" and "opus" leaked into the role text.
test('/agent add rejects --provider/--model when the value is itself another flag', async () => {
  const out = await dispatchSlash('/agent', 'add flagtest --provider --model opus researcher', ctx(), () => {});
  assert.match(String(out), /--provider/, 'names which flag was malformed');
  const { getAgent } = await import('../agents.mjs');
  assert.equal(getAgent('flagtest', CFG), null, 'a malformed flag must not create a corrupted agent');
});

// The end-of-args case (a flag with nothing after it at all) must stay a
// silent default, not a new rejection — this is what "already safe" meant.
test('/agent add with --provider at the very end of args still defaults cleanly', async () => {
  const out = await dispatchSlash('/agent', 'add trailing --provider', ctx(), () => {});
  assert.match(String(out), /added agent trailing/);
  const { getAgent } = await import('../agents.mjs');
  const a = getAgent('trailing', CFG);
  assert.equal(a.provider, 'claude-cli', 'a flag with no value at all still falls back to the default');
});

test('/team member add|remove report ok:false over HTTP when the team or agent is missing', async () => {
  const c1 = ctx();
  await dispatchSlash('/team', 'member add nosuchteam m1', c1, () => {});
  assert.ok(c1.__persistFailed, 'a missing team must not report ok:true over HTTP');
  const c2 = ctx();
  await dispatchSlash('/team', 'member add crew nosuchagent', c2, () => {});
  assert.ok(c2.__persistFailed, 'a missing agent must not report ok:true over HTTP');
});

// /workflow's real success/failure path, and the state-dir precedence fix —
// only usage/not-found were pinned before; nothing proved run/resume actually
// execute a real stored workflow, or that resume reuses saved state instead
// of re-running it.
test('/workflow run succeeds against a real stored workflow, resume reuses saved state, clear removes it', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-wf-state-'));
  const wfCtx = () => ({
    cfgDir: CFG,
    cfg: { workflows: { greet: { def: { nodes: [{ id: 'msg', type: 'set', config: { value: 'hi' } }] } } } },
    readConfig: () => ({}), writeConfig: () => {},
    workflowStateDir: () => stateDir,
  });
  try {
    const ran = await dispatchSlash('/workflow', 'run greet', wfCtx(), () => {});
    assert.match(String(ran), /^✓/, 'a genuine success reads as success');
    assert.match(String(ran), /\(1 node\(s\)\)/, 'the fresh run actually executed the one node');

    const resumed = await dispatchSlash('/workflow', 'resume greet', wfCtx(), () => {});
    assert.match(String(resumed), /^✓/);
    assert.match(String(resumed), /\(0 node\(s\)\)/, 'resume reused saved state instead of re-running the node');

    const cleared = await dispatchSlash('/workflow', 'clear greet', wfCtx(), () => {});
    assert.match(String(cleared), /^✓/);
    assert.equal(fs.existsSync(path.join(stateDir, 'greet.json')), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('/workflow run that genuinely fails reports ok:false, not a success line', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-wf-fail-'));
  const c = {
    cfgDir: CFG,
    // http's own guard throws synchronously when no url is configured — a
    // deterministic, network-free way to make a REAL run genuinely fail (the
    // workflow entry exists and is used; this is not a "not found" case).
    cfg: { workflows: { broken: { def: { nodes: [{ id: 'x', type: 'http', config: {} }] } } } },
    readConfig: () => ({}), writeConfig: () => {},
    workflowStateDir: () => stateDir,
  };
  try {
    const out = await dispatchSlash('/workflow', 'run broken', c, () => {});
    assert.doesNotMatch(String(out), /^✓/, 'a genuine execution failure must not read as success');
    assert.ok(c.__persistFailed, 'a genuine execution failure must report ok:false over HTTP — the clearest instance of this defect class');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('/workflow resolves the state dir from ctx.workflowStateDir, which wins over the env var', async () => {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-wf-env-'));
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-wf-ctxdir-'));
  const prevEnv = process.env.POMPOS_WORKFLOW_STATE_DIR;
  process.env.POMPOS_WORKFLOW_STATE_DIR = envDir;
  try {
    const wfCtx = {
      cfgDir: CFG,
      cfg: { workflows: { pinger: { def: { nodes: [{ id: 'x', type: 'set', config: { value: 1 } }] } } } },
      readConfig: () => ({}), writeConfig: () => {},
      workflowStateDir: () => ctxDir,
    };
    await dispatchSlash('/workflow', 'run pinger', wfCtx, () => {});
    assert.ok(fs.existsSync(path.join(ctxDir, 'pinger.json')), 'state landed in the ctx-supplied dir');
    assert.equal(fs.existsSync(path.join(envDir, 'pinger.json')), false, 'must NOT fall back to the env var when ctx supplies a resolver');
  } finally {
    process.env.POMPOS_WORKFLOW_STATE_DIR = prevEnv;
    fs.rmSync(envDir, { recursive: true, force: true });
    fs.rmSync(ctxDir, { recursive: true, force: true });
  }
});
