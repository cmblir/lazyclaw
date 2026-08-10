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
});
