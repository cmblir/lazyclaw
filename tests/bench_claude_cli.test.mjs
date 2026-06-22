// Unit tests for the claude-cli benchmark harness DETERMINISTIC core.
//
// The live runner (scripts/bench-claude-cli.mjs main()) spawns the real,
// subscription-billed `claude` CLI and is NEVER exercised here — importing the
// module must be side-effect-free (main() is script-guarded). What we verify
// without quota is the part that turns a stream-json byte stream + N samples
// into honest numbers:
//   - measureStream(): TTFT / wall / gen decomposition + usage extraction
//   - runSamples():    N-sample aggregation per metric
//   - formatTable():   median/p95/stdev rendering
//
// Stream shapes are pinned to the live format (claude 2.1.185, verified
// 2026-06-22): per-turn token usage rides the `assistant` message event; the
// final `result` event reports ZERO usage but carries total_cost_usd,
// duration_ms, duration_api_ms and num_turns. The decomposition MUST read usage
// from `assistant`, not `result` — the assertions below would catch a regress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  measureStream, measureTextStream, spawnAndMeasure,
  runSamples, formatTable, oneShotArgs,
} from '../scripts/bench-claude-cli.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

const L = {
  init: '{"type":"system","subtype":"init"}',
  text: (t) => JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } },
  }),
  assistant: '{"type":"assistant","message":{"usage":{"input_tokens":2,'
    + '"cache_creation_input_tokens":3189,"cache_read_input_tokens":0,"output_tokens":4}}}',
  result: '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0326,'
    + '"duration_ms":1400,"duration_api_ms":1500,"num_turns":1,"usage":{"input_tokens":0}}',
};

test('measureStream: usage from assistant, cost/duration/turns from result, TTFT/wall/gen timing, chunk-boundary buffering', async () => {
  let t = 1000;            // t0 is captured at the value of `now` on entry
  const now = () => t;
  const text1 = L.text('He');
  async function* chunks() {
    t = 1050;
    yield L.init + '\n' + text1.slice(0, 20);                  // partial text line — must buffer
    t = 1075;
    yield text1.slice(20) + '\n' + L.text('llo') + '\n';       // completes first text -> TTFT here
    t = 1100;
    yield L.assistant + '\n' + L.result + '\n';
    t = 1150;                                                  // runs on final .next() (loop exit) -> wall
  }
  const r = await measureStream(chunks(), now);
  approx(r.ttftMs, 75);
  approx(r.wallMs, 150);
  approx(r.genMs, 75);
  assert.equal(r.textLen, 5);                 // "He" + "llo"
  assert.equal(r.inputTokens, 2);             // from assistant event, NOT result (which is 0)
  assert.equal(r.cacheCreationTokens, 3189);
  assert.equal(r.cacheReadTokens, 0);
  assert.equal(r.outputTokens, 4);
  approx(r.costUsd, 0.0326);
  assert.equal(r.claudeDurationMs, 1400);
  assert.equal(r.claudeApiMs, 1500);
  assert.equal(r.numTurns, 1);
  assert.equal(r.isError, false);
});

test('measureStream: no text deltas -> TTFT falls back to wall, gen 0, usage null', async () => {
  let t = 500;
  const now = () => t;
  async function* chunks() { t = 560; yield L.result + '\n'; t = 600; }
  const r = await measureStream(chunks(), now);
  approx(r.wallMs, 100);
  approx(r.ttftMs, 100);    // fallback to wall when nothing streamed
  approx(r.genMs, 0);
  assert.equal(r.inputTokens, null);   // no assistant event
  assert.equal(r.numTurns, 1);
  assert.equal(r.isError, false);
});

test('measureStream: a runaway/error result is surfaced (is_error + num_turns)', async () => {
  let t = 0;
  const now = () => t;
  const errResult = '{"type":"result","subtype":"error_max_turns","is_error":true,'
    + '"num_turns":12,"total_cost_usd":0.5,"duration_ms":90000,"duration_api_ms":88000}';
  async function* chunks() { t = 10; yield L.text('x') + '\n'; t = 20; yield errResult + '\n'; t = 30; }
  const r = await measureStream(chunks(), now);
  assert.equal(r.isError, true);
  assert.equal(r.numTurns, 12);
  assert.equal(r.claudeApiMs, 88000);
});

test('runSamples: aggregates N measurements per metric and calls measureFn exactly n times', async () => {
  const canned = [
    { ttftMs: 10, wallMs: 100, genMs: 90, inputTokens: 2, outputTokens: 4, costUsd: 0.01, claudeApiMs: 80, numTurns: 1, cacheCreationTokens: 3000, cacheReadTokens: 0 },
    { ttftMs: 20, wallMs: 200, genMs: 180, inputTokens: 2, outputTokens: 5, costUsd: 0.02, claudeApiMs: 160, numTurns: 1, cacheCreationTokens: 0, cacheReadTokens: 3000 },
    { ttftMs: 30, wallMs: 300, genMs: 270, inputTokens: 2, outputTokens: 6, costUsd: 0.03, claudeApiMs: 240, numTurns: 1, cacheCreationTokens: 0, cacheReadTokens: 3000 },
  ];
  let calls = 0;
  const measureFn = async (i) => { calls++; return canned[i]; };
  const r = await runSamples('lean', measureFn, 3);
  assert.equal(calls, 3);
  assert.equal(r.label, 'lean');
  assert.equal(r.n, 3);
  assert.equal(r.samples.length, 3);
  assert.equal(r.stats.wallMs.median, 200);
  assert.equal(r.stats.wallMs.min, 100);
  assert.equal(r.stats.wallMs.max, 300);
  assert.equal(r.stats.ttftMs.median, 20);
  assert.equal(r.stats.inputTokens.median, 2);   // the deterministic token metric...
  assert.equal(r.stats.inputTokens.stdev, 0);     // ...has zero variance — defensible regardless of latency noise
});

test('formatTable: renders a metric across conditions with median/p95/stdev', () => {
  const results = [
    { label: 'lean one-shot', stats: { wallMs: { n: 10, median: 3200, p95: 4800, stdev: 520, min: 2800, max: 5000, mean: 3300 } } },
    { label: 'non-lean one-shot', stats: { wallMs: { n: 10, median: 5200, p95: 7000, stdev: 800, min: 4500, max: 7200, mean: 5400 } } },
  ];
  const out = formatTable(results, 'wallMs', 'ms');
  assert.ok(out.includes('lean one-shot'), 'lists the lean condition');
  assert.ok(out.includes('non-lean one-shot'), 'lists the non-lean condition');
  assert.ok(out.includes('3200'), 'shows the lean median');
  assert.ok(out.includes('median'), 'has a median column header');
  assert.ok(out.includes('p95'), 'has a p95 column header');
});

// ── measureTextStream: the persistent-session path (text chunks + onUsage) ──
// The warm session yields plain text chunks (not raw stream-json) and surfaces
// usage via an onUsage callback, so latency is measured from chunk arrival.
test('measureTextStream: TTFT/wall from text chunks, usage from the onUsage callback', async () => {
  let t = 200;
  const now = () => t;
  const run = (onUsage) => {
    async function* gen() {
      t = 230; yield 'Hel';
      t = 260; yield 'lo';
      t = 300; onUsage({ inputTokens: 7, outputTokens: 2, totalCostUsd: 0.004 });
    }
    return gen();
  };
  const r = await measureTextStream(run, now);
  approx(r.ttftMs, 30);    // first chunk at 230, t0 200
  approx(r.wallMs, 100);   // 300 - 200
  approx(r.genMs, 70);
  assert.equal(r.textLen, 5);
  assert.equal(r.inputTokens, 7);
  assert.equal(r.outputTokens, 2);
  approx(r.costUsd, 0.004);
});

// ── spawnAndMeasure: a REAL spawn of the fake claude (quota-free) ───────────
test('spawnAndMeasure: real spawn parses usage from assistant + cost/turns from result', async () => {
  const r = await spawnAndMeasure({
    bin: FAKE_CLAUDE,
    args: ['-p', 'hi', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
  });
  assert.equal(r.inputTokens, 2);          // from the assistant event
  assert.equal(r.outputTokens, 2);         // "ok"
  assert.equal(r.cacheCreationTokens, 3189);
  assert.equal(r.numTurns, 1);
  assert.equal(r.isError, false);
  assert.equal(r.costUsd, 0.0123);
  assert.ok(r.wallMs >= 0, 'wall is measured');
  assert.ok(r.ttftMs <= r.wallMs + 1, 'TTFT precedes (or equals) wall');
});

// ── oneShotArgs: the condition matrix is wired to buildArgs correctly ───────
test('oneShotArgs: lean keeps --setting-sources "", non-lean drops it', () => {
  const lean = oneShotArgs('lean', 'hi', '');
  assert.ok(lean.includes('--setting-sources'));
  assert.equal(lean[lean.indexOf('--setting-sources') + 1], '');
  assert.ok(lean.includes('--strict-mcp-config'));

  const nonlean = oneShotArgs('nonlean', 'hi', '');
  assert.ok(!nonlean.includes('--setting-sources'), 'non-lean loads the full Claude Code env');
  assert.ok(!nonlean.includes('--strict-mcp-config'));
});

test('oneShotArgs: bounded caps at --max-turns 1 WITH tools; unbounded raises the cap', () => {
  const bounded = oneShotArgs('bounded', 'list the files', '');
  assert.equal(bounded[bounded.indexOf('--max-turns') + 1], '1');
  assert.ok(bounded[bounded.indexOf('--tools') + 1].length > 0, 'tools enabled so a tool CAN be called');

  const unbounded = oneShotArgs('unbounded', 'list the files', '');
  assert.ok(Number(unbounded[unbounded.indexOf('--max-turns') + 1]) > 1, 'cap raised to allow the loop');
  assert.equal(unbounded[unbounded.indexOf('--tools') + 1], bounded[bounded.indexOf('--tools') + 1],
    'same toolset — only the turn cap differs, isolating the bounded-loop effect');
});

test('oneShotArgs: model alias is appended when given', () => {
  const args = oneShotArgs('lean', 'hi', 'opus');
  assert.deepEqual(args.slice(-2), ['--model', 'opus']);
});

