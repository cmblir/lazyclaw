// Per-task audit log for every tool call an agent makes.
//
// Records appended one JSON object per line to
// <configDir>/tasks/<id>.audit.jsonl. Stores hashes of the args and
// result so a runaway agent can't blow the disk with verbose tool I/O,
// while still giving operators something to grep against when they need
// forensics. Set LAZYCLAW_AUDIT_RAW=1 to additionally inline the raw
// args/result bodies — useful in development, off by default.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export class AuditError extends Error {
  constructor(message) { super(message); this.name = 'AuditError'; }
}

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.pompos');
}

export function auditPath(taskId, configDir = defaultConfigDir()) {
  if (!taskId || typeof taskId !== 'string') throw new AuditError('taskId required');
  return path.join(configDir, 'tasks', `${taskId}.audit.jsonl`);
}

function hashJson(obj) {
  const s = (obj === undefined) ? '' : JSON.stringify(obj);
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function append({ taskId, agent, tool, args, result, ok = true, configDir = defaultConfigDir() } = {}) {
  if (!taskId) return;  // skip silently when called outside a task scope (Phase 12a unit tests)
  const file = auditPath(taskId, configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    agent: agent || 'unknown',
    tool,
    args_hash: hashJson(args),
    result_hash: hashJson(result),
    ok: !!ok,
  };
  if (process.env.LAZYCLAW_AUDIT_RAW === '1') {
    entry.args = args;
    entry.result = result;
  }
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function read(taskId, configDir = defaultConfigDir()) {
  const file = auditPath(taskId, configDir);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}
