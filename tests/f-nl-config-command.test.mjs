import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectConfigCommand, applyConfigCommand, POMPOS_META_GUARD, refreshLiveProvider } from '../lib/nl_config_command.mjs';

test('refreshLiveProvider re-points the REPL live provider + status from cfg.provider', () => {
  const PROV = { name: 'claude-cli', sendMessage: () => {} };
  const calls = {};
  const ctx = {
    cfg: { provider: 'claude-cli', model: 'opus' },
    registryMod: { PROVIDERS: { 'claude-cli': PROV } },
    setActiveProvName: (n) => { calls.prov = n; },
    setProv: (p) => { calls.provObj = p; },
    setActiveModel: (m) => { calls.model = m; },
  };
  refreshLiveProvider(ctx);
  assert.equal(calls.prov, 'claude-cli', 'status bar provider updated');
  assert.equal(calls.provObj, PROV, 'live provider object re-resolved (so the next turn is NOT orchestrator)');
  assert.equal(calls.model, 'opus');
});

test('refreshLiveProvider is a no-op without cfg/setters (best-effort)', () => {
  assert.doesNotThrow(() => refreshLiveProvider(undefined));
  assert.doesNotThrow(() => refreshLiveProvider({ cfg: {} }));
});

test('POMPOS_META_GUARD forbids faking runs, inventing config, and raw command output', () => {
  assert.match(POMPOS_META_GUARD, /fabricate command execution/i);  // no faked runs
  assert.match(POMPOS_META_GUARD, /Running it now/);                 // bans the exact fake-execution phrase
  assert.match(POMPOS_META_GUARD, /```bash/);                        // bans fenced command blocks
  assert.match(POMPOS_META_GUARD, /NEVER invent or assume config names/); // no invented channels (test/main)
  assert.match(POMPOS_META_GUARD, /do NOT print raw .*commands, "Run:" lines/); // no Run: lines
});

// ── detection ─────────────────────────────────────────────────────────────
test('detects orchestrator off (ko + en)', () => {
  assert.deepEqual(detectConfigCommand('오케스트라 꺼줘'), { kind: 'orchestrator', enable: false });
  assert.deepEqual(detectConfigCommand('orchestrator off'), { kind: 'orchestrator', enable: false });
  assert.deepEqual(detectConfigCommand('오케스트레이터 비활성화'), { kind: 'orchestrator', enable: false });
});

test('detects orchestrator on', () => {
  assert.deepEqual(detectConfigCommand('오케스트라 켜줘'), { kind: 'orchestrator', enable: true });
  assert.deepEqual(detectConfigCommand('orchestrator on'), { kind: 'orchestrator', enable: true });
});

test('detects planner / worker model changes (ko aliases + en)', () => {
  assert.deepEqual(detectConfigCommand('플래너를 소넷으로 바꿔줘'), { kind: 'planner', model: 'sonnet' });
  assert.deepEqual(detectConfigCommand('워커를 하이쿠로 변경'), { kind: 'worker', model: 'haiku' });
  assert.deepEqual(detectConfigCommand('planner opus'), { kind: 'planner', model: 'opus' });
});

test('does NOT hijack questions or unrelated chat (no false positives)', () => {
  assert.equal(detectConfigCommand('오케스트라가 뭐야?'), null);            // question
  assert.equal(detectConfigCommand('오케스트라 끄는 법 알려줘'), null);      // "how to" question
  assert.equal(detectConfigCommand('planner pattern을 설명해줘'), null);     // explain
  assert.equal(detectConfigCommand('소넷이랑 하이쿠 차이가 뭐야'), null);    // comparison question
  assert.equal(detectConfigCommand('워커 노드에 배포하는 스크립트 짜줘'), null); // a real task that says "worker", no model token
  assert.equal(detectConfigCommand(''), null);
  assert.equal(detectConfigCommand('a'.repeat(200)), null);                 // long → a task
});

test('ambiguous both-planner-and-worker in one message → null (do it separately)', () => {
  assert.equal(detectConfigCommand('플래너 소넷 워커 하이쿠'), null);
});

// ── application ───────────────────────────────────────────────────────────
function fakeStore(initial) {
  let cfg = JSON.parse(JSON.stringify(initial));
  return {
    readConfig: () => JSON.parse(JSON.stringify(cfg)),
    writeConfig: (next) => { cfg = JSON.parse(JSON.stringify(next)); },
    get: () => cfg,
  };
}

test('applyConfigCommand: orchestrator off disables + reports the fallback provider', () => {
  const s = fakeStore({ provider: 'orchestrator', orchestrator: { planner: 'claude-cli:haiku', workers: ['claude-cli:sonnet'] } });
  const msg = applyConfigCommand({ kind: 'orchestrator', enable: false }, s);
  assert.notEqual(s.get().provider, 'orchestrator', 'provider routed away from orchestrator');
  assert.match(msg, /off/i);
});

test('applyConfigCommand: planner model change rewrites the spec, preserving the provider', () => {
  const s = fakeStore({ provider: 'orchestrator', orchestrator: { planner: 'claude-cli:haiku', workers: ['claude-cli:sonnet'] } });
  const msg = applyConfigCommand({ kind: 'planner', model: 'sonnet' }, s);
  assert.equal(s.get().orchestrator.planner, 'claude-cli:sonnet');
  assert.match(msg, /planner/i);
});

test('applyConfigCommand: worker model change sets the workers list', () => {
  const s = fakeStore({ provider: 'orchestrator', orchestrator: { planner: 'claude-cli:sonnet', workers: ['claude-cli:sonnet'] } });
  applyConfigCommand({ kind: 'worker', model: 'haiku' }, s);
  assert.deepEqual(s.get().orchestrator.workers, ['claude-cli:haiku']);
});
