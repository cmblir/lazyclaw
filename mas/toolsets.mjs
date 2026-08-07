// toolsets — named bundles of tool names that an agent can be assigned via
// `pompos agent edit <name> --toolset coding-min`. Built-ins ship in
// code; user-defined sets live in <configDir>/toolsets.json.

import fs from 'node:fs';
import path from 'node:path';

const BUILTIN = {
  'coding-min':  { tools: ['bash', 'read', 'write', 'edit', 'patch', 'grep', 'git_status', 'git_diff'] },
  'web-research':{ tools: ['web_fetch', 'web_search', 'url_extract', 'read', 'write', 'recall'] },
  'devops':      { tools: ['bash', 'git_status', 'git_diff', 'git_log', 'git_commit', 'cron_add', 'cron_list', 'http_request'] },
  'learning':    { tools: ['recall', 'skill_view', 'skill_create', 'skill_edit', 'memory_read', 'memory_write', 'user_view', 'user_update'] },
  'media':       { tools: ['image_describe', 'image_generate', 'transcribe'] },
  'agentic':     { tools: ['task_spawn', 'delegate', 'spawn_subagent', 'clarify', 'recall', 'skill_view', 'finish', 'handoff'] },
};

function configFile(opts) {
  const dir = opts?.configDir || process.env.LAZYCLAW_CONFIG_DIR || path.join(process.env.HOME || '.', '.pompos');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'toolsets.json');
}

function readUser(opts) {
  const f = configFile(opts);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return {}; }
}

function writeUser(data, opts) {
  fs.writeFileSync(configFile(opts), JSON.stringify(data, null, 2));
}

export function listToolsets(opts) {
  const user = readUser(opts);
  const out = [];
  for (const [name, t] of Object.entries(BUILTIN)) out.push({ name, ...t, source: 'builtin' });
  for (const [name, t] of Object.entries(user))    out.push({ name, ...t, source: 'user' });
  return out;
}

export function resolveToolset(name, opts) {
  const user = readUser(opts);
  const t = user[name] || BUILTIN[name];
  if (!t || !Array.isArray(t.tools)) throw new Error(`toolset "${name}" not found`);
  return [...t.tools];
}

export function addToolset({ name, tools }, opts) {
  if (!name || !Array.isArray(tools)) throw new Error('addToolset: name + tools[] required');
  if (BUILTIN[name]) throw new Error(`toolset "${name}" is built-in; pick a different name`);
  const data = readUser(opts);
  data[name] = { tools };
  writeUser(data, opts);
  return data[name];
}

export function removeToolset(name, opts) {
  if (BUILTIN[name]) throw new Error(`cannot remove built-in toolset "${name}"`);
  const data = readUser(opts);
  delete data[name];
  writeUser(data, opts);
  return true;
}
