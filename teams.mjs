// Persistent team registry for `/team` REPL command and `pompos team`
// subcommand. Backs the Phase 10 piece of docs/multi-agent.md.
//
// Storage under <configDir>/teams/<name>.json. A team is a named set of
// agents that share a Slack channel and a default lead. Both `agents`
// and `lead` are validated against the agent registry at write time so
// the on-disk record is always consistent (no dangling refs).

import fs from 'node:fs';
import path from 'node:path';
import { ensureValidName as cronEnsureValidName } from './cron.mjs';
import { getAgent } from './agents.mjs';
import { defaultConfigDir } from './lib/config_dir.mjs';

export { defaultConfigDir };

const TEAMS_DIRNAME = 'teams';

export class TeamError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TeamError';
    this.code = code || 'TEAM_ERR';
  }
}

export function teamsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, TEAMS_DIRNAME);
}

export function teamPath(name, configDir = defaultConfigDir()) {
  ensureValidName(name);
  return path.join(teamsDir(configDir), `${name}.json`);
}

export function ensureValidName(name) {
  try { cronEnsureValidName(name); }
  catch (e) { throw new TeamError(e.message, 'TEAM_BAD_NAME'); }
}

function validateAgentRefs(agents, lead, configDir) {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new TeamError('agents must be a non-empty array', 'TEAM_NO_AGENTS');
  }
  for (const a of agents) {
    if (!getAgent(a, configDir)) {
      throw new TeamError(`agent "${a}" is not registered — run 'pompos agent add ${a}' first`, 'TEAM_BAD_AGENT');
    }
  }
  if (lead && !agents.includes(lead)) {
    throw new TeamError(`lead "${lead}" must be one of the team's agents [${agents.join(', ')}]`, 'TEAM_BAD_LEAD');
  }
}

function titleCase(s) {
  return String(s).split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function defaultShape(name) {
  return {
    version: 1,
    name,
    displayName: titleCase(name),
    agents: [],
    lead: null,
    slackChannel: '',
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

export function registerTeam({ name, displayName, agents = [], lead = null, slackChannel = '' } = {}, configDir = defaultConfigDir()) {
  ensureValidName(name);
  const p = teamPath(name, configDir);
  if (fs.existsSync(p)) {
    throw new TeamError(`team "${name}" already exists`, 'TEAM_EXISTS');
  }
  const cleanAgents = [...new Set(agents)];
  // lead defaults to the first agent if the caller didn't pick one — spec §3.2
  // says "default lead", so we materialise it on write rather than leaving null.
  const cleanLead = lead || cleanAgents[0] || null;
  validateAgentRefs(cleanAgents, cleanLead, configDir);
  const data = {
    ...defaultShape(name),
    displayName: displayName || titleCase(name),
    agents: cleanAgents,
    lead: cleanLead,
    slackChannel: String(slackChannel || ''),
  };
  writeAtomic(p, data);
  _invalidateTeamIndex(configDir);
  return data;
}

export function getTeam(name, configDir = defaultConfigDir()) {
  let p;
  try { p = teamPath(name, configDir); }
  catch { return null; }
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function listTeams(configDir = defaultConfigDir()) {
  const dir = teamsDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const t = getTeam(name, configDir);
    if (t) out.push(t);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

export function patchTeam(name, patch, configDir = defaultConfigDir()) {
  const t = getTeam(name, configDir);
  if (!t) throw new TeamError(`no team "${name}"`, 'TEAM_NO_TEAM');
  const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
  // Renormalise agents/lead pair when either changes so we never persist
  // an inconsistent (lead not in agents) record.
  if (patch.agents !== undefined) next.agents = [...new Set(patch.agents)];
  validateAgentRefs(next.agents, next.lead, configDir);
  writeAtomic(teamPath(name, configDir), next);
  _invalidateTeamIndex(configDir);
  return next;
}

export function removeTeam(name, configDir = defaultConfigDir()) {
  const p = teamPath(name, configDir);
  if (!fs.existsSync(p)) {
    throw new TeamError(`no team "${name}"`, 'TEAM_NO_TEAM');
  }
  fs.unlinkSync(p);
  _invalidateTeamIndex(configDir);
  return { name, removed: true };
}

// Resolve a user-supplied channel string into a Slack channel id by
// calling conversations.list. Strategy:
//  - Already-looks-like-an-id ("C…" or "G…", uppercase + digits): pass through
//  - "#name" or bare name: best-effort lookup; on failure, return the
//    input unchanged so the team record still saves (the user can fix
//    later from the dashboard, and chat.postMessage tolerates "#name").
//
// `botToken` and `apiBase` are read from the caller — env access stays
// out of this module so it's testable.
export async function resolveSlackChannel(input, { botToken, apiBase = 'https://slack.com/api', logger = () => {} } = {}) {
  if (!input) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  // ID heuristic: starts with uppercase letter, only alphanumerics, ≥9 chars.
  if (/^[CGD][A-Z0-9]{8,}$/.test(raw)) return raw;
  if (!botToken) {
    logger(`[team] no SLACK_BOT_TOKEN — keeping channel literal "${raw}"\n`);
    return raw;
  }
  const target = raw.startsWith('#') ? raw.slice(1) : raw;
  const url = `${apiBase.replace(/\/$/, '')}/conversations.list?limit=1000&types=public_channel,private_channel`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${botToken}` },
    });
    if (!res.ok) {
      logger(`[team] conversations.list HTTP ${res.status} — keeping "${raw}"\n`);
      return raw;
    }
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      logger(`[team] conversations.list error "${json.error}" — keeping "${raw}"\n`);
      return raw;
    }
    const hit = (json.channels || []).find((c) => c && c.name === target);
    if (!hit) {
      logger(`[team] no channel "#${target}" in workspace — keeping literal\n`);
      return raw;
    }
    return hit.id;
  } catch (err) {
    logger(`[team] conversations.list failed: ${err?.message || err} — keeping "${raw}"\n`);
    return raw;
  }
}

export function parseListFlag(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

// Build the team's org tree for the dashboard: a nested { agent, children[] }
// rooted at team.lead. A member nests under its `manager` when that manager is
// also a team member; otherwise (no manager, or a manager outside the team) it
// attaches directly under the lead, so the result is always a single tree.
//
// @param {{lead:string, agents:string[]}} team
// @param {Record<string, object>} agentsById  name → agent record
export function teamTree(team, agentsById = {}) {
  const lead = team && team.lead;
  if (!lead) return null;
  const memberNames = new Set((team.agents || []));
  const byManager = new Map(); // manager name → child names
  for (const n of memberNames) {
    if (n === lead) continue;
    const rec = agentsById[n];
    const mgr = rec && rec.manager && memberNames.has(rec.manager) && rec.manager !== n
      ? rec.manager
      : lead;
    if (!byManager.has(mgr)) byManager.set(mgr, []);
    byManager.get(mgr).push(n);
  }
  const build = (name, seen) => {
    if (seen.has(name)) return null; // cycle guard (defensive — register/patch reject cycles)
    const next = new Set(seen).add(name);
    const node = { agent: agentsById[name] || { name }, children: [] };
    for (const child of (byManager.get(name) || []).sort()) {
      const c = build(child, next);
      if (c) node.children.push(c);
    }
    return node;
  };
  return build(lead, new Set());
}

// Find the team bound to an inbound channel id (team.slackChannel), or null.
// Used by the daemon to auto-route a Slack message to a team's multi-agent loop.
export function teamForChannel(teams, channel) {
  if (!channel) return null;
  const c = String(channel);
  return (teams || []).find((t) => t && t.slackChannel && String(t.slackChannel) === c) || null;
}

// slackChannel→team index, keyed by configDir and the teams/ dir mtime. Every
// inbound Slack message used to re-scan the whole teams/ directory (readdir + N
// JSON.parse) just to find one channel's team; this builds the lookup once and
// reuses it until the directory changes. register/patch/removeTeam invalidate
// explicitly (deterministic), and the dir-mtime key also catches manual edits.
const _channelIndex = new Map();  // configDir → { mtimeMs, byChannel: Map<channel, team> }

export function _invalidateTeamIndex(configDir = defaultConfigDir()) {
  _channelIndex.delete(configDir);
}

// O(1) channel→team lookup for the inbound hot path. Returns null when no team
// is bound to the channel (or there is no teams/ directory yet).
export function teamForChannelCached(channel, configDir = defaultConfigDir()) {
  if (!channel) return null;
  const dir = teamsDir(configDir);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(dir).mtimeMs; }
  catch { return null; }  // no teams dir → no team bound to anything
  const cached = _channelIndex.get(configDir);
  let byChannel;
  if (cached && cached.mtimeMs === mtimeMs) {
    byChannel = cached.byChannel;
  } else {
    byChannel = new Map();
    for (const t of listTeams(configDir)) {
      if (t && t.slackChannel) byChannel.set(String(t.slackChannel), t);
    }
    _channelIndex.set(configDir, { mtimeMs, byChannel });
  }
  return byChannel.get(String(channel)) || null;
}
