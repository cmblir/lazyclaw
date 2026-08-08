#!/usr/bin/env node
// Detached worker for `pompos loop --detach`.
//
// Invoked by the parent CLI with the same provider/model the parent
// resolved, plus a loop id pointing at the state directory the parent
// pre-created. Streams nothing to stdout — we are headless. Every
// iteration's outcome lands in iterations.log, and the final disposition
// lands in result.json + meta.status. SIGTERM flips status to `killed`
// and unwinds cleanly so a follow-up SIGKILL is rarely needed.
//
// Argv contract (all required except --until / --session-existing):
//   --loop-id <id>
//   --prompt <text>
//   --max <N>
//   --provider <name>
//   --until <regex>
//   --session-existing <id>      reuse the named chat session
//   --cfg-dir <path>             override POMPOS_CONFIG_DIR
//   --model <name>               provider-specific model name
//
// LC_FAIL_AT_ITER=<N> is honored as a test hook: exits with code 7 just
// before iteration N's provider call. Used by phase 2 spec to assert
// the `failed` meta status path.

// Standalone entrypoint: cli.mjs's boot never runs here, so mirror the
// POMPOS_*/POMPOS_* prefixes ourselves before anything reads them.
import '../lib/env_compat_boot.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = v;
        i++;
      }
    } else {
      out._.push(t);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const loopId = args['loop-id'];
if (!loopId) {
  process.stderr.write('loop-worker: --loop-id required\n');
  process.exit(2);
}

if (args['cfg-dir']) {
  process.env.POMPOS_CONFIG_DIR = args['cfg-dir'];
}

const loops = await import(path.join(REPO_ROOT, 'loops.mjs'));
const sessions = await import(path.join(REPO_ROOT, 'sessions.mjs'));
const loopEngine = await import(path.join(REPO_ROOT, 'loop-engine.mjs'));
const registryUrl = path.join(REPO_ROOT, 'providers', 'registry.mjs');
const { PROVIDERS } = await import(registryUrl);
const { readConfig, _resolveAuthKey } = await import(path.join(REPO_ROOT, 'lib', 'config.mjs'));

const cfgDir = process.env.POMPOS_CONFIG_DIR || loops.defaultConfigDir();
const sessionId = args['session-existing'] || `loop:${loopId}`;

// Resolve the auth key the SAME way the foreground loop does — the worker used
// process.env.POMPOS_API_KEY||'' and so failed auth against anthropic/openai.
const cfg = readConfig();

const provName = args.provider || 'mock';
const prov = PROVIDERS[provName];
if (!prov) {
  loops.patchMeta(loopId, { status: 'failed', finishedAt: new Date().toISOString() }, cfgDir);
  loops.writeResult(loopId, { error: `unknown provider: ${provName}` }, cfgDir);
  process.exit(2);
}

const until = args.until ? loopEngine.compileUntil(args.until) : null;
const max = Number(args.max) || loopEngine.LOOP_MAX_DEFAULT;

// Initial meta — pid was filled by parent. We update startedAt here so
// the timestamp reflects when the worker actually started executing, not
// when the parent forked us.
loops.patchMeta(loopId, { status: 'running', startedAt: new Date().toISOString() }, cfgDir);

const ac = new AbortController();
// When a signal arrives, onTerm writes the authoritative 'killed' result and
// owns the exit. `terminating` stops the normal-completion path (which the
// aborted runLoop returns into within the same ~50ms window) from racing a
// second writeResult onto the same file.
let terminating = false;
function onTerm(sig) {
  terminating = true;
  ac.abort();
  loops.patchMeta(loopId, { status: 'killed', finishedAt: new Date().toISOString(), signal: sig }, cfgDir);
  loops.writeResult(loopId, { stoppedBy: 'kill', signal: sig }, cfgDir);
  // Give the in-flight stream a moment to unwind before we exit.
  setTimeout(() => process.exit(143), 50);
}
process.on('SIGTERM', () => onTerm('SIGTERM'));
process.on('SIGINT', () => onTerm('SIGINT'));

const failAtIter = Number(process.env.LC_FAIL_AT_ITER) || 0;
let iterCounter = 0;

async function sendOnce(messages, signal) {
  iterCounter++;
  if (failAtIter && iterCounter === failAtIter) {
    process.exit(7);
  }
  let acc = '';
  for await (const chunk of prov.sendMessage(messages, {
    apiKey: _resolveAuthKey(cfg, provName),
    model: args.model,
    signal,
  })) {
    acc += chunk;
  }
  return acc;
}

const messages = [];
// Hydrate prior turns if reusing an existing session — the engine appends
// every successful pair, so resume semantics line up with `/loop` in REPL.
if (sessionId && sessions.sessionPath) {
  try {
    const prior = sessions.loadTurns(sessionId, cfgDir);
    for (const t of prior) messages.push({ role: t.role, content: t.content });
  } catch { /* fresh session */ }
}

const persist = (role, content) => {
  try { sessions.appendTurn(sessionId, role, content, cfgDir); }
  catch { /* surface via result.json on failure */ }
};

const onIteration = ({ i, max: m, reply }) => {
  loops.appendIteration(loopId, {
    iteration: i,
    of: m,
    bytes: reply.length,
    preview: reply.slice(0, 200),
  }, cfgDir);
};

// Honour --use-memory / --recall exactly like the foreground loop: rebuild a
// system message from core/recall memory before each iteration. The detach
// path forwards the flags now (buildDetachArgv); without this the worker would
// see them and still ignore them.
const memMod = (args['use-memory'] || args.recall) ? await import(path.join(REPO_ROOT, 'memory.mjs')) : null;
const buildSystem = memMod ? (() => {
  const parts = [];
  if (args['use-memory']) {
    const core = memMod.loadCore(cfgDir);
    if (core && core.trim()) parts.push(core);
  }
  if (args.recall) {
    const text = memMod.recall(String(args.recall), { topN: 3 }, cfgDir);
    if (text && text.trim()) parts.push(text);
  }
  return parts.join('\n\n---\n\n');
}) : null;

try {
  const result = await loopEngine.runLoop({
    prompt: args.prompt || '',
    max,
    until,
    messages,
    sendOnce,
    persist,
    onIteration,
    signal: ac.signal,
    buildSystem,
  });
  if (!terminating) {
    const finalStatus = result.stoppedBy === 'abort' ? 'killed' : 'completed';
    loops.patchMeta(loopId, { status: finalStatus, finishedAt: new Date().toISOString() }, cfgDir);
    loops.writeResult(loopId, result, cfgDir);
    process.exit(0);
  }
  // else: a signal is terminating us — onTerm wrote the result and owns exit.
} catch (err) {
  if (!terminating) {
    loops.patchMeta(loopId, { status: 'failed', finishedAt: new Date().toISOString() }, cfgDir);
    loops.writeResult(loopId, { error: err?.message || String(err), stack: err?.stack }, cfgDir);
    process.exit(1);
  }
}
