// Config-driven CLI surfaces — auth-profile rotation, pairing
// (sender allowlist), nodes (device registration), and outbound
// messaging webhooks. Each one is a thin record-keeper layered on
// top of the existing readConfig / writeConfig pair: the CLI never
// stores a separate file.
//
// All four were called out as OpenClaw parity gaps; we implement
// them as plain config keys here so the SAME `pompos config get`
// flow keeps working and `pompos export | jq` already covers
// backups without us writing a second exporter.

// Auth profiles ────────────────────────────────────────────────
//
// cfg.authProfiles[provider] = [{ key, label, addedAt }]
//
// Picked over a single `api-key` field so a user can keep multiple
// keys for the same provider (work / personal / spare) and rotate
// when one hits a rate limit. The rotation cursor lives in
// cfg.authActiveProfile[provider] = label so the choice persists
// across invocations.

export function authList(cfg, provider) {
  const profiles = (cfg.authProfiles || {})[provider] || [];
  return profiles.map((p) => ({
    label: p.label,
    addedAt: p.addedAt,
    keyMasked: maskKey(p.key),
  }));
}

export function authAdd(cfg, provider, key, label) {
  if (!provider) throw new Error('provider is required');
  if (!key) throw new Error('key is required');
  cfg.authProfiles = cfg.authProfiles || {};
  cfg.authProfiles[provider] = cfg.authProfiles[provider] || [];
  const lbl = (label || `profile-${cfg.authProfiles[provider].length + 1}`).trim();
  if (cfg.authProfiles[provider].some((p) => p.label === lbl)) {
    throw new Error(`profile "${lbl}" already exists for ${provider}`);
  }
  cfg.authProfiles[provider].push({ key, label: lbl, addedAt: new Date().toISOString() });
  // First-added profile becomes active so the user gets working
  // auth rotation without a separate `auth use` step.
  cfg.authActiveProfile = cfg.authActiveProfile || {};
  if (!cfg.authActiveProfile[provider]) cfg.authActiveProfile[provider] = lbl;
  return lbl;
}

export function authRemove(cfg, provider, label) {
  const arr = (cfg.authProfiles || {})[provider] || [];
  const idx = arr.findIndex((p) => p.label === label);
  if (idx < 0) throw new Error(`no profile "${label}" for ${provider}`);
  arr.splice(idx, 1);
  if ((cfg.authActiveProfile || {})[provider] === label) {
    cfg.authActiveProfile[provider] = arr[0]?.label || '';
  }
}

export function authUse(cfg, provider, label) {
  const arr = (cfg.authProfiles || {})[provider] || [];
  if (!arr.some((p) => p.label === label)) {
    throw new Error(`no profile "${label}" for ${provider}`);
  }
  cfg.authActiveProfile = cfg.authActiveProfile || {};
  cfg.authActiveProfile[provider] = label;
}

export function authRotate(cfg, provider) {
  const arr = (cfg.authProfiles || {})[provider] || [];
  if (arr.length < 2) return null;
  cfg.authActiveProfile = cfg.authActiveProfile || {};
  const cur = cfg.authActiveProfile[provider];
  const idx = arr.findIndex((p) => p.label === cur);
  const next = arr[(idx + 1) % arr.length];
  cfg.authActiveProfile[provider] = next.label;
  return next.label;
}

// Resolves the api-key the chat / agent flow should send. Falls
// back to the legacy single `api-key` field so existing configs
// keep working without a migration.
export function resolveApiKey(cfg, provider) {
  const arr = (cfg.authProfiles || {})[provider] || [];
  const active = (cfg.authActiveProfile || {})[provider];
  const hit = arr.find((p) => p.label === active) || arr[0];
  if (hit?.key) return hit.key;
  return cfg['api-key'] || '';
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****' + s.slice(-2);
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// Pairing (sender allowlist) ───────────────────────────────────
//
// cfg.pairing = [{ id, label, addedAt }]
//
// Sender ids are the opaque strings the messaging layer hands us
// (e.g. Slack member id, Discord user id, phone number for SMS
// bridges). Anything that isn't on the allowlist gets rejected by
// the inbound handler — same shape as openclaw `pairing approve`.

export function pairingList(cfg) {
  return (cfg.pairing || []).slice();
}

export function pairingAdd(cfg, id, label) {
  if (!id) throw new Error('id is required');
  cfg.pairing = cfg.pairing || [];
  if (cfg.pairing.some((p) => p.id === id)) {
    throw new Error(`id "${id}" already paired`);
  }
  cfg.pairing.push({ id, label: label || '', addedAt: new Date().toISOString() });
}

export function pairingRemove(cfg, id) {
  const arr = cfg.pairing || [];
  const idx = arr.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`id "${id}" not found`);
  arr.splice(idx, 1);
}

export function pairingHas(cfg, id) {
  return (cfg.pairing || []).some((p) => p.id === id);
}

// Nodes (device registration) ──────────────────────────────────
//
// cfg.nodes = [{ id, platform, label, registeredAt }]
//
// CLI side of `openclaw nodes` — the actual mobile companion apps
// aren't in scope here, but the registration table lets a future
// app (or just `curl`) authenticate against `pompos daemon`.
// Platform is free-form ('macos' / 'ios' / 'android' / 'web' /
// 'cli') so we don't constrain future surfaces.

export function nodesList(cfg) {
  return (cfg.nodes || []).slice();
}

export function nodesRegister(cfg, id, platform = 'cli', label = '') {
  if (!id) throw new Error('id is required');
  cfg.nodes = cfg.nodes || [];
  if (cfg.nodes.some((n) => n.id === id)) {
    throw new Error(`node "${id}" already registered`);
  }
  cfg.nodes.push({
    id,
    platform: String(platform || 'cli').toLowerCase(),
    label: label || '',
    registeredAt: new Date().toISOString(),
  });
}

export function nodesRemove(cfg, id) {
  const arr = cfg.nodes || [];
  const idx = arr.findIndex((n) => n.id === id);
  if (idx < 0) throw new Error(`node "${id}" not found`);
  arr.splice(idx, 1);
}

// Messaging — outbound webhooks ────────────────────────────────
//
// cfg.messaging.webhooks[name] = { kind: 'slack'|'discord', url }
//
// We deliberately store webhook URLs (not bot tokens) because that
// keeps the install footprint small — any user can paste a Slack
// "Incoming Webhook" URL and start sending without registering an
// app. Bot tokens can be added later as a separate `messaging.tokens`
// shape when we wire the bidirectional inbox.

const WEBHOOK_PATTERNS = {
  slack:   /^https?:\/\/hooks\.slack\.com\//i,
  discord: /^https?:\/\/(?:discord(?:app)?\.com|canary\.discord\.com)\/api\/webhooks\//i,
};

function detectKind(url) {
  for (const [kind, re] of Object.entries(WEBHOOK_PATTERNS)) {
    if (re.test(url)) return kind;
  }
  return 'generic';
}

export function messageList(cfg) {
  const map = (cfg.messaging || {}).webhooks || {};
  return Object.entries(map).map(([name, v]) => ({
    name,
    kind: v.kind,
    urlMasked: v.url ? v.url.slice(0, 32) + '…' + v.url.slice(-6) : '',
  }));
}

export function messageAdd(cfg, name, url, kindOverride) {
  if (!name) throw new Error('name is required');
  if (!url) throw new Error('url is required');
  cfg.messaging = cfg.messaging || {};
  cfg.messaging.webhooks = cfg.messaging.webhooks || {};
  if (cfg.messaging.webhooks[name]) {
    throw new Error(`webhook "${name}" already exists`);
  }
  cfg.messaging.webhooks[name] = {
    kind: kindOverride || detectKind(url),
    url,
    addedAt: new Date().toISOString(),
  };
}

export function messageRemove(cfg, name) {
  const map = (cfg.messaging || {}).webhooks || {};
  if (!map[name]) throw new Error(`webhook "${name}" not found`);
  delete map[name];
}

export async function messageSend(cfg, name, text, opts = {}) {
  const map = (cfg.messaging || {}).webhooks || {};
  const hook = map[name];
  if (!hook) throw new Error(`no "${name}" channel is configured. Set up Slack with \`pompos setup\` (channel step), or add a webhook: \`pompos message add ${name} <webhook-url>\``);
  const fetchFn = opts.fetch || globalThis.fetch;
  if (!fetchFn) throw new Error('no fetch implementation');

  // Slack and Discord both accept a JSON body but with different key
  // shapes — Slack uses { text }, Discord uses { content }. The
  // generic kind sends a plain JSON envelope so user-supplied
  // endpoints can ingest whatever shape they like via { text }.
  let body;
  if (hook.kind === 'discord') body = JSON.stringify({ content: text });
  else                          body = JSON.stringify({ text });

  const res = await fetchFn(hook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const errText = (await (res.text?.() || Promise.resolve(''))).slice(0, 300);
    throw new Error(`webhook ${hook.kind} send failed: ${res.status} ${errText}`);
  }
  return { ok: true, kind: hook.kind, status: res.status };
}

// ── Channels — built-in channel config (cfg.channels.<name>) ────────────
// KNOWN_CHANNELS mirrors channels/ (built-in) + channels-* (plugins). Single
// source of truth: the daemon /channels route, the CLI `channels` command, and
// the in-chat /channels slash all read it so the three views can't drift.
export const KNOWN_CHANNELS = ['slack', 'matrix', 'telegram', 'discord', 'email', 'signal', 'whatsapp', 'voice', 'http'];

// A channel counts as "configured" when it has a cfg.channels.<name> section
// or a legacy <name>-bot-token / <name>-token key. Returns one row per
// configured channel: { name, enabled, boundAgent, lastInboundAt }. Matches
// the daemon /channels route's enabled semantics exactly.
export function channelStatusList(cfg) {
  const chCfg = (cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
  const out = [];
  for (const name of KNOWN_CHANNELS) {
    const sec = chCfg[name];
    if (!sec && !cfg[`${name}-bot-token`] && !cfg[`${name}-token`]) continue;
    out.push({
      name,
      enabled: !!(sec && (sec.enabled !== false)),
      boundAgent: sec?.agent || sec?.boundAgent || null,
      lastInboundAt: sec?.lastInboundAt || null,
    });
  }
  // Surface any additional configured channels not in the known list.
  for (const name of Object.keys(chCfg)) {
    if (KNOWN_CHANNELS.includes(name)) continue;
    const sec = chCfg[name] || {};
    out.push({
      name,
      enabled: sec.enabled !== false,
      boundAgent: sec.agent || sec.boundAgent || null,
      lastInboundAt: sec.lastInboundAt || null,
    });
  }
  return out;
}

// Enable/disable a channel. Mutates cfg.channels.<name>.enabled; the caller
// persists via writeConfig. Returns cfg for chaining.
export function channelSetEnabled(cfg, name, enabled) {
  if (!name) throw new Error('channel name is required');
  cfg.channels = (cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
  cfg.channels[name] = { ...(cfg.channels[name] || {}), enabled: !!enabled };
  return cfg;
}

// ── Chat context window (cfg.chat.window{Turns,Tokens}) ─────────────────
// The sliding history budget sent to the model each turn (NOT the model's hard
// context limit). Shared by the /context slash, the setup step, the status bar,
// and applyChatWindow so all four agree. Defaults mirror chat_window.mjs.
const _CTX_DEFAULT_TURNS = Number(process.env.POMPOS_CHAT_WINDOW_TURNS) || 20;
const _CTX_DEFAULT_TOKENS = Number(process.env.POMPOS_CHAT_WINDOW_TOKENS) || 8000;
export function chatWindowGet(cfg) {
  const c = (cfg && cfg.chat && typeof cfg.chat === 'object') ? cfg.chat : {};
  return { turns: Number(c.windowTurns) || _CTX_DEFAULT_TURNS, tokens: Number(c.windowTokens) || _CTX_DEFAULT_TOKENS };
}
export function chatWindowSet(cfg, { turns, tokens } = {}) {
  cfg.chat = (cfg.chat && typeof cfg.chat === 'object') ? cfg.chat : {};
  if (turns !== undefined) cfg.chat.windowTurns = turns;
  if (tokens !== undefined) cfg.chat.windowTokens = tokens;
  return cfg;
}

// ── Chat agentic REPL + plan mode (cfg.chat.{agentic,tools,planMode}) ────
// Group 1 — when agentic mode is ON the chat turn routes through the MAS
// tool loop (runAgentTurn) instead of plain streaming. Opt-in, OFF by
// default, so existing users keep the exact streaming behavior. Plan mode
// rides on the same loop but intersects the tool whitelist down to a
// read-only set ("propose, don't mutate"). Accessors are the registration
// surface for these keys, mirroring chatWindowGet/Set above.
//
// Default whitelist is read-only + safe: a chat turn that can silently
// propose bash is higher-risk than /task, so bash/write are opt-in per tool
// via cfg.chat.tools. Sensitive tools still pass the fail-closed approval
// gate in mas/tool_runner.mjs regardless.
export const DEFAULT_CHAT_TOOLS = ['read', 'grep', 'skill_view'];
// Read-only safe set used to intersect the whitelist in plan mode (drops
// bash/write/delegate and any other sensitive verb). Kept narrow on purpose.
export const READONLY_CHAT_TOOLS = ['read', 'grep', 'skill_view'];

export function chatAgenticGet(cfg) {
  return !!(cfg && cfg.chat && cfg.chat.agentic === true);
}
export function chatPlanModeGet(cfg) {
  return !!(cfg && cfg.chat && cfg.chat.planMode === true);
}
export function chatToolsGet(cfg) {
  const c = (cfg && cfg.chat && typeof cfg.chat === 'object') ? cfg.chat : {};
  return Array.isArray(c.tools) ? c.tools.slice() : DEFAULT_CHAT_TOOLS.slice();
}

// Persist a chat.* boolean/array key, mutating cfg in place. Returns cfg.
export function chatSet(cfg, key, value) {
  cfg.chat = (cfg.chat && typeof cfg.chat === 'object') ? cfg.chat : {};
  cfg.chat[key] = value;
  return cfg;
}

// Resolve the effective tool whitelist for an agentic chat turn. In plan
// mode the configured whitelist is intersected with the read-only set so
// no mutating tool can be proposed; otherwise the configured list is used
// as-is (default read-only safe set when unset).
export function effectiveChatTools(cfg, { planMode = false } = {}) {
  const tools = chatToolsGet(cfg);
  if (!planMode) return tools;
  return tools.filter((t) => READONLY_CHAT_TOOLS.includes(t));
}

// ── Orchestrator — multi-agent config (cfg.orchestrator) ────────────────
// Shared by the setup wizard, the /orchestrator slash, and the CLI so the
// "planner + workers" config has one shape. Orchestration is ACTIVE only when
// cfg.provider === 'orchestrator' AND there is at least one worker.
export function orchestratorGet(cfg) {
  const o = (cfg.orchestrator && typeof cfg.orchestrator === 'object') ? cfg.orchestrator : {};
  const workers = Array.isArray(o.workers) ? o.workers : [];
  return {
    planner: o.planner || null,
    workers,
    maxSubtasks: Number.isFinite(o.maxSubtasks) ? o.maxSubtasks : 5,
    active: cfg.provider === 'orchestrator' && workers.length > 0,
  };
}

// Merge planner / workers / maxSubtasks into cfg.orchestrator (only the keys
// provided). Returns cfg.
export function orchestratorSet(cfg, { planner, workers, maxSubtasks } = {}) {
  cfg.orchestrator = (cfg.orchestrator && typeof cfg.orchestrator === 'object') ? cfg.orchestrator : {};
  if (planner !== undefined) cfg.orchestrator.planner = planner;
  if (workers !== undefined) cfg.orchestrator.workers = workers;
  if (maxSubtasks !== undefined) cfg.orchestrator.maxSubtasks = maxSubtasks;
  return cfg;
}

// Turn orchestration on/off by routing cfg.provider. Enabling stashes the
// previous real provider so disabling can restore it (else falls back to the
// planner's base provider, then claude-cli).
export function orchestratorEnable(cfg, enabled) {
  if (enabled) {
    if (cfg.provider && cfg.provider !== 'orchestrator') {
      cfg.orchestrator = (cfg.orchestrator && typeof cfg.orchestrator === 'object') ? cfg.orchestrator : {};
      cfg.orchestrator._prevProvider = cfg.provider;
    }
    cfg.provider = 'orchestrator';
  } else {
    const o = (cfg.orchestrator && typeof cfg.orchestrator === 'object') ? cfg.orchestrator : {};
    const plannerBase = String(o.planner || '').split(':')[0];
    cfg.provider = o._prevProvider || plannerBase || 'claude-cli';
  }
  return cfg;
}
