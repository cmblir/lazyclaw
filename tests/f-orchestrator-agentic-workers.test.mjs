// tests/f-orchestrator-agentic-workers.test.mjs
//
// Roadmap #6a: an orchestrator EXECUTE worker could only stream text — it
// couldn't use tools (shell/recall/web). Opt-in cfg.orchestrator.agenticWorkers
// runs each worker through runAgentTurn so it does real tool work, then reports.
// OFF by default → the text-streaming path is byte-stable (existing tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOrchestratorProvider } from '../providers/orchestrator.mjs';
import { PROVIDERS, PROVIDER_INFO } from '../providers/registry.mjs';

const _lookup = (p) => ({ prov: PROVIDERS[p], info: PROVIDER_INFO[p] });

function installFakePlanner(subtasks) {
  PROVIDERS['fake-planner'] = { async *sendMessage() { yield JSON.stringify(subtasks); } };
  PROVIDER_INFO['fake-planner'] = { defaultModel: 'fake' };
}
function rm(name) { delete PROVIDERS[name]; delete PROVIDER_INFO[name]; }
async function drain(s) { let o = ''; for await (const c of s) o += String(c); return o; }

test('agenticWorkers ON: a worker runs through runAgentTurn (anthropic tool loop)', async () => {
  installFakePlanner([{ id: 1, task: 'investigate the thing' }]);
  // The anthropic worker's runAgentTurn uses this injected fetch (no network).
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'worker did the thing' }], stop_reason: 'end_turn' }) };
  };
  try {
    const cfg = { orchestrator: { planner: 'fake-planner', workers: ['anthropic:claude-opus-4-7'], agenticWorkers: true, concurrency: 1 } };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup, keyResolver: () => 'sk' });
    const out = await drain(prov.sendMessage([{ role: 'user', content: 'go' }], { fetchImpl }));
    assert.ok(out.includes('worker did the thing'), `agentic worker output should appear; got: ${out.slice(0, 300)}`);
    assert.ok(calls >= 1, 'the worker actually went through runAgentTurn (provider call made)');
  } finally { rm('fake-planner'); }
});

test('agenticWorkers OFF (default): the worker still streams provider text', async () => {
  installFakePlanner([{ id: 1, task: 'just answer' }]);
  PROVIDERS['fake-worker'] = { async *sendMessage() { yield 'plain text answer'; } };
  PROVIDER_INFO['fake-worker'] = { defaultModel: 'fake' };
  try {
    const cfg = { orchestrator: { planner: 'fake-planner', workers: ['fake-worker'], concurrency: 1 } }; // no agenticWorkers
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup, keyResolver: () => '' });
    const out = await drain(prov.sendMessage([{ role: 'user', content: 'go' }], {}));
    assert.ok(out.includes('plain text answer'), 'default path streams provider text unchanged');
  } finally { rm('fake-planner'); rm('fake-worker'); }
});
