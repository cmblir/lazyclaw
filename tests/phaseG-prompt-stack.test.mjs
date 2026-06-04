// Phase G — composePromptStack 8-layer ordering + missing-layer fallback (spec §9.3, decision C10).
//
// Ported to node:test because playwright is not installed in this worktree
// and the orchestrator's final gate runs `node --test tests/phaseG*-*.test.mjs`.
// Test bodies mirror the plan's spec.ts verbatim where possible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pstack-'));
}

test('composePromptStack orders 8 layers and skips empty layers', async () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'workspaces', 'ws1'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });

  fs.writeFileSync(path.join(cfgDir, 'SOUL.md'), 'GLOBAL_SOUL');
  fs.writeFileSync(path.join(cfgDir, 'workspaces', 'ws1', 'SOUL.md'), 'WORKSPACE_SOUL');
  fs.writeFileSync(path.join(cfgDir, 'personalities', 'pirate.md'), 'PIRATE_PERSONA');
  fs.writeFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'USER_FACTS');
  fs.writeFileSync(path.join(cfgDir, 'memory', 'core.md'), 'CORE_MEM');
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'dev-review.md'),
    '---\nname: dev-review\ndescription: review code\n---\nbody'
  );

  const mod = await import(`${process.cwd()}/mas/prompt_stack.mjs?ts=${Date.now()}`);
  const out = mod.composePromptStack({
    cfgDir,
    agent: { name: 'a1', role: 'AGENT_ROLE', personality: 'pirate' },
    workspace: 'ws1',
    sessionId: 's1',
  });

  assert.ok(out.includes('GLOBAL_SOUL'));
  assert.ok(out.includes('WORKSPACE_SOUL'));
  assert.ok(out.includes('PIRATE_PERSONA'));
  assert.ok(out.includes('AGENT_ROLE'));
  assert.ok(out.includes('USER_FACTS'));
  assert.ok(out.includes('dev-review'));
  assert.ok(out.includes('CORE_MEM'));

  // Strict ordering: GLOBAL precedes WORKSPACE precedes PERSONA precedes ROLE
  // precedes USER_FACTS precedes skill index precedes CORE_MEM.
  const order = ['GLOBAL_SOUL', 'WORKSPACE_SOUL', 'PIRATE_PERSONA',
    'AGENT_ROLE', 'USER_FACTS', 'dev-review', 'CORE_MEM'];
  let last = -1;
  for (const tag of order) {
    const i = out.indexOf(tag);
    assert.ok(i > last, `expected ${tag} to follow position ${last}, got ${i}`);
    last = i;
  }
});

test('composePromptStack skips missing layers without throwing', async () => {
  const cfgDir = tmpCfg();
  const mod = await import(`${process.cwd()}/mas/prompt_stack.mjs?ts=${Date.now()}`);
  const out = mod.composePromptStack({ cfgDir, agent: { name: 'a1' } });
  assert.equal(typeof out, 'string');
});
