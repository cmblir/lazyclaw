// tests/p3-skills-picker.test.mjs — the user reported "skills don't show at
// all". Root cause: there is no skills listing/picker (the v5.4 /skills was a
// plain alias for /skill, which only activates/clears) AND the user has none
// installed. Make /skills list + pick installed skills, with a clear
// install hint when none exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx({ skills = [] } = {}) {
  let messages = [];
  return {
    cfgDir: '/tmp/lc-skills-test',
    registryMod: {},
    skillsMod: {
      listSkills: () => skills.map((name) => ({ name })),
      composeSystemPrompt: (names) => `SYS:${names.join('+')}`,
    },
    sessionsMod: { resetSession: () => {}, appendTurn: () => {} },
    getMessages: () => messages,
    setMessages: (n) => { messages = n; },
    getSessionId: () => null,
  };
}

test('/skills with none installed returns a clear install hint', async () => {
  const ctx = makeCtx({ skills: [] });
  const out = await dispatchSlash('/skills', '', ctx);
  assert.match(out, /no skills installed/i);
  assert.match(out, /pompos skills install/);
});

test('/skills lists installed skills when there is no picker', async () => {
  const ctx = makeCtx({ skills: ['dev-review', 'writing-plan'] });
  const out = await dispatchSlash('/skills', '', ctx);
  assert.match(out, /dev-review/);
  assert.match(out, /writing-plan/);
});

test('/skills opens a picker and activates the chosen skill', async () => {
  const ctx = makeCtx({ skills: ['dev-review', 'writing-plan'] });
  let seen = null;
  ctx.openPicker = async (opts) => { seen = opts; return 'dev-review'; };
  const out = await dispatchSlash('/skills', '', ctx);
  assert.equal(seen.kind, 'skill');
  assert.ok(seen.items.map((i) => i.id).includes('dev-review'));
  assert.match(out, /active skills: dev-review/);
  assert.equal(ctx.getMessages()[0].role, 'system');
});

test('/skills <name> activates directly (no picker)', async () => {
  const ctx = makeCtx({ skills: ['dev-review'] });
  const out = await dispatchSlash('/skills', 'dev-review', ctx);
  assert.match(out, /active skills: dev-review/);
});
