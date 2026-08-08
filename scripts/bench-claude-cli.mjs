#!/usr/bin/env node
// Multi-sample latency/token benchmark for the `claude` CLI provider path.
//
// WHY this exists: a single end-to-end turn is ~3-5s and DOMINATED by model
// generation + network (±2s of run-to-run noise), so one sample cannot isolate
// pompos's own overhead — single-sample comparisons came out noise-dominated
// (lean even looked slower than non-lean once, which was pure noise). Per the
// engineering directives (§9 "measure, don't guess; record before/after") and
// the perf methodology note, every reported latency is median + p95 + stdev
// over N runs, and we separate the model round-trip (claude's self-reported
// duration_api_ms) from the pompos + Claude-Code-harness overhead (external
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

// Standalone entrypoint: cli.mjs's boot never runs here, so mirror the
// POMPOS_*/POMPOS_* prefixes ourselves before anything reads them.
import '../lib/env_compat_boot.mjs';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summarize, median, stdev } from './bench-stats.mjs';
import { buildArgs } from '../providers/claude_cli.mjs';
import { getSession, _resetSessions } from '../providers/claude_cli_session.mjs';

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
// Fold one stream-json line into the running measurement state. Shared by the
// per-chunk loop AND the post-EOF trailing-buffer drain so a final result line
// without a newline is not lost (the production provider drains too). Token
// usage is ACCUMULATED across every `assistant` event, so a multi-turn agentic
// loop reports the loop's cumulative token cost, not just its last turn.
function _foldLine(line, s, t0, now) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  const text = extractTextDelta(obj);
  if (text) {
    if (s.ttftMs === null) s.ttftMs = now() - t0;
    s.textLen += text.length;
  }
  if (obj.type === 'assistant' && obj.message && obj.message.usage) {
    const u = obj.message.usage;
    s.inputTokens += (u.input_tokens || 0);
    s.cacheCreationTokens += (u.cache_creation_input_tokens || 0);
    s.cacheReadTokens += (u.cache_read_input_tokens || 0);
    s.outputTokens += (u.output_tokens || 0);
    s.sawAssistant = true;
  }
  if (obj.type === 'result') s.result = obj;
}

export async function measureStream(chunks, now = () => performance.now()) {
  const t0 = now();
  const s = {
    ttftMs: null, textLen: 0, sawAssistant: false, result: null,
    inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0,
  };
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) _foldLine(line, s, t0, now);
    }
  }
  if (buffer.trim()) _foldLine(buffer.trim(), s, t0, now);   // drain the un-terminated tail
  const wallMs = now() - t0;
  const ttft = s.ttftMs == null ? wallMs : s.ttftMs;   // nothing streamed -> TTFT == wall
  const r = s.result;
  return {
    ttftMs: ttft,
    wallMs,
    genMs: wallMs - ttft,
    textLen: s.textLen,
    inputTokens: s.sawAssistant ? s.inputTokens : null,
    cacheCreationTokens: s.sawAssistant ? s.cacheCreationTokens : null,
    cacheReadTokens: s.sawAssistant ? s.cacheReadTokens : null,
    outputTokens: s.sawAssistant ? s.outputTokens : null,
    costUsd: r ? (r.total_cost_usd || 0) : null,
    claudeDurationMs: r && r.duration_ms != null ? r.duration_ms : null,
    claudeApiMs: r && r.duration_api_ms != null ? r.duration_api_ms : null,
    numTurns: r && r.num_turns != null ? r.num_turns : null,
    isError: r ? !!r.is_error : null,
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
  const failures = [];
  for (let i = 0; i < n; i++) {
    let rec;
    try { rec = await measureFn(i); }
    catch (e) { failures.push({ i, error: String((e && e.message) || e) }); continue; }
    // A timed-out (killed) call is not a valid latency sample — its wall is just
    // the timeout, which would poison the median; drop it but count it. An
    // is_error result (e.g. bounded hit its turn cap) IS a real measurement and
    // stays in the stats.
    // Drop a timed-out call ONLY if it was killed before completing (no result
    // captured). If the timer merely raced a clean finish, keep the sample so
    // the kept set is not biased toward fast runs (survivorship at the tail).
    if (rec && rec.timedOut && rec.numTurns == null) { failures.push({ i, timedOut: true }); continue; }
    samples.push(rec);
  }
  const errors = samples.filter((s) => s && s.isError).length;
  return { label, n, samples, failures, errors, stats: summarizeSamples(samples) };
}

function fmt(v, dp = 1) {
  return (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(dp);
}

// Render one metric across conditions as a fixed-width median/p95/stdev table.
// dp controls decimals (cost needs 4; ms/tokens read fine at 1).
export function formatTable(results, metric, unit = '', dp = 1) {
  const head = `${'condition'.padEnd(26)} ${'median'.padStart(11)} ${'p95'.padStart(11)} `
    + `${'stdev'.padStart(10)} ${'n'.padStart(4)}`;
  const lines = [unit ? `[${metric} / ${unit}]` : `[${metric}]`, head];
  for (const r of results) {
    const s = (r.stats && r.stats[metric]) || {};
    const n = s.n ?? 0;
    const p95 = n >= 10 ? s.p95 : null;   // type-7 p95 collapses toward max for small n
    const sd = n >= 2 ? s.stdev : null;   // sample stdev is undefined for n<2
    lines.push(`${String(r.label).padEnd(26)} ${fmt(s.median, dp).padStart(11)} `
      + `${fmt(p95, dp).padStart(11)} ${fmt(sd, dp).padStart(10)} ${String(n).padStart(4)}`);
  }
  return lines.join('\n');
}

// Per-sample (external wall − claude's self-reported API round-trip) over the
// samples where BOTH are finite: the non-API residual (process spawn + Claude
// Code boot + MCP + stream parse + teardown). A median of PAIRED deltas, not a
// difference of two independently-computed medians, and it can be negative
// (duration_api_ms can exceed external wall in multi-turn runs) — reported with
// its sign, not hidden. Meaningful only for single-turn conditions.
export function pairedResidual(samples) {
  const deltas = (samples || [])
    .filter((s) => Number.isFinite(s.wallMs) && Number.isFinite(s.claudeApiMs))
    .map((s) => s.wallMs - s.claudeApiMs);
  return { n: deltas.length, median: deltas.length ? median(deltas) : null, stdev: stdev(deltas) };
}

// Measure the PERSISTENT-session path. The warm session yields plain text
// chunks (not raw stream-json) and surfaces usage via an onUsage callback, so
// here latency comes from chunk arrival and tokens from the callback. (The
// session's onUsage reads result.usage, which the live CLI reports as zero
// under streaming — so persistent token figures are not the truthful per-turn
// usage; that win is captured on the one-shot path. Persistent is about the
// boot-amortization LATENCY: turn 1 cold-boots the harness, turn 2 is warm.)
export async function measureTextStream(run, now = () => performance.now()) {
  const t0 = now();
  let ttftMs = null;
  let textLen = 0;
  let usage = null;
  for await (const chunk of run((u) => { usage = u; })) {
    if (ttftMs === null) ttftMs = now() - t0;
    textLen += String(chunk).length;
  }
  const wallMs = now() - t0;
  const ttft = ttftMs == null ? wallMs : ttftMs;
  return {
    ttftMs: ttft,
    wallMs,
    genMs: wallMs - ttft,
    textLen,
    inputTokens: usage ? (usage.inputTokens ?? null) : null,
    outputTokens: usage ? (usage.outputTokens ?? null) : null,
    costUsd: usage ? (usage.totalCostUsd ?? null) : null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    claudeApiMs: null,
    claudeDurationMs: null,
    numTurns: null,
    isError: null,
  };
}

// Spawn `claude` (or a fake) with a given argv and measure one one-shot turn.
// stdin is IGNORED — exactly like providers/claude_cli.mjs — so we never incur
// the CLI's ~3s "no stdin data received" wait, which a shell pipe would add and
// which is NOT part of the real provider path.
export async function spawnAndMeasure({ bin, args, cwd, now, timeoutMs }) {
  const proc = spawn(bin, args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.setEncoding('utf8');
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr += d; });
  let spawnErr = null;
  proc.once('error', (e) => { spawnErr = e; });
  // A non-lean spawn boots the user's whole Claude Code env (incl. every MCP
  // server) and can wedge; SIGKILL it after timeoutMs so a reproducible run can
  // never hang. The killed sample is flagged and dropped from the stats.
  let timedOut = false;
  let timer = null;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
  }
  const rec = await measureStream(proc.stdout, now);   // ends on EOF (incl. after a kill)
  if (timer) clearTimeout(timer);
  // stdout EOF'd. Wait briefly for a clean exit; if the child wedged (closed
  // stdout but kept running), SIGTERM then SIGKILL rather than await 'close'
  // forever — the production provider keeps the same finally-kill safety net.
  await new Promise((res) => {
    if (proc.exitCode != null || spawnErr) return res();
    let term;
    let kill;
    const done = () => { clearTimeout(term); clearTimeout(kill); res(); };
    term = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } }, 800);
    kill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } done(); }, 2500);
    proc.once('close', done);
  });
  if (spawnErr && !timedOut) throw spawnErr;
  rec.timedOut = timedOut;
  rec.stderrTail = stderr.slice(-200);
  return rec;
}

// The bounded/unbounded conditions share a toolset and a tool-inducing prompt;
// only the --max-turns cap differs, so the difference in wall time / num_turns
// is the bounded-loop fix in isolation (not a tool-vs-no-tool artifact).
// Read-only tools only: the unbounded condition runs an autonomous loop of up
// to UNBOUNDED_TURNS turns in the user's repo, so least-privilege says no Bash.
export const TOOLSET = 'Read,Grep,Glob';
export const UNBOUNDED_TURNS = 12;

// Build the one-shot argv for a named condition by delegating to the provider's
// own buildArgs(), so we measure EXACTLY the argv pompos would run.
export function oneShotArgs(name, prompt, model) {
  const base = { model };
  switch (name) {
    case 'lean':      return buildArgs(prompt, base);
    case 'nonlean':   return buildArgs(prompt, { ...base, lean: false });
    case 'bounded':   return buildArgs(prompt, { ...base, maxTurns: 1, tools: TOOLSET });
    case 'unbounded': return buildArgs(prompt, { ...base, maxTurns: UNBOUNDED_TURNS, tools: TOOLSET });
    default: throw new Error(`unknown one-shot condition: ${name}`);
  }
}

export { extractTextDelta };

// ───────────────────────────── live runner (script-guarded) ────────────────
// Spawns the REAL `claude` and is subscription-billed; never runs on import.

function envInt(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const REPORT_METRICS = [
  ['wallMs', 'ms (external wall: spawn+boot+model+parse)', 1],
  ['ttftMs', 'ms (time to first streamed token)', 1],
  ['genMs', 'ms (first token -> done)', 1],
  ['claudeApiMs', 'ms (claude self-reported API round-trip; single-turn = one trip)', 1],
  ['inputTokens', 'tokens (uncached input, summed over turns)', 1],
  ['cacheCreationTokens', 'tokens (cache creation — first-turn context write)', 1],
  ['cacheReadTokens', 'tokens (cache read — context re-sent each turn)', 1],
  ['outputTokens', 'tokens', 1],
  ['numTurns', 'turns (cumulative; the bounded-loop signal)', 1],
  ['costUsd', 'usd (cumulative over the turn/loop)', 4],
];

function residualTable(results) {
  const lines = [
    '[non-API residual: per-sample median(wall - claudeApiMs) = spawn+boot+MCP+parse+teardown]',
    '(meaningful for SINGLE-turn rows; for multi-turn, api aggregates across turns and may exceed wall)',
    `${'condition'.padEnd(26)} ${'residual'.padStart(11)} ${'stdev'.padStart(10)} ${'paired n'.padStart(9)}`,
  ];
  for (const r of results) {
    const pr = pairedResidual(r.samples || []);
    const note = (pr.median != null && pr.median < 0) ? '  (api>wall: not a clean residual)' : '';
    lines.push(`${String(r.label).padEnd(26)} ${fmt(pr.median).padStart(11)} `
      + `${fmt(pr.stdev).padStart(10)} ${String(pr.n).padStart(9)}${note}`);
  }
  return lines.join('\n');
}

function healthTable(results) {
  const lines = [
    '[sample health]   (dropped = timed-out-before-completion or spawn error; is_error = a real but failed turn, e.g. bounded hitting its cap)',
    `${'condition'.padEnd(26)} ${'ok'.padStart(4)} ${'dropped'.padStart(8)} ${'is_error'.padStart(9)}`,
  ];
  for (const r of results) {
    lines.push(`${String(r.label).padEnd(26)} ${String(r.samples?.length ?? 0).padStart(4)} `
      + `${String(r.failures?.length ?? 0).padStart(8)} ${String(r.errors ?? 0).padStart(9)}`);
  }
  return lines.join('\n');
}

function printReport(meta, results) {
  const out = ['# claude-cli benchmark — median / p95 / stdev over N samples', JSON.stringify(meta)];
  for (const [metric, unit, dp] of REPORT_METRICS) out.push('', formatTable(results, metric, unit, dp));
  out.push('', residualTable(results), '', healthTable(results));
  process.stdout.write(out.join('\n') + '\n');
}

async function runOneShots(ctx, results) {
  const { bin, model, prompt, toolPrompt, N, N_UNBOUNDED, WARMUP, want, log, writeOut } = ctx;
  const specs = [
    { name: 'lean', label: 'lean one-shot', prompt, n: N },
    { name: 'nonlean', label: 'non-lean one-shot', prompt, n: N },
    { name: 'bounded', label: 'bounded(maxturns1)+tools', prompt: toolPrompt, n: N },
    { name: 'unbounded', label: `unbounded(maxturns${UNBOUNDED_TURNS})+tools`, prompt: toolPrompt, n: N_UNBOUNDED },
  ];
  for (const c of specs) {
    if (!want(c.name)) continue;
    const args = oneShotArgs(c.name, c.prompt, model);
    const timeoutMs = c.name === 'unbounded' ? ctx.unboundedTimeoutMs : ctx.oneShotTimeoutMs;
    if (WARMUP) {
      log(`${c.name}: warmup`);
      try { await spawnAndMeasure({ bin, args, timeoutMs }); } catch (e) { log(`${c.name}: warmup err ${e.message}`); }
    }
    const res = await runSamples(c.label, async (i) => {
      log(`${c.name}: sample ${i + 1}/${c.n}`);
      return spawnAndMeasure({ bin, args, timeoutMs });
    }, c.n);
    results.push({ ...res, condition: c.name });
    writeOut();
  }
}

async function runPersistent(ctx, results) {
  const { bin, model, prompt, N, WARMUP, want, log, writeOut } = ctx;
  if (!want('persistent')) return;
  const t1 = [];
  const t2 = [];
  const total = WARMUP ? N + 1 : N;
  for (let i = 0; i < total; i++) {
    const warm = WARMUP && i === 0;
    log(`persistent: session ${i + 1}/${total}${warm ? ' (warmup, discarded)' : ''}`);
    _resetSessions();
    const session = getSession(`bench-${i}`, { bin, model, lean: true });
    const r1 = await measureTextStream((onUsage) => session.send(prompt, { onUsage }));
    const r2 = await measureTextStream((onUsage) => session.send(prompt, { onUsage }));
    session.close();
    if (warm) continue;
    t1.push(r1);
    t2.push(r2);
  }
  results.push({ label: 'persistent turn 1 (cold boot)', condition: 'persistent-turn1', n: t1.length, samples: t1, stats: summarizeSamples(t1) });
  results.push({ label: 'persistent turn 2 (warm)', condition: 'persistent-turn2', n: t2.length, samples: t2, stats: summarizeSamples(t2) });
  writeOut();
}

async function main() {
  const only = (process.env.CONDITIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ctx = {
    bin: process.env.BIN || process.env.POMPOS_CLAUDE_BIN || 'claude',
    model: process.env.MODEL || '',
    prompt: process.env.PROMPT || 'Reply with exactly the single word: ok',
    toolPrompt: process.env.TOOL_PROMPT
      || 'Using only your read-only tools, find the three largest .mjs files under the providers/ directory and briefly summarize what each one does.',
    N: envInt('N', 10),
    N_UNBOUNDED: envInt('N_UNBOUNDED', 3),
    WARMUP: process.env.WARMUP === '0' ? 0 : 1,
    oneShotTimeoutMs: envInt('ONESHOT_TIMEOUT_MS', 90000),
    unboundedTimeoutMs: envInt('UNBOUNDED_TIMEOUT_MS', 240000),
    out: process.env.OUT || null,
    want: (name) => only.length === 0 || only.includes(name),
    log: (m) => process.stderr.write(`[bench] ${m}\n`),
  };
  const meta = {
    bin: ctx.bin, model: ctx.model || '(account default)', N: ctx.N, N_UNBOUNDED: ctx.N_UNBOUNDED,
    warmup: ctx.WARMUP, oneShotTimeoutMs: ctx.oneShotTimeoutMs, unboundedTimeoutMs: ctx.unboundedTimeoutMs,
    node: process.version, platform: `${process.platform}-${process.arch}`,
    prompt: ctx.prompt, toolPrompt: ctx.toolPrompt,
  };
  const results = [];
  ctx.writeOut = () => { if (ctx.out) fs.writeFileSync(ctx.out, JSON.stringify({ meta, results }, null, 2)); };

  await runOneShots(ctx, results);
  await runPersistent(ctx, results);
  printReport(meta, results);
  ctx.writeOut();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => { process.stderr.write(`${e && e.stack ? e.stack : e}\n`); process.exit(1); });
}
