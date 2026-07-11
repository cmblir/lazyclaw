// Persistent goal registry for `/goal` REPL command and `lazyclaw goal`
// subcommand.
//
// Storage layout under <configDir>/goals/<name>.json. One file per goal so
// concurrent `close` / `tick` writes don't race over a global index. The
// canonical field set lives in `defaultShape()` below; new fields default
// to null/empty so reading an older record stays forward-compatible.
//
// The name validator is delegated to cron.ensureValidName — the spec
// requires identical error wording so a fat-finger like `/goal add "has
// spaces"` produces the same message a user already knows from `cron add`.

import fs from 'node:fs';
import path from 'node:path';
import { ensureValidName as cronEnsureValidName } from './cron.mjs';
import { defaultConfigDir, withKeyedLockSync } from './lib/config_dir.mjs';
import { acquire as acquireSingleton } from './lib/run_singleton.mjs';

export { defaultConfigDir };

const GOALS_DIRNAME = 'goals';
const GOAL_LOCKS_DIRNAME = '.locks';

export class GoalError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GoalError';
    this.code = code || 'GOAL_ERR';
  }
}

export function goalsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, GOALS_DIRNAME);
}

export function goalPath(name, configDir = defaultConfigDir()) {
  ensureValidName(name);
  return path.join(goalsDir(configDir), `${name}.json`);
}

export function ensureValidName(name) {
  try { cronEnsureValidName(name); }
  catch (e) { throw new GoalError(e.message, 'GOAL_BAD_NAME'); }
}

// Directory holding per-goal cross-process lockfiles. Separate from the goal
// JSON files so a stray `.lock` never looks like a goal to listGoals().
export function goalLocksDir(configDir = defaultConfigDir()) {
  return path.join(goalsDir(configDir), GOAL_LOCKS_DIRNAME);
}

// Cross-process per-goal singleton lock. Distinct from withKeyedLockSync,
// which only serializes writers inside ONE process: a slow scheduled `goal
// tick` and a manual `goal tick` are SEPARATE processes that both open the
// same goal:<name> session and appendCheckIn. This guards that case.
//
// Overlap policy is SKIP (default): when a live holder owns the lock, `fn` is
// NOT run and { skipped:true, holder } is returned. Additive + opt-in —
// nothing calls this unless a call site chooses to. Releases in finally.
export async function withGoalLock(name, fn, { configDir = defaultConfigDir(), ttlMs, now, pid } = {}) {
  ensureValidName(name);
  const lk = acquireSingleton(name, { dir: goalLocksDir(configDir), ttlMs, now, pid });
  if (!lk.acquired) return { skipped: true, holder: lk.holder || null };
  try {
    const result = await fn();
    return { skipped: false, result, stolen: lk.stolen };
  } finally {
    lk.release();
  }
}

function defaultShape(name) {
  return {
    name,
    description: '',
    createdAt: new Date().toISOString(),
    status: 'active',
    schedule: null,
    channels: [],
    sessionId: `goal:${name}`,
    checkIns: [],
    memoryPath: null,
  };
}

function writeAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

export function registerGoal({ name, description = '', schedule = null, channels = [] } = {}, configDir = defaultConfigDir()) {
  ensureValidName(name);
  const p = goalPath(name, configDir);
  if (fs.existsSync(p)) {
    throw new GoalError(`goal "${name}" already exists`, 'GOAL_EXISTS');
  }
  const data = {
    ...defaultShape(name),
    description,
    schedule,
    channels: Array.isArray(channels) ? channels : [],
  };
  writeAtomic(p, data);
  return data;
}

export function getGoal(name, configDir = defaultConfigDir()) {
  let p;
  try { p = goalPath(name, configDir); }
  catch { return null; }
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function listGoals(configDir = defaultConfigDir()) {
  const dir = goalsDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const g = getGoal(name, configDir);
    if (g) out.push(g);
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out;
}

export function patchGoal(name, patch, configDir = defaultConfigDir()) {
  // Serialize the read-modify-write per goal so two same-process writers don't
  // lost-update. Keyed by the on-disk path. See lib/config_dir.mjs.
  return withKeyedLockSync(goalPath(name, configDir), () => {
    const g = getGoal(name, configDir);
    if (!g) throw new GoalError(`no goal "${name}"`, 'GOAL_NO_GOAL');
    const next = { ...g, ...patch };
    writeAtomic(goalPath(name, configDir), next);
    return next;
  });
}

export function closeGoal(name, outcome = 'done', configDir = defaultConfigDir()) {
  if (outcome !== 'done' && outcome !== 'abandoned') {
    throw new GoalError(`outcome must be done or abandoned, got "${outcome}"`, 'GOAL_BAD_OUTCOME');
  }
  return patchGoal(name, { status: outcome, closedAt: new Date().toISOString() }, configDir);
}

export function appendCheckIn(name, summary, configDir = defaultConfigDir()) {
  // Hold the per-goal lock across read+append+write so a concurrent writer
  // can't clobber the appended check-in.
  return withKeyedLockSync(goalPath(name, configDir), () => {
    const g = getGoal(name, configDir);
    if (!g) throw new GoalError(`no goal "${name}"`, 'GOAL_NO_GOAL');
    const next = { ...g, checkIns: [...(g.checkIns || []), { at: new Date().toISOString(), summary }] };
    writeAtomic(goalPath(name, configDir), next);
    return next;
  });
}
