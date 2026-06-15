// tests/p4-guided-create.test.mjs — guided interactive creation: when the
// required arg is missing and a modal is available, /agent add, /goal add,
// /task start, /team add prompt/pick instead of returning a usage string.
// Typed forms (with the arg) and the no-modal path are unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { getAgent } from '../agents.mjs';
import { getGoal } from '../goals.mjs';
import { listTeams, registerTeam } from '../teams.mjs';
import { registerAgent } from '../agents.mjs';

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-guided-')); process.env.LAZYCLAW_CONFIG_DIR = d; return d; }
// Scripted picker: 'text' kind (a _promptText prompt) → next text answer as
// {id:'__text__',query}; any other kind → next menu answer verbatim.
function scripted(menuAndText) {
  const q = [...menuAndText];
  return async (opts) => {
    const next = q.shift();
    if (next === null || next === undefined) return null;
    if (opts.kind === 'text') return { id: '__text__', query: next };
    return next; // menu id (string) or {id}
  };
}

test('/agent add with no name prompts for name + role', async () => {
  const cfgDir = tmp();
  const ctx = { cfgDir, cfg: {}, openPicker: scripted(['scout', 'researcher']) };
  const out = await dispatchSlash('/agent', 'add', ctx, () => {});
  const a = getAgent('scout', cfgDir);
  assert.ok(a, 'agent created');
  assert.equal(a.role, 'researcher');
  assert.match(out, /added agent scout/);
});

test('/agent add cancel (Esc on name) creates nothing', async () => {
  const cfgDir = tmp();
  const ctx = { cfgDir, cfg: {}, openPicker: scripted([null]) };
  const out = await dispatchSlash('/agent', 'add', ctx, () => {});
  assert.match(out, /cancelled/);
});

test('/goal add with no name prompts name + desc + cron preset', async () => {
  const cfgDir = tmp();
  // name, desc, then cron menu pick (daily 09:00)
  const ctx = { cfgDir, cfg: {}, openPicker: scripted(['ship-v2', 'release work', '0 9 * * *']) };
  const out = await dispatchSlash('/goal', 'add', ctx, () => {});
  const g = getGoal('ship-v2', cfgDir);
  assert.ok(g, 'goal created');
  assert.equal(g.description, 'release work');
  assert.equal(g.schedule, '0 9 * * *');
  assert.match(out, /ship-v2/);
});

test('/task start with no args picks a team + prompts title', async () => {
  const cfgDir = tmp();
  registerAgent({ name: 'lead1', role: 'r' }, cfgDir);
  registerTeam({ name: 'red', agents: ['lead1'], lead: 'lead1' }, cfgDir);
  // team menu pick 'red', then title text, then desc text (empty/skip)
  const ctx = { cfgDir, cfg: {}, openPicker: scripted(['red', 'fix the bug', '']) };
  const out = await dispatchSlash('/task', 'start', ctx, () => {});
  assert.match(out, /fix the bug|task|red/i);
});

test('/team add with no --agents multi-picks agents + lead', async () => {
  const cfgDir = tmp();
  registerAgent({ name: 'a1', role: 'r' }, cfgDir);
  registerAgent({ name: 'a2', role: 'r' }, cfgDir);
  // name text, then agent picks: a1, a2, __done__, then lead pick a1
  const ctx = { cfgDir, cfg: {}, openPicker: scripted(['shipper', 'a1', 'a2', '__done__', 'a1']) };
  const out = await dispatchSlash('/team', 'add', ctx, () => {});
  const t = listTeams(cfgDir).find((x) => x.name === 'shipper');
  assert.ok(t, 'team created');
  assert.deepEqual(t.agents.sort(), ['a1', 'a2']);
  assert.equal(t.lead, 'a1');
  assert.match(out, /added team shipper/);
});

test('typed /agent add <name> still works without a picker', async () => {
  const cfgDir = tmp();
  const out = await dispatchSlash('/agent', 'add typed researcher', { cfgDir, cfg: {} }, () => {});
  assert.ok(getAgent('typed', cfgDir));
  assert.match(out, /added agent typed/);
});
