// tests/f-orchestrator-default-parallel.test.mjs
//
// The orchestrator provider supported bounded-parallel worker dispatch
// (concurrency >= 2) but DEFAULTED to 1 (sequential) when cfg.orchestrator
// .concurrency was unset, so an unconfigured fleet ran subtasks one at a time
// even though parallel execution is the whole point of a worker pool. These
// pin that parallel is the default, while an explicit concurrency:1 still opts
// back into sequential streaming.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { makeOrchestratorProvider } from '../providers/orchestrator.mjs';
import { PROVIDERS, PROVIDER_INFO } from '../providers/registry.mjs';

// These drive the real orchestrator provider, which persists a trajectory per
// run through mas/trajectory_store.mjs. Without an isolated config directory
// that lands in the developer's OWN ~/.pompos, mixing fake-planner test records
// into their real trajectories and search index. node --test gives each file its
// own process, so setting this at module scope is contained to this file.
const _testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-test-cfg-'));
process.env.POMPOS_CONFIG_DIR = _testConfigDir;
after(() => fs.rmSync(_testConfigDir, { recursive: true, force: true }));


const _lookup = (p) => ({ prov: PROVIDERS[p], info: PROVIDER_INFO[p] });

function installDelayWorker(name, delayMs) {
  PROVIDERS[name] = { async *sendMessage() { await new Promise((r) => setTimeout(r, delayMs)); yield `[${name}] done\n`; } };
  PROVIDER_INFO[name] = { defaultModel: 'fake' };
}
function installFakePlanner(subtasks) {
  PROVIDERS['fake-planner'] = { async *sendMessage() { yield JSON.stringify(subtasks); } };
  PROVIDER_INFO['fake-planner'] = { defaultModel: 'fake' };
}
function rm(name) { delete PROVIDERS[name]; delete PROVIDER_INFO[name]; }
async function drain(s) { let o = ''; for await (const c of s) o += String(c); return o; }

test('orchestrator runs subtasks in parallel BY DEFAULT (concurrency unset)', async () => {
  installFakePlanner([{ id: 1, task: 'a' }, { id: 2, task: 'b' }, { id: 3, task: 'c' }]);
  installDelayWorker('dw1', 150); installDelayWorker('dw2', 150); installDelayWorker('dw3', 150);
  try {
    const cfg = { orchestrator: { planner: 'fake-planner', workers: ['dw1', 'dw2', 'dw3'] } }; // NO concurrency
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const t0 = Date.now();
    const out = await drain(prov.sendMessage([{ role: 'user', content: 'go' }]));
    const elapsed = Date.now() - t0;
    assert.ok(out.includes('parallel'), `default should be parallel (got: ${out.slice(0, 160)})`);
    assert.ok(elapsed < 380, `parallel default took ${elapsed}ms; 3×150ms sequential would be ~450ms`);
  } finally { rm('fake-planner'); rm('dw1'); rm('dw2'); rm('dw3'); }
});

test('explicit concurrency:1 still forces sequential (opt-out preserved)', async () => {
  installFakePlanner([{ id: 1, task: 'a' }, { id: 2, task: 'b' }]);
  installDelayWorker('sw1', 120); installDelayWorker('sw2', 120);
  try {
    const cfg = { orchestrator: { planner: 'fake-planner', workers: ['sw1', 'sw2'], concurrency: 1 } };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const out = await drain(prov.sendMessage([{ role: 'user', content: 'go' }]));
    assert.ok(!/concurrency=\d+, parallel/.test(out), 'explicit concurrency:1 must stay sequential');
  } finally { rm('fake-planner'); rm('sw1'); rm('sw2'); }
});
