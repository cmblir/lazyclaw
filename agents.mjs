// Persistent agent registry for `/agent` REPL command and `lazyclaw agent`
// subcommand. Backs the Phase 9 piece of docs/multi-agent.md.
//
// Storage layout under <configDir>/agents/<name>.json. One file per
// agent so concurrent edit / remove writes don't race over a global
// index. Schema field set lives in `defaultShape()` below; new fields
// default to null/empty so reading an older record stays
// forward-compatible.
//
// Defaults reflect §10 of the multi-agent spec: a freshly created
// agent gets the full tool whitelist (bash + read + write + grep)
// because the user opted for "lazyclaw 모든 권한". Callers that want a
// stricter posture can pass an explicit `tools` array.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureValidName as cronEnsureValidName } from './cron.mjs';

const AGENTS_DIRNAME = 'agents';

export const DEFAULT_TOOLS = ['bash', 'read', 'write', 'grep'];
export const ALL_TOOLS = ['bash', 'read', 'write', 'grep', 'web_search', 'web_fetch', 'slack_post'];

export class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentError';
    this.code = code || 'AGENT_ERR';
  }
}

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function agentsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, AGENTS_DIRNAME);
}

export function agentPath(name, configDir = defaultConfigDir()) {
  ensureValidName(name);
  return path.join(agentsDir(configDir), `${name}.json`);
}

export function ensureValidName(name) {
  try { cronEnsureValidName(name); }
  catch (e) { throw new AgentError(e.message, 'AGENT_BAD_NAME'); }
}

function validateTools(tools) {
  if (!Array.isArray(tools)) {
    throw new AgentError('tools must be an array', 'AGENT_BAD_TOOLS');
  }
  const bad = tools.filter(t => !ALL_TOOLS.includes(t));
  if (bad.length) {
    throw new AgentError(`unknown tool(s): ${bad.join(', ')} — known: ${ALL_TOOLS.join(', ')}`, 'AGENT_BAD_TOOLS');
  }
  // Dedupe while preserving order.
  return [...new Set(tools)];
}

function titleCase(s) {
  return String(s).split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function defaultShape(name) {
  return {
    version: 1,
    name,
    displayName: titleCase(name),
    role: '',
    provider: 'claude-cli',
    model: '',
    tools: [...DEFAULT_TOOLS],
    tags: [],
    iconEmoji: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function writeAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

export function registerAgent({ name, displayName, role = '', provider = 'claude-cli', model = '', tools, tags = [], iconEmoji = '' } = {}, configDir = defaultConfigDir()) {
  ensureValidName(name);
  const p = agentPath(name, configDir);
  if (fs.existsSync(p)) {
    throw new AgentError(`agent "${name}" already exists`, 'AGENT_EXISTS');
  }
  const toolsClean = validateTools(tools ?? DEFAULT_TOOLS);
  const data = {
    ...defaultShape(name),
    displayName: displayName || titleCase(name),
    role: String(role || ''),
    provider: String(provider || 'claude-cli'),
    model: String(model || ''),
    tools: toolsClean,
    tags: Array.isArray(tags) ? tags : [],
    iconEmoji: String(iconEmoji || ''),
  };
  writeAtomic(p, data);
  return data;
}

export function getAgent(name, configDir = defaultConfigDir()) {
  let p;
  try { p = agentPath(name, configDir); }
  catch { return null; }
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function listAgents(configDir = defaultConfigDir()) {
  const dir = agentsDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const a = getAgent(name, configDir);
    if (a) out.push(a);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

export function patchAgent(name, patch, configDir = defaultConfigDir()) {
  const a = getAgent(name, configDir);
  if (!a) throw new AgentError(`no agent "${name}"`, 'AGENT_NO_AGENT');
  const next = { ...a, ...patch, updatedAt: new Date().toISOString() };
  if (patch.tools !== undefined) {
    next.tools = validateTools(patch.tools);
  }
  writeAtomic(agentPath(name, configDir), next);
  return next;
}

export function removeAgent(name, configDir = defaultConfigDir()) {
  const p = agentPath(name, configDir);
  if (!fs.existsSync(p)) {
    throw new AgentError(`no agent "${name}"`, 'AGENT_NO_AGENT');
  }
  fs.unlinkSync(p);
  return { name, removed: true };
}

// Parse a comma-separated tool list from CLI flag form. Empty / null
// input returns null so the caller can decide between "user didn't say"
// (→ keep existing or default) and "user said []" (→ disallow all).
export function parseToolsFlag(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return [];
  return s.split(',').map(t => t.trim()).filter(Boolean);
}
