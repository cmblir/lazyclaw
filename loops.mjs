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
import os from 'node:os';
import crypto from 'node:crypto';

const LOOPS_DIRNAME = 'loops';

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function loopsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, LOOPS_DIRNAME);
}

export function loopDir(loopId, configDir = defaultConfigDir()) {
  if (!loopId || /[/\\]/.test(loopId) || loopId === '.' || loopId === '..') {
    throw new Error(`invalid loop id: ${loopId}`);
  }
  return path.join(loopsDir(configDir), loopId);
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
