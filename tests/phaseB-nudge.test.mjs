// Phase B: nudge ticker + SSE event (spec §3.6, §0.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterRecent, makeNudgeEvent, startNudgeLoop } from '../mas/nudge.mjs';

test('clusterRecent: groups by normalised text, returns count >= threshold', () => {
  // Plan's exact-key clustering needs the same normalised key for all
  // three samples. "run the tests please" normalises differently, so we
  // use three same-key variants here (plan note in concerns[]).
  const lines = [
    { ts: 1, role: 'user', content: 'run the tests' },
    { ts: 2, role: 'user', content: 'Run The Tests' },
    { ts: 3, role: 'user', content: 'Run the tests!' },
    { ts: 4, role: 'user', content: 'deploy staging' },
  ];
  const clusters = clusterRecent(lines, { minCount: 3 });
  assert.ok(clusters.length > 0, `expected clusters, got ${clusters.length}`);
  assert.ok(clusters[0].count >= 3, `expected count>=3, got ${clusters[0].count}`);
  assert.ok(clusters[0].sample.toLowerCase().includes('run the tests'));
});

test('clusterRecent: below threshold returns empty', () => {
  const clusters = clusterRecent([
    { ts: 1, role: 'user', content: 'unique 1' },
    { ts: 2, role: 'user', content: 'unique 2' },
  ], { minCount: 3 });
  assert.deepEqual(clusters, []);
});

test('makeNudgeEvent: shape matches SSE producer contract', () => {
  const ev = makeNudgeEvent({ cluster: { count: 3, sample: 'run the tests', firstTs: 1, lastTs: 9 } });
  assert.equal(ev.kind, 'nudge.suggest_skill');
  assert.equal(ev.cluster.count, 3);
  assert.equal(typeof ev.ts, 'number');
});

test('startNudgeLoop.runOnce: emits an event when a cluster crosses minCount', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-nudge-loop-'));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const lines = [
    { ts: 1, role: 'user', content: 'run the tests' },
    { ts: 2, role: 'user', content: 'Run The Tests' },
    { ts: 3, role: 'user', content: 'Run the tests!' },
  ];
  fs.writeFileSync(path.join(dir, 'memory', 'recent.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const events = [];
  const loop = startNudgeLoop({ configDir: dir, intervalMs: 60000, minCount: 3, emit: (e) => events.push(e) });
  loop.runOnce();
  loop.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'nudge.suggest_skill');
});
