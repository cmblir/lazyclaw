// Persistent state and helpers for `lazyclaw loop` runs.
//
// Storage layout under <configDir>/loops/<loopId>/:
//   meta.json        — { prompt, max, until, sessionId, pid, pgid?, status,
//                        startedAt, finishedAt?, provider, model }
//   iterations.log   — newline-delimited iteration summaries (one per turn)
//   result.json      — final outcome ({ stoppedBy, iterations, lastReply,
//                                       error?, exitCode? }) on completion
//
// Status transitions:
//   running -> completed | killed | failed | budget_exhausted
//
// Why three files instead of one:
//   - meta.json mutates with the status field; iterations.log is append-only;
//     result.json is written exactly once. Keeping them separate avoids
//     read-modify-write contention between the worker (appending iter logs)
//     and any reader (`lazyclaw loops show <id>`) running concurrently.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultConfigDir } from './lib/config_dir.mjs';
import { acquire as acquireSingleton } from './lib/run_singleton.mjs';

export { defaultConfigDir };

const LOOPS_DIRNAME = 'loops';
const LOOP_LOCKS_DIRNAME = '.locks';

export function loopsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, LOOPS_DIRNAME);
}

export function loopDir(loopId, configDir = defaultConfigDir()) {
  if (!loopId || /[/\\]/.test(loopId) || loopId === '.' || loopId === '..') {
    throw new Error(`invalid loop id: ${loopId}`);
  }
  return path.join(loopsDir(configDir), loopId);
}

// Directory holding per-loop cross-process lockfiles. Kept outside the
// per-loop <id>/ dirs so a stray `.lock` never looks like a loop run to
// listLoops(), which enumerates loopsDir() subdirectories.
export function loopLocksDir(configDir = defaultConfigDir()) {
  return path.join(loopsDir(configDir), LOOP_LOCKS_DIRNAME);
}

// Cross-process per-name singleton lock for a loop run. A slow `--detach`
// loop still running when the next scheduled fire arrives is a SEPARATE
// process; this SKIPs the new fire (default overlap policy) instead of
// letting two workers write the same session. Additive + opt-in — nothing
// calls it unless a call site chooses to. Releases in finally.
export async function withLoopLock(lockName, fn, { configDir = defaultConfigDir(), ttlMs, now, pid } = {}) {
  const lk = acquireSingleton(lockName, { dir: loopLocksDir(configDir), ttlMs, now, pid });
  if (!lk.acquired) return { skipped: true, holder: lk.holder || null };
  try {
    const result = await fn();
    return { skipped: false, result, stolen: lk.stolen };
  } finally {
    lk.release();
  }
}

export function newLoopId() {
  // ISO timestamp (filesystem-safe) + 6 random hex chars. Sorts
  // chronologically and avoids collisions across rapid `--detach` invocations.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${ts}-${suffix}`;
}

export function writeMeta(loopId, meta, configDir = defaultConfigDir()) {
  const dir = loopDir(loopId, configDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.meta.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, path.join(dir, 'meta.json'));
}

export function readMeta(loopId, configDir = defaultConfigDir()) {
  const dir = loopDir(loopId, configDir);
  const p = path.join(dir, 'meta.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function patchMeta(loopId, patch, configDir = defaultConfigDir()) {
  const cur = readMeta(loopId, configDir) || {};
  writeMeta(loopId, { ...cur, ...patch }, configDir);
}

export function appendIteration(loopId, entry, configDir = defaultConfigDir()) {
  const dir = loopDir(loopId, configDir);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
  fs.appendFileSync(path.join(dir, 'iterations.log'), line);
}

export function readIterations(loopId, configDir = defaultConfigDir()) {
  const p = path.join(loopDir(loopId, configDir), 'iterations.log');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

export function writeResult(loopId, result, configDir = defaultConfigDir()) {
  const dir = loopDir(loopId, configDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.result.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, path.join(dir, 'result.json'));
}

export function readResult(loopId, configDir = defaultConfigDir()) {
  const p = path.join(loopDir(loopId, configDir), 'result.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function listLoops(configDir = defaultConfigDir()) {
  const dir = loopsDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const meta = readMeta(ent.name, configDir);
    if (!meta) continue;
    out.push({ id: ent.name, ...meta });
  }
  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return out;
}

// Inspect a meta record and decide whether the worker is still alive.
// We don't kill or reap; just synthesize a more truthful status field
// for `loops list` / `loops show` after the process has gone away.
export function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

export function reconcileStatus(meta) {
  if (!meta) return meta;
  if (meta.status === 'running' && !isProcessAlive(meta.pid)) {
    // Worker exited without flipping the status. Most likely a crash
    // before the SIGTERM handler / finally block could update meta.
    return { ...meta, status: 'failed' };
  }
  return meta;
}

// Structured stop signal for a loop iteration. When an agentic loop turn
// runs the `finish` control tool (mas/tools/control.mjs), that is a
// first-class "we're done" signal — more robust than the `--until` regex on
// the reply text, which a paraphrase or code-fenced marker can defeat.
//
// Returns { control:'finish', summary } | null. Additive + opt-in: callers
// that don't pass a tool-call-bearing turn result get null and fall back to
// the existing --until / --max stop conditions unchanged (byte-stable).
export function detectControlStop(turnResult) {
  const calls = turnResult && Array.isArray(turnResult.toolCalls) ? turnResult.toolCalls : [];
  for (const c of calls) {
    const r = c && c.result;
    if (r && r.ok === true && r.control === 'finish') {
      return { control: 'finish', summary: r.summary || '' };
    }
  }
  return null;
}
