// tests/f-team-turn-usage.test.mjs
//
// End-to-end of the team cost-accounting chain: runTaskTurn → runAgentTurn →
// tool-use adapter → normalized usage → onUsage. Team agent turns used to
// report no usage at all, so a channel bound to a team ran a multi-agent loop
// whose spend never reached the cost cap. runTaskTurn now fires onUsage per
// agent turn carrying that agent's provider+model alongside the usage, so a
// mixed-provider team prices each turn against the right rate card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskTurn } from '../mas/mention_router.mjs';
import { registerAgent } from '../agents.mjs';
import { registerTeam } from '../teams.mjs';
import { registerTask } from '../tasks.mjs';

const tmpCfg = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ttu-'));

test('runTaskTurn fires onUsage per agent turn with provider + model + usage', async () => {
  const cfg = tmpCfg();
  registerAgent({ name: 'planner', provider: 'anthropic', model: 'claude-opus-4-7', role: 'R', tools: [] }, cfg);
  registerTeam({ name: 'team-u', agents: ['planner'], lead: 'planner' }, cfg);
  const task = registerTask({ id: 't_20260606_aaaaaa', title: 'u', team: 'team-u' }, cfg);

  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: 'done [[TASK_DONE]]' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 12 },
    }),
  });

  const seen = [];
  await runTaskTurn({
    task: { ...task, turns: [{ agent: 'user', text: 'go' }] },
    team: { name: 'team-u', displayName: 'U', agents: ['planner'], lead: 'planner' },
    agentsById: { planner: { name: 'planner', displayName: 'Planner', role: 'R', provider: 'anthropic', model: 'claude-opus-4-7', tools: [] } },
    configDir: cfg, apiKey: 'sk', fetchImpl,
    onUsage: (u) => seen.push(u),
  });

  assert.equal(seen.length, 1, 'onUsage should fire once for the single planner turn');
  assert.equal(seen[0].provider, 'anthropic');
  assert.equal(seen[0].model, 'claude-opus-4-7');
  assert.deepEqual(seen[0].usage, { inputTokens: 30, outputTokens: 12 });
});
