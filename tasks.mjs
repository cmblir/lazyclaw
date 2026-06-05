// Persistent task registry for `/task` REPL command and `lazyclaw task`
// subcommand. Backs the Phase 11 piece of docs/multi-agent.md.
//
// One file per task under <configDir>/tasks/<id>.json. Tasks are the
// unit of work: a title, a description, an owning team, a lead, and a
// (channel, threadTs) pair pointing at the Slack thread that hosts the
// conversation. The `turns` array grows over time as agents take turns
// in the thread; Phase 11 only seeds it with the kickoff turn, Phases
// 13+ extend it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getTeam } from './teams.mjs';

const TASKS_DIRNAME = 'tasks';
export const VALID_STATUSES = ['pending', 'running', 'done', 'failed', 'abandoned'];

export class TaskError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TaskError';
    this.code = code || 'TASK_ERR';
  }
}

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function tasksDir(configDir = defaultConfigDir()) {
  return path.join(configDir, TASKS_DIRNAME);
}

export function taskPath(id, configDir = defaultConfigDir()) {
  if (!isValidTaskId(id)) throw new TaskError(`bad task id "${id}"`, 'TASK_BAD_ID');
  return path.join(tasksDir(configDir), `${id}.json`);
}

// Task IDs are short, sortable, and filename-safe: t_<yyyymmdd>_<rand6>.
// Time-prefix makes a `ls`-sorted directory chronologically ordered,
// which is the natural order for a "recent tasks" dashboard view.
const ID_RE = /^t_\d{8}_[a-z0-9]{6}$/;

export function isValidTaskId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function newTaskId(now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `t_${yyyy}${mm}${dd}_${rand}`;
}

function defaultShape(id, now) {
  return {
    version: 1,
    id,
    title: '',
    description: '',
    team: '',
    lead: '',
    status: 'pending',
    slackChannel: '',
    slackThreadTs: '',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    turns: [],
  };
}

function writeAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

// Register a task. `team` (name) must already exist in the registry,
// and `lead` (agent name) must belong to that team. We do not check
// slackChannel here — the CLI does that at start time so we can fail
// fast before posting to Slack.
export function registerTask({ id, title, description = '', team, lead, slackChannel = '', slackThreadTs = '', status = 'pending', turns = [] } = {}, configDir = defaultConfigDir()) {
  if (!id) id = newTaskId();
  if (!isValidTaskId(id)) throw new TaskError(`bad task id "${id}"`, 'TASK_BAD_ID');
  if (!title || !String(title).trim()) {
    throw new TaskError('title is required', 'TASK_NO_TITLE');
  }
  const t = getTeam(team, configDir);
  if (!t) throw new TaskError(`team "${team}" is not registered`, 'TASK_NO_TEAM');
  const chosenLead = lead || t.lead;
  if (!t.agents.includes(chosenLead)) {
    throw new TaskError(`lead "${chosenLead}" is not in team "${team}" (agents=[${t.agents.join(', ')}])`, 'TASK_BAD_LEAD');
  }
  if (!VALID_STATUSES.includes(status)) {
    throw new TaskError(`bad status "${status}" — one of ${VALID_STATUSES.join(', ')}`, 'TASK_BAD_STATUS');
  }
  const p = taskPath(id, configDir);
  if (fs.existsSync(p)) {
    throw new TaskError(`task "${id}" already exists`, 'TASK_EXISTS');
  }
  const now = new Date();
  const data = {
    ...defaultShape(id, now),
    title: String(title),
    description: String(description || ''),
    team,
    lead: chosenLead,
    slackChannel: String(slackChannel || ''),
    slackThreadTs: String(slackThreadTs || ''),
    status,
    turns: Array.isArray(turns) ? turns : [],
  };
  writeAtomic(p, data);
  return data;
}

export function getTask(id, configDir = defaultConfigDir()) {
  let p;
  try { p = taskPath(id, configDir); }
  catch { return null; }
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function listTasks(configDir = defaultConfigDir()) {
  const dir = tasksDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const t = getTask(id, configDir);
    if (t) out.push(t);
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export function patchTask(id, patch, configDir = defaultConfigDir()) {
  const t = getTask(id, configDir);
  if (!t) throw new TaskError(`no task "${id}"`, 'TASK_NO_TASK');
  const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
  if (patch.status !== undefined && !VALID_STATUSES.includes(patch.status)) {
    throw new TaskError(`bad status "${patch.status}" — one of ${VALID_STATUSES.join(', ')}`, 'TASK_BAD_STATUS');
  }
  writeAtomic(taskPath(id, configDir), next);
  return next;
}

export function appendTurn(id, turn, configDir = defaultConfigDir()) {
  const t = getTask(id, configDir);
  if (!t) throw new TaskError(`no task "${id}"`, 'TASK_NO_TASK');
  const turns = Array.isArray(t.turns) ? [...t.turns, turn] : [turn];
  const next = patchTask(id, { turns }, configDir);
  // v5 Group A (M4): mirror the appended turn to the FTS5 sessions
  // index using session_id = `task:<id>` so the recall tool can surface
  // task transcripts the same way it surfaces chat sessions. Namespaced
  // with the `task:` prefix to avoid colliding with chat session ids.
  // Best-effort: any FTS failure stays inside the dynamic-import block
  // so a missing index_db (e.g. in a stripped test env) never breaks
  // task writes.
  try {
    void (async () => {
      try {
        const { indexSessionTurn } = await import('./mas/index_db.mjs');
        const turnIdx = turns.length - 1;
        indexSessionTurn({
          session_id: `task:${id}`,
          turn_idx: turnIdx,
          role: turn.agent === 'user' ? 'user' : 'assistant',
          ts: Date.parse(turn.ts) || Date.now(),
          content: turn.text || '',
        }, configDir);
      } catch { /* swallow */ }
    })();
  } catch { /* swallow */ }
  return next;
}

export function removeTask(id, configDir = defaultConfigDir()) {
  const p = taskPath(id, configDir);
  if (!fs.existsSync(p)) throw new TaskError(`no task "${id}"`, 'TASK_NO_TASK');
  fs.unlinkSync(p);
  return { id, removed: true };
}

// Render the task's turns into a single string suitable for handing
// to a human reader. Three formats:
//   'text' (default) — "[Who]\ntext\n\n[Who]\ntext\n..." plain
//   'md'             — markdown with H3 per turn, fenced code blocks
//                      for tool calls when present
//   'json'           — the raw task record (no projection)
export function formatTranscript(task, format = 'text') {
  if (!task || typeof task !== 'object') return '';
  if (format === 'json') return JSON.stringify(task, null, 2);
  const head = (format === 'md')
    ? [
        `# Task \`${task.id}\` — ${task.title || '(untitled)'}`,
        task.description ? `\n${task.description}\n` : '',
        `**Team**: ${task.team}  ·  **Lead**: ${task.lead}  ·  **Status**: ${task.status}`,
        '',
        '---',
        '',
      ].join('\n')
    : `Task ${task.id}: ${task.title || '(untitled)'}\n` +
      `Team: ${task.team} · Lead: ${task.lead} · Status: ${task.status}\n` +
      '-'.repeat(60) + '\n';
  const body = (Array.isArray(task.turns) ? task.turns : []).map((t) => {
    const who = t.agent === 'user' ? 'User' : t.agent === 'system' ? 'System' : t.agent;
    if (format === 'md') {
      const parts = [`### ${who}`, ''];
      if (t.text) parts.push(t.text, '');
      if (Array.isArray(t.toolCalls) && t.toolCalls.length) {
        for (const tc of t.toolCalls) {
          parts.push('```json');
          parts.push(JSON.stringify({ tool: tc.name, input: tc.input, ok: tc.ok }, null, 2));
          parts.push('```');
        }
        parts.push('');
      }
      return parts.join('\n');
    }
    return `[${who}]\n${t.text || ''}`;
  }).join(format === 'md' ? '\n' : '\n\n');
  return head + body + '\n';
}

// Build the kickoff message Slack will see as the thread root. Stays
// template-based for Phase 11 — Phase 13 will replace this with the
// lead agent's actual first LLM turn.
export function buildKickoffMessage({ id, title, description, leadDisplayName, teamDisplayName }) {
  const parts = [];
  parts.push(`*Task* \`${id}\`: ${title}`);
  if (description && description.trim()) parts.push(description.trim());
  parts.push(`assigned to *${leadDisplayName}* (team: ${teamDisplayName})`);
  return parts.join('\n');
}
