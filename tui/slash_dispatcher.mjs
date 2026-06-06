// tui/slash_dispatcher.mjs — single source of slash-command routing for the
// Ink chat REPL (v5.4). Lifted from cli.mjs's legacy readline handler so the
// Ink branch stops shipping the "not yet wired" placeholder and so future
// channels (Slack/Telegram inline commands, /handoff cross-channel control)
// can share one dispatch table.
//
// Contract:
//   dispatchSlash(cmd, args, ctx, write) → Promise<string|'EXIT'|void>
//     · returns 'EXIT'        — caller should unmount/exit
//     · returns a string      — caller writes it to scrollback verbatim
//     · returns void          — handler already streamed via `write(...)`
//     · throws                — caller surfaces as an error scrollback item
//
// `ctx` shape (see slash_dispatcher.test.mjs for the canonical mock):
//   {
//     cfg, cfgDir, version, syntheticChatSessionId,
//     getMessages / setMessages,
//     getActiveProvName / setActiveProvName,
//     getActiveModel   / setActiveModel,
//     getProv          / setProv,
//     getSessionId     / setSessionId,
//     getCharsSent     / setCharsSent,
//     getRunningUsage  / setRunningUsage,
//     persistTurn, accumulateUsage,
//     resolveAuthKey,
//     registryMod,     // optional — falls back to dynamic import
//     sessionsMod,     // optional — falls back to dynamic import
//     skillsMod,       // optional — falls back to dynamic import
//   }
//
// Interactive sub-menus (provider/model pickers, /personality picker) are
// readline-coupled in cli.mjs. In Ink we surface a hint instead of crashing;
// operators can pass an arg form (e.g. `/provider openai`) or fall back to
// LAZYCLAW_NO_INK=1. Re-implementing these as Ink overlays is a v5.5 item.

import { SLASH_COMMANDS } from './slash_commands.mjs';
import { supportsLiveFetch, fetchModelsForProvider } from '../providers/model_catalogue.mjs';
import { providerFamilies, providerTag } from './provider_families.mjs';
import { addCustomProvider } from '../providers/custom_provider.mjs';
import { setAuthKey } from '../providers/auth_store.mjs';
import { attachGoalCron, detachGoalCron } from '../goals_cron.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Split a raw slash line into { cmd, args }. The cmd retains its leading
 * slash; args is everything after the first whitespace, with trailing
 * whitespace stripped. Empty args yields ''.
 */
export function parseSlashLine(line) {
  const raw = (line || '').replace(/\s+$/, '');
  const m = raw.match(/^(\/\S+)(\s+(.*))?$/);
  if (!m) return { cmd: raw, args: '' };
  return { cmd: m[1], args: (m[3] || '').trim() };
}

// Tiny utility — split args on whitespace, drop empties. Used by sub-command
// handlers that don't need the loop-engine's full quote-aware splitter.
function splitWhitespace(s) {
  return (s || '').split(/\s+/).filter(Boolean);
}

// Parse a "provider[:model]" spec, preferring the registry's parser.
function _parseProvModel(registry, spec) {
  if (registry && typeof registry.parseProviderModel === 'function') return registry.parseProviderModel(spec);
  const s = String(spec || '');
  const i = s.indexOf(':');
  if (i < 0) return { provider: s || null, model: null };
  return { provider: s.slice(0, i) || null, model: s.slice(i + 1) || null };
}

// Best-effort dynamic import. Returns the resolved ctx field if the caller
// pre-injected it (test hot path), else loads the real module. Throwing is
// fine — handlers wrap calls in try/catch where appropriate.
async function _mod(ctx, key, importer) {
  if (ctx && ctx[key]) return ctx[key];
  return importer();
}

// ─── handlers ────────────────────────────────────────────────────────────

async function _help() {
  const lines = ['slash commands:'];
  for (const c of SLASH_COMMANDS) lines.push(`  ${c.cmd.padEnd(14)} — ${c.help}`);
  return lines.join('\n');
}

async function _status(_args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  const provider = ctx.getActiveProvName();
  const model = ctx.getActiveModel() || '(default)';
  const keyMasked = registry.maskApiKey(ctx.cfg && ctx.cfg['api-key']);
  const messageCount = ctx.getMessages().length;
  const sessionId = ctx.getSessionId() || '(none — in-memory)';
  return [
    'status:',
    `  provider:  ${provider}`,
    `  model:     ${model}`,
    `  api key:   ${keyMasked}`,
    `  messages:  ${messageCount}`,
    `  session:   ${sessionId}`,
  ].join('\n');
}

async function _version(_args, ctx) {
  const v = ctx.version || '0.0.0';
  return `lazyclaw ${v} (node ${process.version}, ${process.platform})`;
}

async function _usage(_args, ctx) {
  const msgs = ctx.getMessages();
  const runningUsage = ctx.getRunningUsage && ctx.getRunningUsage();
  const charsSent = (ctx.getCharsSent && ctx.getCharsSent()) || 0;
  const lines = [
    'usage:',
    `  messages:  ${msgs.length}`,
    `  chars sent: ${charsSent.toLocaleString('en-US')}`,
  ];
  if (runningUsage) {
    lines.push(
      `  tokens in:  ${(runningUsage.inputTokens || 0).toLocaleString('en-US')}`,
      `  tokens out: ${(runningUsage.outputTokens || 0).toLocaleString('en-US')}`,
      `  tokens tot: ${(runningUsage.totalTokens || 0).toLocaleString('en-US')}`,
      `  turns:      ${runningUsage.turnsWithUsage || 0}`,
    );
    if (ctx.cfg && ctx.cfg.rates && typeof ctx.cfg.rates === 'object') {
      try {
        const { costFromUsage } = await import('../providers/rates.mjs');
        const r = costFromUsage(
          { provider: ctx.getActiveProvName(), model: ctx.getActiveModel(), usage: runningUsage },
          ctx.cfg.rates,
        );
        if (r && r.totalUsd != null) {
          lines.push(`  cost (USD): $${Number(r.totalUsd).toFixed(4)}`);
        }
      } catch { /* never let cost-card lookup fail the slash */ }
    }
  }
  return lines.join('\n');
}

async function _newReset(_args, ctx) {
  if (ctx.setMessages) ctx.setMessages([]);
  if (ctx.setCharsSent) ctx.setCharsSent(0);
  if (ctx.setRunningUsage) ctx.setRunningUsage(null);
  const sid = ctx.getSessionId && ctx.getSessionId();
  if (sid) {
    try {
      const sm = await _mod(ctx, 'sessionsMod', () => import('../sessions.mjs'));
      sm.resetSession(sid, ctx.cfgDir);
    } catch (e) {
      return `cleared in-memory; session reset failed: ${e?.message || e}`;
    }
  }
  return 'cleared — new conversation';
}

function _providerLookup(registry, name) {
  if (typeof registry.lookupProv === 'function') return registry.lookupProv(name);
  return registry.PROVIDERS ? registry.PROVIDERS[name] : null;
}

// Pick a provider via the family drill-in (API key / CLI-Local / Mock),
// mirroring the legacy readline wizard. Single-option steps auto-advance.
// orchestrator is never listed. Returns a provider id or null on cancel.
async function _pickProviderDrillIn(ctx, registry) {
  const info = registry.PROVIDER_INFO || {};
  const families = providerFamilies(registry);
  const nonEmpty = Object.values(families).filter((f) => f.members.length > 0);
  if (!nonEmpty.length) return null;

  // ── Step 1 — auth family (skipped when only one is populated) ──
  let family = nonEmpty[0];
  if (nonEmpty.length > 1) {
    const picked = await ctx.openPicker({
      kind: 'provider-family',
      title: 'select provider — how do you want to auth?',
      subtitle: 'API: bring your own key · CLI/Local: use this machine · Mock: offline',
      items: nonEmpty.map((f) => ({
        id: f.id,
        label: f.label,
        desc: `${f.desc} · ${f.members.slice(0, 3).join(' / ')}${f.members.length > 3 ? ` (+${f.members.length - 3})` : ''}`,
        tag: f.tag,
      })),
    });
    if (!picked || typeof picked !== 'string') return null;
    family = families[picked];
    if (!family || !family.members.length) return null;
  }

  // ── Step 2 — provider in that family (auto-advances on a single member) ──
  // The API-key family also offers "+ add a custom endpoint" so NIM /
  // OpenRouter / vLLM / etc. can be registered without leaving chat. The
  // add-custom row is never auto-advanced past, so don't single-skip it in.
  const items = family.members.map((id) => {
    const meta = info[id] || {};
    let desc = '';
    if (meta.custom) desc = `custom · ${meta.baseUrl || ''}`;
    else if (meta.builtinOpenAICompat) desc = meta.label || meta.baseUrl || '';
    else if (meta.label && meta.label !== id) desc = meta.label;
    return { id, label: id, desc, tag: providerTag(meta) };
  });
  if (family.id === 'api') {
    items.push({
      id: '__add_custom__',
      label: '+ add a custom OpenAI-compatible endpoint…',
      desc: 'NIM · OpenRouter · Together · Groq · vLLM · LM Studio',
      tag: 'new',
    });
  }
  if (items.length === 1) return items[0].id;
  const picked = await ctx.openPicker({
    kind: 'provider',
    title: `select provider — ${family.label}`,
    subtitle: `current: ${ctx.getActiveProvName()}`,
    items,
  });
  return typeof picked === 'string' ? picked : null;
}

// Single free-text prompt reusing the modal's filter buffer (no dedicated
// input widget). Returns the typed value, '' (only when allowEmpty), or null
// on cancel / required-but-empty.
async function _promptText(ctx, { title, subtitle, allowEmpty } = {}) {
  if (typeof ctx.openPicker !== 'function') return null;
  const picked = await ctx.openPicker({
    kind: 'text',
    title,
    subtitle: subtitle || 'type into the filter, then pick the row · Esc cancels',
    items: [{ id: '__text__', label: '✓ use what I typed above', desc: '', pinned: true, freeText: true }],
  });
  if (picked == null) return null;
  if (typeof picked === 'object') {
    const v = String(picked.query || '').trim();
    if (!v && !allowEmpty) return null;
    return v;
  }
  return null;
}

// Register a custom OpenAI-compatible endpoint with the given fields, set it
// active, and return a summary string. Shared by the arg form and the
// interactive flow.
async function _registerCustom(ctx, registry, { name, baseUrl, apiKey }) {
  if (typeof ctx.readConfig !== 'function' || typeof ctx.writeConfig !== 'function') {
    return 'add custom: config writer unavailable in this session — use: lazyclaw providers add <name> <baseUrl> [apiKey]';
  }
  try {
    const r = await addCustomProvider({
      registry, readConfig: ctx.readConfig, writeConfig: ctx.writeConfig, name, baseUrl, apiKey,
    });
    const next = _providerLookup(registry, r.name);
    if (next) {
      if (ctx.setActiveProvName) ctx.setActiveProvName(r.name);
      if (ctx.setProv) ctx.setProv(next);
    }
    const probe = r.probe.ok
      ? `✓ reachable — ${r.probe.count} model(s)`
      : `! registered, but /v1/models probe failed: ${r.probe.error}`;
    const override = r.builtinOverride ? `\n(note: overrides built-in "${r.name}")` : '';
    return `custom provider saved → ${r.name} (${r.baseUrl})\n${probe}${override}\nprovider → ${r.name}`;
  } catch (e) {
    return `add custom failed: ${e && e.message ? e.message : e}`;
  }
}

// After an interactive pick of a built-in api-key provider that has no key
// resolved, prompt for one and persist it (mirrored in-memory so it takes
// effect this session). No-op for keyless / custom providers, when a key
// already resolves, or when config writers aren't wired.
async function _maybePromptForKey(ctx, registry, provName) {
  const meta = _infoFor(registry, provName);
  if (!meta.requiresApiKey || meta.custom) return;
  if (typeof ctx.readConfig !== 'function' || typeof ctx.writeConfig !== 'function') return;
  const existing = typeof ctx.resolveAuthKey === 'function' ? ctx.resolveAuthKey(provName) : '';
  if (existing) return;
  const key = await _promptText(ctx, {
    title: `${provName} needs an api key`,
    subtitle: 'paste it now, or Esc to skip (set later via: lazyclaw auth)',
  });
  if (!key) return;
  const next = setAuthKey({ readConfig: ctx.readConfig, writeConfig: ctx.writeConfig, provider: provName, key });
  // Mirror onto the in-memory cfg so resolveAuthKey (which closes over it)
  // sees the key on the next turn without a restart.
  if (ctx.cfg && next) {
    ctx.cfg.authProfiles = next.authProfiles;
    ctx.cfg.authActiveProfile = next.authActiveProfile;
  }
}

// Interactive add-custom: collect name/baseUrl/apiKey via sequential prompts.
async function _addCustomFlow(ctx, registry) {
  const name = await _promptText(ctx, { title: 'custom endpoint — short id', subtitle: 'e.g. nim, openrouter, vllm (Esc cancels)' });
  if (!name) return 'cancelled';
  const baseUrl = await _promptText(ctx, { title: `baseUrl for ${name}`, subtitle: 'must start with http(s) and end in /v1' });
  if (!baseUrl) return 'cancelled';
  const apiKey = await _promptText(ctx, { title: `api-key for ${name}`, subtitle: 'leave blank for an auth-less endpoint (e.g. local vLLM)', allowEmpty: true });
  if (apiKey === null) return 'cancelled';
  return _registerCustom(ctx, registry, { name, baseUrl, apiKey });
}

async function _provider(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  // `/provider add <name> <baseUrl> [apiKey]` — register a custom OpenAI-
  // compatible endpoint non-interactively.
  const addMatch = args && args.match(/^add\s+(.+)$/i);
  if (addMatch) {
    const [name, baseUrl, apiKey] = splitWhitespace(addMatch[1]);
    if (!name || !baseUrl) return 'usage: /provider add <name> <baseUrl> [apiKey]';
    return _registerCustom(ctx, registry, { name, baseUrl, apiKey });
  }
  // No arg → drill-in modal picker (family -> provider). Falls back to the
  // pre-v5.4.3 hint string when ctx.openPicker isn't available (e.g. non-Ink
  // callers or before the picker ref settles).
  if (!args) {
    if (typeof ctx.openPicker === 'function') {
      const picked = await _pickProviderDrillIn(ctx, registry);
      if (!picked) return 'cancelled';
      if (picked === '__add_custom__') return _addCustomFlow(ctx, registry);
      args = picked;
      // Built-in api-key provider with no key configured → offer to set one.
      await _maybePromptForKey(ctx, registry, args);
    } else {
      return `provider: ${ctx.getActiveProvName()}\n(pass an arg: /provider <name>)`;
    }
  }
  const next = _providerLookup(registry, args);
  if (!next) {
    const known = registry.PROVIDERS ? Object.keys(registry.PROVIDERS).join(', ') : '?';
    return `unknown provider: ${args} (known: ${known})`;
  }
  if (ctx.setActiveProvName) ctx.setActiveProvName(args);
  if (ctx.setProv) ctx.setProv(next);
  return `provider → ${args}`;
}

function _infoFor(registry, provName) {
  return (registry.PROVIDER_INFO && registry.PROVIDER_INFO[provName]) || {};
}

// A composite provider (orchestrator) has no real model list — its only
// "model" is the provider name itself, so the model picker would dead-end
// on a single bogus row. Detect it so we can redirect to a provider pick.
function _isCompositeProvider(info, provName) {
  if (info && info.composite) return true;
  const s = info && Array.isArray(info.suggestedModels) ? info.suggestedModels : null;
  return !!(s && s.length === 1 && s[0] === provName);
}

// Whether the active provider exposes any selectable model (a suggested
// model that isn't just the provider name, or a live-fetchable catalogue).
function _hasRealModels(info, provName) {
  if (supportsLiveFetch(info, provName)) return true;
  const s = info && Array.isArray(info.suggestedModels) ? info.suggestedModels : [];
  return s.some((m) => m && m !== provName);
}

// Build the model-picker rows: suggested + any live-fetched models, deduped,
// with the provider default tagged, plus pinned sentinel rows for live-fetch
// (when supported) and free-text custom entry.
function _buildModelItems(info, provName, dynamicModels) {
  const base = Array.isArray(info.suggestedModels) ? info.suggestedModels : [];
  const all = Array.from(new Set([...(dynamicModels || []), ...base])).filter((m) => m && m !== provName);
  const items = [];
  if (supportsLiveFetch(info, provName)) {
    items.push({
      id: '__fetch_models__',
      label: '↻ fetch live model list',
      desc: 'pull the current catalogue from the provider',
      pinned: true,
    });
  }
  for (const m of all) {
    items.push({ id: m, label: m, desc: info.defaultModel === m ? '(default)' : '' });
  }
  items.push({
    id: '__custom_model__',
    label: '… type a custom model id',
    desc: 'type the id into the filter above, then pick this row',
    pinned: true,
    freeText: true,
  });
  return items;
}

// Run the model picker for `provName`, looping on the live-fetch row and
// resolving the free-text row from the typed filter. Returns a concrete
// model id, or null on cancel.
async function _pickModelLoop(ctx, registry, provName) {
  const info = _infoFor(registry, provName);
  let dynamic = [];
  let note = '';
  for (let guard = 0; guard < 50; guard++) {
    const items = _buildModelItems(info, provName, dynamic);
    const picked = await ctx.openPicker({
      kind: 'model',
      title: `select model for ${provName}`,
      subtitle: note || `current: ${ctx.getActiveModel() || '(default)'}`,
      items,
    });
    if (picked == null) return null;
    if (typeof picked === 'object') {
      // free-text custom row → { id, query }
      const typed = String(picked.query || '').trim();
      if (!typed) { note = 'type a model id into the filter first'; continue; }
      return typed;
    }
    if (picked === '__fetch_models__') {
      try {
        const fetcher = typeof ctx.fetchModels === 'function'
          ? ctx.fetchModels
          : (provId) => fetchModelsForProvider({
              cfg: ctx.cfg,
              registryMod: registry,
              resolveAuthKey: (id) => (ctx.resolveAuthKey ? ctx.resolveAuthKey(id) : ''),
              providerId: provId,
            });
        const fetched = await fetcher(provName);
        if (Array.isArray(fetched) && fetched.length) {
          dynamic = fetched;
          note = `fetched ${fetched.length} model(s) — pick one or type a custom id`;
        } else {
          note = 'no models returned — using the suggested list';
        }
      } catch (e) {
        note = `fetch failed: ${e && e.message ? e.message : e}`;
      }
      continue;
    }
    return picked;
  }
  return null;
}

// Flat provider picker used when the active provider is composite and the
// user needs to escape it before choosing a model. Hides composites + mock,
// mirroring the legacy wizard's filter (cli.mjs:1979). (Family grouping +
// add-custom land in P2.)
async function _pickProviderForModel(ctx, registry) {
  const info = registry.PROVIDER_INFO || {};
  const known = Object.keys(registry.PROVIDERS || {})
    .filter((id) => id !== 'mock' && !((info[id] || {}).composite))
    .sort();
  const items = known.map((id) => ({
    id,
    label: id,
    desc: info[id] && info[id].docs ? String(info[id].docs).split('\n')[0].slice(0, 60) : '',
  }));
  const picked = await ctx.openPicker({
    kind: 'provider',
    title: 'select provider (then a model)',
    subtitle: `${ctx.getActiveProvName()} has no selectable models — pick a provider`,
    items,
  });
  return typeof picked === 'string' ? picked : null;
}

async function _model(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  if (!args) {
    if (typeof ctx.openPicker === 'function') {
      let provName = ctx.getActiveProvName();
      let info = _infoFor(registry, provName);
      let switched = false;
      // Composite (orchestrator) or model-less active provider → pick a
      // provider first so the user is never dead-ended on a single row.
      if (_isCompositeProvider(info, provName) || !_hasRealModels(info, provName)) {
        const pickedProv = await _pickProviderForModel(ctx, registry);
        if (!pickedProv) return 'cancelled';
        if (pickedProv !== provName) {
          const next = _providerLookup(registry, pickedProv);
          if (!next) return `unknown provider: ${pickedProv}`;
          if (ctx.setActiveProvName) ctx.setActiveProvName(pickedProv);
          if (ctx.setProv) ctx.setProv(next);
          switched = true;
        }
        provName = pickedProv;
        info = _infoFor(registry, provName);
      }
      const model = await _pickModelLoop(ctx, registry, provName);
      if (model == null) {
        return switched ? `provider → ${provName} (model unchanged)` : 'cancelled';
      }
      if (ctx.setActiveModel) ctx.setActiveModel(model);
      return switched
        ? `provider → ${provName} · model → ${model}`
        : `model → ${model}`;
    }
    return `model: ${ctx.getActiveModel() || '(default)'}\n(pass an arg: /model <name>)`;
  }
  const { parseSlashProviderModel } = registry;
  const parsed = typeof parseSlashProviderModel === 'function'
    ? parseSlashProviderModel(args)
    : { provider: null, model: args };
  if (parsed.provider) {
    const next = _providerLookup(registry, parsed.provider);
    if (!next) return `unknown provider: ${parsed.provider}`;
    if (ctx.setActiveProvName) ctx.setActiveProvName(parsed.provider);
    if (ctx.setProv) ctx.setProv(next);
  }
  const finalModel = parsed.model || args;
  if (ctx.setActiveModel) ctx.setActiveModel(finalModel);
  return `model → ${finalModel}${parsed.provider ? ` (provider → ${parsed.provider})` : ''}`;
}

async function _skill(args, ctx) {
  // `/skill name1,name2` — replace the active system message with a
  // composition. No-arg → clear system message. Mirrors cli.mjs:3046.
  const names = args.split(',').map((s) => s.trim()).filter(Boolean);
  const messages = ctx.getMessages().slice(); // mutable copy
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  const sid = ctx.getSessionId && ctx.getSessionId();
  const sessionsMod = await _mod(ctx, 'sessionsMod', () => import('../sessions.mjs'));

  if (names.length === 0) {
    if (sysIdx >= 0) messages.splice(sysIdx, 1);
    if (ctx.setMessages) ctx.setMessages(messages);
    if (sid) {
      try {
        sessionsMod.resetSession(sid, ctx.cfgDir);
        for (const m of messages) sessionsMod.appendTurn(sid, m.role, m.content, ctx.cfgDir);
      } catch { /* swallow — disk failure shouldn't lose in-memory state */ }
    }
    return 'cleared system prompt (no active skills)';
  }
  try {
    const skillsMod = await _mod(ctx, 'skillsMod', () => import('../skills.mjs'));
    const sys = skillsMod.composeSystemPrompt(names, ctx.cfgDir);
    if (!sys) return 'no skill content composed (empty input?)';
    const nextMsg = { role: 'system', content: sys };
    if (sysIdx >= 0) messages[sysIdx] = nextMsg;
    else messages.unshift(nextMsg);
    if (ctx.setMessages) ctx.setMessages(messages);
    if (sid) {
      try {
        sessionsMod.resetSession(sid, ctx.cfgDir);
        for (const m of messages) sessionsMod.appendTurn(sid, m.role, m.content, ctx.cfgDir);
      } catch { /* swallow */ }
    }
    return `active skills: ${names.join(', ')}`;
  } catch (e) {
    return `skill error: ${e?.message || e}`;
  }
}

async function _tools(_args) {
  let registry;
  try {
    registry = await import('../mas/tools/registry.mjs');
  } catch (e) {
    return `tools unavailable: ${e?.message || e}`;
  }
  const groups = registry.byCategory ? registry.byCategory() : {};
  const cats = Object.keys(groups).sort();
  if (cats.length === 0) return '(no tools registered)';
  const lines = ['available tools (by category):'];
  for (const cat of cats) {
    const items = groups[cat] || [];
    lines.push(`  ${cat}:`);
    for (const t of items) lines.push(`    · ${t.name}${t.description ? ' — ' + t.description : ''}`);
  }
  return lines.join('\n');
}

async function _recall(args, ctx) {
  if (!args) return 'usage: /recall <query>';
  let mem;
  try {
    mem = await import('../memory.mjs');
  } catch (e) {
    return `recall unavailable: ${e?.message || e}`;
  }
  try {
    const text = mem.recall(args, { topN: 5 }, ctx.cfgDir);
    if (!text || !text.trim()) return `no matches for "${args}"`;
    return text;
  } catch (e) {
    return `recall error: ${e?.message || e}`;
  }
}

async function _memory(args, ctx) {
  let mem;
  try { mem = await import('../memory.mjs'); }
  catch (e) { return `memory unavailable: ${e?.message || e}`; }
  const tokens = splitWhitespace(args);
  const which = tokens[0] || 'core';
  if (which === 'core') {
    const body = mem.loadCore(ctx.cfgDir);
    return body || '(empty core memory)';
  }
  if (which === 'recent') {
    const items = mem.loadRecent(20, ctx.cfgDir) || [];
    if (!items.length) return '(no recent memory)';
    return ['recent memory (last ' + items.length + '):',
      ...items.map((it, i) => {
        const role = it.role || 'msg';
        const content = String(it.content || '').replace(/\s+/g, ' ').slice(0, 80);
        return `  ${String(i + 1).padStart(2)}. [${role}] ${content}${(it.content || '').length > 80 ? '…' : ''}`;
      })
    ].join('\n');
  }
  if (which === 'episodic') {
    const topic = tokens[1];
    if (topic) {
      const body = mem.loadEpisodic(topic, ctx.cfgDir);
      return body || `(no episodic file "${topic}")`;
    }
    const items = mem.listEpisodic(ctx.cfgDir) || [];
    if (!items.length) return '(no episodic files yet — run /dream to consolidate)';
    return ['episodic files:',
      ...items.map((it) => `  • ${typeof it === 'string' ? it : (it.topic || JSON.stringify(it))}`)
    ].join('\n');
  }
  return 'usage: /memory [core|recent|episodic [topic]]';
}

async function _dream(_args, ctx, write) {
  let mem;
  try { mem = await import('../memory.mjs'); }
  catch (e) { return `dream unavailable: ${e?.message || e}`; }
  if (typeof write === 'function') {
    try { write('  ↯ dreaming…\n'); } catch { /* swallow */ }
  }
  try {
    const r = await mem.dream(ctx.getSessionId && ctx.getSessionId(), {
      provider: ctx.getProv(),
      model: ctx.getActiveModel(),
      apiKey: ctx.resolveAuthKey ? ctx.resolveAuthKey(ctx.getActiveProvName()) : null,
    }, ctx.cfgDir);
    return `✓ wrote ${r.topics.length} episodic file(s): ${r.topics.join(', ') || '(none)'}`;
  } catch (e) {
    return `dream error: ${e?.message || e}`;
  }
}

async function _agent(args, ctx) {
  let agentsMod, loopMod;
  try {
    agentsMod = await import('../agents.mjs');
    loopMod = await import('../loop-engine.mjs');
  } catch (e) { return `/agent unavailable: ${e?.message || e}`; }
  let tokens;
  try { tokens = loopMod.splitArgs(args); }
  catch (e) { return `/agent error: ${e?.message || e}`; }
  const sub = tokens[0];
  const rest = tokens.slice(1);
  const aname = rest[0];
  try {
    if (!sub || sub === 'list') {
      const agents = agentsMod.listAgents(ctx.cfgDir);
      if (agents.length === 0) return 'no agents registered. /agent add <name> [...] to create.';
      return agents.map((a) => {
        const provLine = a.model ? `${a.provider}/${a.model}` : a.provider;
        return `• ${a.name} — ${a.displayName} — ${provLine} — tools=[${(a.tools || []).join(',')}]`;
      }).join('\n');
    }
    if (sub === 'show') {
      if (!aname) return 'usage: /agent show <name>';
      const a = agentsMod.getAgent(aname, ctx.cfgDir);
      if (!a) return `no agent "${aname}"`;
      return JSON.stringify(a, null, 2);
    }
    if (sub === 'add') {
      if (!aname) return 'usage: /agent add <name> [role text…]';
      const roleText = rest.slice(1).join(' ').trim();
      const a = agentsMod.registerAgent({ name: aname, role: roleText }, ctx.cfgDir);
      return `✓ added agent ${a.name} (tools=${(a.tools || []).join(',')})`;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!aname) return 'usage: /agent remove <name>';
      agentsMod.removeAgent(aname, ctx.cfgDir);
      return `✓ removed agent ${aname}`;
    }
    return `/agent: unknown sub "${sub}" — list|show|add|remove`;
  } catch (e) {
    return `/agent error: ${e?.message || e}`;
  }
}

async function _team(args, ctx) {
  let teamsMod, loopMod;
  try {
    teamsMod = await import('../teams.mjs');
    loopMod = await import('../loop-engine.mjs');
  } catch (e) { return `/team unavailable: ${e?.message || e}`; }
  let tokens;
  try { tokens = loopMod.splitArgs(args); }
  catch (e) { return `/team error: ${e?.message || e}`; }
  const sub = tokens[0];
  const rest = tokens.slice(1);
  const tname = rest[0];
  try {
    if (!sub || sub === 'list') {
      const teams = teamsMod.listTeams(ctx.cfgDir);
      if (teams.length === 0) return 'no teams registered. /team add <name> --agents a,b --lead a [--channel #x]';
      return teams.map((t) => {
        const chLine = t.slackChannel ? ` — ${t.slackChannel}` : '';
        return `• ${t.name} — ${t.displayName} — lead=${t.lead} — agents=[${t.agents.join(',')}]${chLine}`;
      }).join('\n');
    }
    if (sub === 'show') {
      if (!tname) return 'usage: /team show <name>';
      const t = teamsMod.getTeam(tname, ctx.cfgDir);
      if (!t) return `no team "${tname}"`;
      return JSON.stringify(t, null, 2);
    }
    if (sub === 'add') {
      if (!tname) return 'usage: /team add <name> --agents a,b,c [--lead a] [--channel #x]';
      let agentsCsv = null, lead = null, channel = '';
      for (let i = 1; i < rest.length; i++) {
        const t = rest[i];
        if (t === '--agents') agentsCsv = rest[++i] || '';
        else if (t === '--lead') lead = rest[++i] || null;
        else if (t === '--channel') channel = rest[++i] || '';
        else return `/team error: unknown token "${t}"`;
      }
      if (!agentsCsv) return '/team add: --agents is required';
      const agentsList = teamsMod.parseListFlag(agentsCsv);
      const ch = channel ? await teamsMod.resolveSlackChannel(channel, {
        botToken: process.env.SLACK_BOT_TOKEN || null,
        apiBase: process.env.SLACK_API_BASE || 'https://slack.com/api',
        logger: () => {},
      }) : '';
      const team = teamsMod.registerTeam({ name: tname, agents: agentsList, lead, slackChannel: ch }, ctx.cfgDir);
      return `✓ added team ${team.name} (lead=${team.lead}, agents=${team.agents.join(',')})`;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!tname) return 'usage: /team remove <name>';
      teamsMod.removeTeam(tname, ctx.cfgDir);
      return `✓ removed team ${tname}`;
    }
    return `/team: unknown sub "${sub}" — list|show|add|remove`;
  } catch (e) {
    return `/team error: ${e?.message || e}`;
  }
}

async function _loop(args, ctx, write) {
  // v5.4 minimal port: parses + reports. The full streaming loop in
  // cli.mjs:3091 needs an in-Ink writeFn + abort wiring; we ship a faithful
  // single-shot iteration via loop-engine.mjs to avoid silent regressions.
  // For multi-iter the operator can still set LAZYCLAW_NO_INK=1.
  let loopMod;
  try { loopMod = await import('../loop-engine.mjs'); }
  catch (e) { return `loop unavailable: ${e?.message || e}`; }
  if (!args) {
    return [
      'usage: /loop <prompt> [--max N] [--until "<regex>"] [--use-memory] [--recall "<q>"]',
      `  default --max ${loopMod.LOOP_MAX_DEFAULT}, ceiling ${loopMod.LOOP_MAX_CEILING}`,
      `  session: ${ctx.getSessionId && ctx.getSessionId() || '(none — turns will not be persisted)'}`,
      '  press Esc to abort a running loop.',
    ].join('\n');
  }
  let parsed;
  try { parsed = loopMod.parseLoopArgs(args); }
  catch (e) { return `loop error: ${e?.message || e}`; }
  let untilRe = null;
  try { untilRe = loopMod.compileUntil(parsed.until); }
  catch (e) { return `loop error: ${e?.message || e}`; }

  const prov = ctx.getProv();
  if (!prov || typeof prov.sendMessage !== 'function') {
    return 'loop error: no active provider';
  }

  const sendOnce = async (msgs, signal) => {
    let acc = '';
    for await (const chunk of prov.sendMessage(msgs, {
      apiKey: ctx.resolveAuthKey ? ctx.resolveAuthKey(ctx.getActiveProvName()) : null,
      model: ctx.getActiveModel(),
      signal,
      onUsage: ctx.accumulateUsage,
    })) {
      if (typeof write === 'function') { try { write(chunk); } catch {} }
      acc += chunk;
    }
    return acc;
  };

  const messages = ctx.getMessages();
  // --memory / --recall rebuild the system message from disk every iteration
  // (a parallel writer mutating core.md mid-loop is reflected next call). We
  // capture the chat's prior system so it can be restored after the loop.
  const _sysBefore = (messages.find((m) => m.role === 'system') || {}).content ?? null;
  let memMod = null;
  if (parsed.useMemory || parsed.recall) {
    try { memMod = await import('../memory.mjs'); } catch { memMod = null; }
  }
  const buildSystem = memMod ? (() => {
    const parts = [];
    if (parsed.useMemory) {
      const core = memMod.loadCore(ctx.cfgDir);
      if (core && core.trim()) parts.push(core);
    }
    if (parsed.recall) {
      const text = memMod.recall(parsed.recall, { topN: 3 }, ctx.cfgDir);
      if (text && text.trim()) parts.push(text);
    }
    if (_sysBefore) parts.push(_sysBefore);
    return parts.join('\n\n---\n\n');
  }) : null;

  // Use the abort signal the REPL threads in (Esc / Ctrl-C aborts the running
  // loop). Falls back to a fresh controller for non-Ink callers.
  const signal = ctx.loopSignal || new AbortController().signal;
  try {
    const result = await loopMod.runLoop({
      prompt: parsed.prompt,
      max: parsed.max,
      until: untilRe,
      messages,
      sendOnce,
      persist: (role, content) => ctx.persistTurn && ctx.persistTurn(role, content),
      onIteration: ({ i, max }) => {
        if (typeof write === 'function') {
          try { write(`  ↻ loop iteration ${i}/${max}\n`); } catch {}
        }
      },
      signal,
      buildSystem,
    });
    if (ctx.setCharsSent && ctx.getCharsSent) {
      ctx.setCharsSent(ctx.getCharsSent() + parsed.prompt.length * result.iterations);
    }
    const tail = result.stoppedBy === 'until' ? ' (stopped by --until)'
              : result.stoppedBy === 'abort' ? ' (aborted)' : '';
    return `✓ loop done — ${result.iterations}/${parsed.max} iteration(s)${tail}`;
  } catch (err) {
    return `loop error: ${err?.message || String(err)}`;
  } finally {
    // Restore the chat's prior system message — the engine overwrote
    // messages[0] with the per-iteration memory composition.
    if (buildSystem) {
      const sysIdx = messages.findIndex((m) => m.role === 'system');
      if (_sysBefore != null) {
        if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: _sysBefore };
        else messages.unshift({ role: 'system', content: _sysBefore });
      } else if (sysIdx >= 0) {
        messages.splice(sysIdx, 1);
      }
      if (ctx.setMessages) ctx.setMessages(messages);
    }
  }
}

async function _goal(args, ctx) {
  let goalsMod, loopMod, sessionsMod;
  try {
    goalsMod = await import('../goals.mjs');
    loopMod = await import('../loop-engine.mjs');
    sessionsMod = await _mod(ctx, 'sessionsMod', () => import('../sessions.mjs'));
  } catch (e) { return `/goal unavailable: ${e?.message || e}`; }
  if (!args) {
    const items = goalsMod.listGoals(ctx.cfgDir).filter((g) => g.status === 'active');
    if (!items.length) return 'no active goals';
    return items.map((g) =>
      `  ${g.name}${g.description ? ' — ' + g.description : ''}${g.schedule ? ' (cron: ' + g.schedule + ')' : ''}`
    ).join('\n');
  }
  let tokens;
  try { tokens = loopMod.splitArgs(args); }
  catch (e) { return `goal error: ${e?.message || e}`; }
  const sub = tokens[0];
  const rest = tokens.slice(1);

  if (sub === 'add') {
    let name = null, desc = '', cron = null;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--desc') desc = rest[++i] || '';
      else if (t === '--cron') cron = rest[++i] || null;
      else if (t.startsWith('--')) return `goal error: unknown flag ${t}`;
      else if (!name) name = t;
      else return `goal error: unexpected arg "${t}"`;
    }
    if (!name) return 'usage: /goal add <name> [--desc "..."] [--cron "<spec>"]';
    try {
      const g = goalsMod.registerGoal({ name, description: desc, schedule: cron }, ctx.cfgDir);
      let cronNote = '';
      if (cron) {
        // Actually attach the schedule (P3 — was a stub). Needs the config
        // writers the Ink session wires onto ctx; fall back to a CLI hint if
        // they're absent (non-Ink callers).
        if (typeof ctx.readConfig === 'function' && typeof ctx.writeConfig === 'function') {
          try {
            const cronMod = await import('../cron.mjs');
            const r = await attachGoalCron({ readConfig: ctx.readConfig, writeConfig: ctx.writeConfig, cron: cronMod, name: g.name, schedule: cron });
            cronNote = r.skipped ? ' (cron recorded; backend install skipped)' : ' (cron scheduled)';
          } catch (ce) {
            cronNote = ` (cron attach failed: ${ce?.message || ce} — use: lazyclaw goal add ${g.name} --cron "${cron}")`;
          }
        } else {
          cronNote = ' (cron recorded — attach via: lazyclaw goal add --cron)';
        }
      }
      return `✓ goal ${g.name} added (status: active${cron ? `, cron: ${cron}` : ''})${cronNote}`;
    } catch (e) { return `goal error: ${e?.message || e}`; }
  }
  if (sub === 'list') return JSON.stringify(goalsMod.listGoals(ctx.cfgDir), null, 2);
  if (sub === 'show') {
    const name = rest[0];
    if (!name) return 'usage: /goal show <name>';
    const g = goalsMod.getGoal(name, ctx.cfgDir);
    if (!g) return `no goal "${name}"`;
    return JSON.stringify(g, null, 2);
  }
  if (sub === 'close') {
    const name = rest[0];
    const outcome = rest[1] || 'done';
    if (!name) return 'usage: /goal close <name> [done|abandoned]';
    try {
      const g = goalsMod.closeGoal(name, outcome, ctx.cfgDir);
      // Detach any attached cron so a closed goal stops ticking (P3 — the
      // Ink path used to leave it dangling).
      let detachNote = '';
      if (typeof ctx.readConfig === 'function' && typeof ctx.writeConfig === 'function') {
        try {
          const cronMod = await import('../cron.mjs');
          const removed = await detachGoalCron({ readConfig: ctx.readConfig, writeConfig: ctx.writeConfig, cron: cronMod, name: g.name });
          if (removed) detachNote = ' (cron detached)';
        } catch { /* best-effort */ }
      }
      return `✓ goal ${g.name} closed (status: ${g.status})${detachNote}`;
    } catch (e) { return `goal error: ${e?.message || e}`; }
  }
  // single-arg branch: switch
  const goalName = sub;
  const g = goalsMod.getGoal(goalName, ctx.cfgDir);
  if (!g) return `no goal "${goalName}" — try: /goal add ${goalName} --desc "..."`;
  if (g.status !== 'active') return `goal "${goalName}" is ${g.status}; cannot switch`;
  if (ctx.setSessionId) ctx.setSessionId(g.sessionId);
  let prior = [];
  try { prior = sessionsMod.loadTurns(g.sessionId, ctx.cfgDir); }
  catch { prior = []; }
  const nextMsgs = prior.map((t) => ({ role: t.role, content: t.content }));
  const sysIdx = nextMsgs.findIndex((m) => m.role === 'system');
  const goalNote = `## Goal: ${g.description || g.name}`;
  if (sysIdx >= 0) nextMsgs[sysIdx] = { role: 'system', content: `${goalNote}\n\n${nextMsgs[sysIdx].content}` };
  else nextMsgs.unshift({ role: 'system', content: goalNote });
  if (ctx.setMessages) ctx.setMessages(nextMsgs);
  return `✓ switched to goal: ${g.name} (session: ${g.sessionId}, ${prior.length} prior turn(s))`;
}

async function _handoff(args, ctx) {
  const parts = splitWhitespace(args);
  if (parts.length < 2) return 'usage: /handoff <target-channel> <externalId> [--note=...]';
  const target = parts[0];
  const externalId = parts[1];
  const note = (parts.find((p) => p.startsWith('--note=')) || '').slice(7);
  try {
    const { openThreads } = await import('../channels/threads.mjs');
    const { runHandoff } = await import('../channels/handoff.mjs');
    const threads = openThreads(ctx.cfgDir);
    const replState = globalThis.__lazyclawReplState || {};
    const cur = replState.channel && replState.externalId
      ? threads.findByExternal(replState.channel, replState.externalId)
      : null;
    if (!cur) {
      return `handoff: no thread bound to ${replState.channel || '(none)'}:${replState.externalId || '(none)'}`;
    }
    const next = await runHandoff({
      threads, channels: replState.channels || {},
      threadId: cur.threadId, target, externalId, note,
    });
    replState.channel = next.channel;
    replState.externalId = next.externalId;
    return `handoff -> ${next.channel}:${next.externalId} (session ${next.sessionId})`;
  } catch (e) {
    return `handoff failed: ${e.code || 'ERR'}: ${e.message}`;
  }
}

async function _personality(args, ctx) {
  // cmdPersonality in cli.mjs is actually non-interactive (takes
  // sub+a+b args). We mirror that surface here without going through
  // cli.mjs (avoid circular import) — list / show / install / remove /
  // use, plus a no-arg picker over installed personality files.
  let fs, path;
  try {
    fs = await import('node:fs');
    path = await import('node:path');
  } catch (e) { return `/personality unavailable: ${e?.message || e}`; }
  const dir = path.join(ctx.cfgDir, 'personalities');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* swallow */ }

  const list = () => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
    : [];

  const tokens = splitWhitespace(args);
  const sub = tokens[0];
  const a = tokens[1];
  const b = tokens[2];

  // No arg → open Ink modal picker (v5.4.3). Confirm selects + activates.
  if (!sub) {
    const names = list();
    if (!names.length) return 'no personalities installed — `lazyclaw personality install <name> <file.md>`';
    if (typeof ctx.openPicker !== 'function') {
      return `personalities: ${names.join(', ')}\n(pass an arg: /personality use <name>)`;
    }
    const items = names.map((n) => ({ id: n, label: n }));
    const picked = await ctx.openPicker({
      kind: 'personality',
      title: 'select personality',
      subtitle: 'Enter activates · Esc cancels',
      items,
    });
    if (!picked) return 'cancelled';
    return _personalityUse(picked, ctx, fs, path);
  }

  if (sub === 'list') {
    const names = list();
    if (!names.length) return 'no personalities installed';
    return names.join('\n');
  }
  if (sub === 'show') {
    if (!a) return 'usage: /personality show <name>';
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) return `personality not found: ${a}`;
    return fs.readFileSync(p, 'utf8');
  }
  if (sub === 'install') {
    if (!a || !b) return 'usage: /personality install <name> <file.md>';
    const dst = path.join(dir, `${a}.md`);
    if (fs.existsSync(dst)) return `personality already installed: ${a}`;
    if (!fs.existsSync(b)) return `source file not found: ${b}`;
    fs.writeFileSync(dst, fs.readFileSync(b, 'utf8'));
    return `installed ${a}`;
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    if (!a) return 'usage: /personality remove <name>';
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) return `personality not installed: ${a}`;
    fs.unlinkSync(p);
    return `removed ${a}`;
  }
  if (sub === 'use') {
    if (!a) return 'usage: /personality use <name>';
    return _personalityUse(a, ctx, fs, path);
  }
  return `/personality: unknown sub "${sub}" — list|show|install|remove|use (or no-arg picker)`;
}

function _personalityUse(name, ctx, fs, path) {
  const dir = path.join(ctx.cfgDir, 'personalities');
  const p = path.join(dir, `${name}.md`);
  if (!fs.existsSync(p)) return `personality not installed: ${name}`;
  // Read-merge-write config.json so we never clobber unrelated keys.
  const cfgPath = path.join(ctx.cfgDir, 'config.json');
  let diskCfg = {};
  try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
  diskCfg.persona = { ...(diskCfg.persona || {}), personality: name };
  try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
  fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
  // Mirror onto the in-memory cfg so the next turn picks up the change.
  if (ctx.cfg) {
    ctx.cfg.persona = { ...(ctx.cfg.persona || {}), personality: name };
  }
  return `active personality → ${name}`;
}

async function _task(args, ctx) {
  let tasksMod, loopMod;
  try {
    tasksMod = await import('../tasks.mjs');
    loopMod = await import('../loop-engine.mjs');
  } catch (e) { return `/task unavailable: ${e?.message || e}`; }
  let tokens;
  try { tokens = loopMod.splitArgs(args); }
  catch (e) { return `/task error: ${e?.message || e}`; }
  const sub = tokens[0];
  const id = tokens[1];

  try {
    if (!sub || sub === 'list') {
      const items = tasksMod.listTasks(ctx.cfgDir);
      if (!items.length) return 'no tasks. `lazyclaw task start --team ... --title ...` from the shell to create one.';
      return items.map((t) =>
        `• ${t.id} [${t.status || 'unknown'}] ${t.title || '(no title)'}${t.team ? ` — team=${t.team}` : ''}${t.lead ? ` — lead=${t.lead}` : ''}`
      ).join('\n');
    }
    if (sub === 'show') {
      if (!id) return 'usage: /task show <id>';
      const t = tasksMod.getTask(id, ctx.cfgDir);
      if (!t) return `no task "${id}"`;
      return JSON.stringify(t, null, 2);
    }
    if (sub === 'transcript') {
      if (!id) return 'usage: /task transcript <id> [text|md|json]';
      const t = tasksMod.getTask(id, ctx.cfgDir);
      if (!t) return `no task "${id}"`;
      const fmt = tokens[2] || 'text';
      if (typeof tasksMod.formatTranscript === 'function') {
        return tasksMod.formatTranscript(t, fmt);
      }
      return JSON.stringify(t.turns || [], null, 2);
    }
    if (sub === 'abandon' || sub === 'done') {
      if (!id) return `usage: /task ${sub} <id>`;
      const next = tasksMod.patchTask(id, { status: sub === 'done' ? 'done' : 'abandoned' }, ctx.cfgDir);
      return `✓ task ${id} → ${next?.status || sub}`;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!id) return 'usage: /task remove <id>';
      tasksMod.removeTask(id, ctx.cfgDir);
      return `✓ removed task ${id}`;
    }
    if (sub === 'start' || sub === 'tick') {
      return `task ${sub}: needs Slack + multi-agent router — run from the shell:\n  lazyclaw task ${sub} ...`;
    }
    return `/task: unknown sub "${sub}" — list|show|transcript|abandon|done|remove (start/tick: use CLI)`;
  } catch (e) {
    return `/task error: ${e?.message || e}`;
  }
}

async function _trainer(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  const tokens = splitWhitespace(args);
  const sub = tokens[0] || 'show';

  if (sub === 'show') {
    let effective = { provider: ctx.getActiveProvName ? ctx.getActiveProvName() : null,
                      model: ctx.getActiveModel ? ctx.getActiveModel() : null };
    try {
      if (typeof registry.resolveTrainer === 'function') {
        effective = registry.resolveTrainer(ctx.cfg || {});
      }
    } catch { /* fall through */ }
    const configured = (ctx.cfg && ctx.cfg.trainer) || null;
    const cfgRender = configured
      ? JSON.stringify(configured, null, 2)
      : '(unset — trainer mirrors the chat provider/model)';
    return [
      'trainer (effective):',
      `  provider: ${effective.provider}`,
      `  model:    ${effective.model || '(default)'}`,
      'trainer (configured):',
      cfgRender,
    ].join('\n');
  }

  if (sub === 'set') {
    const spec = tokens[1];
    if (!spec) return 'usage: /trainer set <provider>[:<model>]  (or `auto` for orchestrator-managed)';
    const parsed = typeof registry.parseProviderModel === 'function'
      ? registry.parseProviderModel(spec)
      : { provider: spec.split(':')[0], model: spec.split(':')[1] || null };
    if (!parsed || !parsed.provider) return `/trainer set: could not parse "${spec}"`;
    if (parsed.provider !== 'auto') {
      const next = _providerLookup(registry, parsed.provider);
      if (!next) return `/trainer set: unknown provider "${parsed.provider}"`;
    }
    // Optional `--fallback <provider[:model]>` — resolveTrainer routes here
    // when opts.useFallback is set. Validate before persisting.
    let fallbackSpec = null;
    const fi = tokens.indexOf('--fallback');
    if (fi >= 0) {
      fallbackSpec = tokens[fi + 1];
      if (!fallbackSpec) return 'usage: /trainer set <p:m> --fallback <p:m>';
      const fp = _parseProvModel(registry, fallbackSpec);
      if (!fp.provider) return `/trainer set: could not parse fallback "${fallbackSpec}"`;
      if (fp.provider !== 'auto' && !_providerLookup(registry, fp.provider)) {
        return `/trainer set: unknown provider "${fp.provider}"`;
      }
    }
    // Read-merge-write so unrelated cfg keys survive.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfgPath = path.join(ctx.cfgDir, 'config.json');
    let diskCfg = {};
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
    diskCfg.trainer = { ...(diskCfg.trainer || {}), provider: parsed.provider };
    if (parsed.model) diskCfg.trainer.model = parsed.model;
    else delete diskCfg.trainer.model;
    if (fallbackSpec) diskCfg.trainer.fallback = fallbackSpec;
    try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
    if (ctx.cfg) ctx.cfg.trainer = { ...diskCfg.trainer };
    return `✓ trainer → ${parsed.provider}${parsed.model ? ':' + parsed.model : ''}${fallbackSpec ? ` (fallback: ${fallbackSpec})` : ''}`;
  }

  if (sub === 'fallback') {
    const spec = tokens[1];
    if (!spec) return 'usage: /trainer fallback <provider>[:<model>]  |  clear';
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfgPath = path.join(ctx.cfgDir, 'config.json');
    let diskCfg = {};
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
    if (spec === 'clear' || spec === 'unset') {
      if (diskCfg.trainer) delete diskCfg.trainer.fallback;
      try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
      fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
      if (ctx.cfg && ctx.cfg.trainer) delete ctx.cfg.trainer.fallback;
      return '✓ trainer fallback cleared';
    }
    const fp = _parseProvModel(registry, spec);
    if (!fp.provider) return `/trainer fallback: could not parse "${spec}"`;
    if (fp.provider !== 'auto' && !_providerLookup(registry, fp.provider)) {
      return `/trainer fallback: unknown provider "${fp.provider}"`;
    }
    diskCfg.trainer = { ...(diskCfg.trainer || {}), fallback: spec };
    try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
    if (ctx.cfg) ctx.cfg.trainer = { ...diskCfg.trainer };
    return `✓ trainer fallback → ${spec}`;
  }

  if (sub === 'clear' || sub === 'unset') {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfgPath = path.join(ctx.cfgDir, 'config.json');
    let diskCfg = {};
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
    delete diskCfg.trainer;
    try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
    if (ctx.cfg) delete ctx.cfg.trainer;
    return '✓ trainer cleared (will mirror chat provider/model)';
  }

  return `/trainer: unknown sub "${sub}" — show|set <p:m>|clear`;
}

// /dashboard — open the lazyclaw web UI.
//
// v5.4.4 ROOT-CAUSE FIX (was: rapid repeated /dashboard within one chat
// session spawned 20+ daemon children).
//
// Original implementation:
//   probe /healthz → if !200, spawn detached `lazyclaw dashboard
//   --no-open` and poll for up to 3s.
//
// Failure mode that produced the 20+ spawn pile-up:
//   1. User types /dashboard. probe fails (no daemon). Spawn child A.
//   2. Child A begins binding port 19600. Takes ~500ms-2s to be ready.
//   3. User types /dashboard again BEFORE A is ready. probe still fails.
//      Spawn child B. Child B sees EADDRINUSE and calls _killPortOccupant
//      (cli.mjs:3611) which SIGTERMs child A. B takes over.
//   4. Repeat. Each /dashboard kills the previous daemon and starts a
//      new one. With autorepeat / many slash calls this stacks fast.
//
// Two-layer guard:
//   - A module-level _dashboardSpawning latch refuses concurrent spawn
//     attempts. While a spawn is in flight, /dashboard says so + returns
//     without firing another child.
//   - A _dashboardChildPid cache remembers the PID we already spawned;
//     subsequent calls check kill(pid, 0) to confirm the child is alive
//     and just open the browser without spawning.
//
// We probe both /healthz (HTTP) AND a raw net.connect port check so a
// slow-starting daemon (binding the listener but not yet answering HTTP)
// still counts as "running".
let _dashboardSpawning = false;
let _dashboardChildPid = null;

function _portIsListening(port, timeoutMs = 200) {
  return new Promise((resolve) => {
    import('node:net').then(({ createConnection }) => {
      let settled = false;
      const sock = createConnection({ host: '127.0.0.1', port });
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch {}
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      setTimeout(() => done(false), timeoutMs);
    }).catch(() => resolve(false));
  });
}

async function _dashboardProbe(port) {
  // Fast path — port-level probe. Catches a daemon that has bound the
  // socket but hasn't finished initializing its HTTP routes.
  if (await _portIsListening(port, 200)) return true;
  // Slow path — full /healthz fetch, for defense in depth.
  if (typeof fetch !== 'function') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 250);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    clearTimeout(t);
    return !!(r && r.ok);
  } catch { return false; }
}

function _openBrowser(url) {
  return import('node:child_process').then(({ spawn }) => {
    let cmd, args;
    if (process.platform === 'darwin')      { cmd = 'open';     args = [url]; }
    else if (process.platform === 'win32')  { cmd = 'cmd';      args = ['/c', 'start', '""', url]; }
    else                                    { cmd = 'xdg-open'; args = [url]; }
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* swallow */ }
  });
}

async function _dashboardStop(port) {
  // Best-effort kill of every lazyclaw dashboard daemon on the box.
  // Used to clean up after the v5.4.3 spawn pile-up bug.
  if (process.platform === 'win32') {
    return 'dashboard stop: not implemented on Windows yet — kill via Task Manager';
  }
  const { spawn } = await import('node:child_process');
  // Step 1: lsof the port and SIGTERM each PID.
  const portPids = await new Promise((resolve) => {
    try {
      const lsof = spawn('lsof', ['-ti', `tcp:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      lsof.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      lsof.on('error', () => resolve([]));
      lsof.on('close', () => resolve(
        buf.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter(Number.isFinite)
      ));
    } catch { resolve([]); }
  });
  for (const pid of portPids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  // Step 2: pkill any process whose command line includes "lazyclaw dashboard"
  // — catches detached children that bound a different (random) port via
  // cmdDashboard's EADDRINUSE fallback.
  let pkilled = 0;
  try {
    const pkill = spawn('pkill', ['-f', 'lazyclaw dashboard'], { stdio: ['ignore', 'ignore', 'ignore'] });
    pkilled = await new Promise((r) => pkill.on('close', (code) => r(code === 0 ? 1 : 0)));
  } catch { /* fine */ }
  _dashboardChildPid = null;
  return `✓ stopped ${portPids.length} listener(s) on :${port}${pkilled ? ' + remaining `lazyclaw dashboard` processes via pkill' : ''}`;
}

async function _dashboard(args) {
  const port = 19600;
  const url = `http://127.0.0.1:${port}/dashboard`;
  const sub = splitWhitespace(args)[0];
  if (sub === 'stop' || sub === 'kill') return _dashboardStop(port);

  // 1. Already running anywhere on the machine? → reuse.
  if (await _dashboardProbe(port)) {
    await _openBrowser(url);
    return `✓ dashboard already running — opened ${url}`;
  }

  // 2. We spawned in this chat — is that child still alive?
  if (_dashboardChildPid != null) {
    try {
      process.kill(_dashboardChildPid, 0); // signal 0 = liveness probe
      // Child alive but not answering yet. Don't re-spawn; just nudge.
      await _openBrowser(url);
      return `✓ dashboard starting (pid ${_dashboardChildPid}) — opened ${url}`;
    } catch {
      _dashboardChildPid = null; // child died; fall through and respawn.
    }
  }

  // 3. Spawn already in flight from a concurrent /dashboard? Don't pile on.
  if (_dashboardSpawning) {
    await _openBrowser(url);
    return `dashboard is still booting — opened ${url}; try again in a moment if it didn't load`;
  }

  // 4. Cold start. Spawn ONE detached child, poll up to 3s, latch the
  //    spawn flag in a finally so it always clears.
  _dashboardSpawning = true;
  try {
    const { spawn } = await import('node:child_process');
    let child;
    try {
      child = spawn(process.execPath, [process.argv[1], 'dashboard', '--no-open'], {
        detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env,
      });
      child.unref();
      _dashboardChildPid = child.pid;
    } catch (e) {
      return `dashboard error: failed to spawn — ${e?.message || e}`;
    }
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (await _dashboardProbe(port)) {
        await _openBrowser(url);
        return `✓ started dashboard (pid ${child.pid}) — opened ${url}`;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return `⚠ dashboard didn't come up within 3s (pid ${child.pid}). URL: ${url}`;
  } finally {
    _dashboardSpawning = false;
  }
}

// ─── dispatch table ──────────────────────────────────────────────────────

export const SLASH_HANDLERS = new Map([
  ['/help', _help],
  ['/status', _status],
  ['/version', _version],
  ['/usage', _usage],
  ['/new', _newReset],
  ['/reset', _newReset],
  ['/clear', _newReset],
  ['/provider', _provider],
  ['/model', _model],
  ['/skill', _skill],
  ['/skills', _skill],
  ['/tools', _tools],
  ['/recall', _recall],
  ['/memory', _memory],
  ['/dream', _dream],
  ['/agent', _agent],
  ['/team', _team],
  ['/loop', _loop],
  ['/goal', _goal],
  ['/handoff', _handoff],
  ['/personality', _personality],
  ['/task', _task],
  ['/trainer', _trainer],
  ['/dashboard', _dashboard],
  ['/exit', async () => 'EXIT'],
  ['/quit', async () => 'EXIT'],
]);

/**
 * Primary entry point. Resolves the command name to a handler in
 * SLASH_HANDLERS and invokes it. Unknown commands return a friendly
 * "unknown" string (caller renders to scrollback) rather than throwing,
 * so the user sees feedback instead of an error toast.
 */
export async function dispatchSlash(cmd, args, ctx, write) {
  const handler = SLASH_HANDLERS.get(cmd);
  if (!handler) return `unknown slash command: ${cmd} (try /help)`;
  return handler(args || '', ctx || {}, write);
}
