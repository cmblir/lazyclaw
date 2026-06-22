#!/usr/bin/env node
// Multi-sample latency/token benchmark for the `claude` CLI provider path.
//
// WHY this exists: a single end-to-end turn is ~3-5s and DOMINATED by model
// generation + network (±2s of run-to-run noise), so one sample cannot isolate
// lazyclaw's own overhead — single-sample comparisons came out noise-dominated
// (lean even looked slower than non-lean once, which was pure noise). Per the
// engineering directives (§9 "measure, don't guess; record before/after") and
// the perf methodology note, every reported latency is median + p95 + stdev
// over N runs, and we separate the model round-trip (claude's self-reported
// duration_api_ms) from the lazyclaw + Claude-Code-harness overhead (external
// wall-clock minus that). The token deltas are deterministic and are the real,
// noise-free win.
//
// This file is split in two: the DETERMINISTIC core below (measureStream /
// runSamples / formatTable) is unit-tested in tests/bench_claude_cli.test.mjs
// with a fake stream + fake clock (no quota); the live runner (main(), spawns
// real `claude`) is appended in a later step and is script-guarded so importing
// this module for tests never spends a token.
//
// Stream-json shapes (verified against claude 2.1.185, 2026-06-22):
//   { type:'stream_event', event:{ type:'content_block_delta',
//                                  delta:{ type:'text_delta', text } } }   <- TTFT marker
//   { type:'assistant', message:{ usage:{ input_tokens, output_tokens,
//        cache_creation_input_tokens, cache_read_input_tokens } } }        <- the ONLY truthful usage
//   { type:'result', total_cost_usd, duration_ms, duration_api_ms,
//                     num_turns, is_error, usage:{ all zeros } }            <- cost/timing/turns

import { performance } from 'node:perf_hooks';
import { summarize } from './bench-stats.mjs';

// Pull a streamed text delta out of one parsed stream-json object ('' if none).
function extractTextDelta(obj) {
  if (!obj || obj.type !== 'stream_event') return '';
  const ev = obj.event || {};
  if (ev.type === 'content_block_delta' && ev.delta
      && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
    return ev.delta.text;
  }
  return '';
}

// Consume a newline-delimited stream-json byte stream and decompose it into the
// timing + usage record one benchmark sample needs. `chunks` is any async
// iterable of string chunks (real proc.stdout, or a fake in tests); `now` is an
// injectable monotonic clock so tests are deterministic.
export async function measureStream(chunks, now = () => performance.now()) {
  const t0 = now();
  let buffer = '';
  let ttftMs = null;
  let textLen = 0;
  let usage = null;     // from the `assistant` event — the truthful per-turn usage
  let result = null;    // from the `result` event — cost / duration / turns
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const text = extractTextDelta(obj);
      if (text) {
        if (ttftMs === null) ttftMs = now() - t0;
        textLen += text.length;
      }
      if (obj.type === 'assistant' && obj.message && obj.message.usage) usage = obj.message.usage;
      if (obj.type === 'result') result = obj;
    }
  }
  const wallMs = now() - t0;
  const ttft = ttftMs == null ? wallMs : ttftMs;   // nothing streamed -> TTFT == wall
  return {
    ttftMs: ttft,
    wallMs,
    genMs: wallMs - ttft,
    textLen,
    inputTokens: usage ? (usage.input_tokens || 0) : null,
    cacheCreationTokens: usage ? (usage.cache_creation_input_tokens || 0) : null,
    cacheReadTokens: usage ? (usage.cache_read_input_tokens || 0) : null,
    outputTokens: usage ? (usage.output_tokens || 0) : null,
    costUsd: result ? (result.total_cost_usd || 0) : null,
    claudeDurationMs: result && result.duration_ms != null ? result.duration_ms : null,
    claudeApiMs: result && result.duration_api_ms != null ? result.duration_api_ms : null,
    numTurns: result && result.num_turns != null ? result.num_turns : null,
    isError: result ? !!result.is_error : null,
  };
}

// The metrics we aggregate across samples. Token/turn metrics are deterministic
// (or near so); latency metrics are noisy and the whole reason we take N.
export const METRICS = [
  'ttftMs', 'wallMs', 'genMs',
  'inputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens',
  'costUsd', 'claudeApiMs', 'claudeDurationMs', 'numTurns',
];

export function summarizeSamples(samples) {
  const out = {};
  for (const m of METRICS) {
    out[m] = summarize(samples
      .map((s) => s[m])
      .filter((v) => typeof v === 'number' && Number.isFinite(v)));
  }
  return out;
}

// Run `measureFn(i)` n times sequentially (sequential is REQUIRED — concurrent
// real calls would contend for CPU/network and distort the very latency we are
// measuring) and bundle the per-metric summary.
export async function runSamples(label, measureFn, n) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(await measureFn(i));
  return { label, n, samples, stats: summarizeSamples(samples) };
}

function fmt(v, dp = 1) {
  return v == null ? '—' : Number(v).toFixed(dp);
}

// Render one metric across conditions as a fixed-width median/p95/stdev table.
export function formatTable(results, metric, unit = '') {
  const head = `${'condition'.padEnd(26)} ${'median'.padStart(11)} ${'p95'.padStart(11)} `
    + `${'stdev'.padStart(10)} ${'n'.padStart(4)}`;
  const lines = [unit ? `[${metric} / ${unit}]` : `[${metric}]`, head];
  for (const r of results) {
    const s = (r.stats && r.stats[metric]) || {};
    lines.push(`${String(r.label).padEnd(26)} ${fmt(s.median).padStart(11)} `
      + `${fmt(s.p95).padStart(11)} ${fmt(s.stdev).padStart(10)} ${String(s.n ?? 0).padStart(4)}`);
  }
  return lines.join('\n');
}

export { extractTextDelta };
