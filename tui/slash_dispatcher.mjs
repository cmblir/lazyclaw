// tui/slash_dispatcher.mjs — single source of slash-command routing for the
// Ink chat REPL (v5.4). Lifted from cli.mjs's legacy readline handler so the
// Ink branch and future channel surfaces share one dispatch table.
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
// Interactive sub-menus that are readline-coupled in cli.mjs surface a hint in
// Ink instead of crashing; pass an arg form (`/provider openai`) or set
// POMPOS_NO_INK=1.

import { SLASH_COMMANDS } from './slash_commands.mjs';
import { nearest } from '../lib/args.mjs';
import {
  pickProviderModel,
  pickProviderDrillIn as _pickProviderDrillIn,
  infoFor as _infoFor,
  providerLookup as _providerLookup,
} from './model_pick.mjs';
import { renderRecord } from '../lib/render.mjs';
import { addCustomProvider } from '../providers/custom_provider.mjs';
import { setAuthKey } from '../providers/auth_store.mjs';
import { runProviderLogin, loginSlash } from './login_flow.mjs';
import { hudSlash } from './hud.mjs';
import { agenticSlash, planSlash, CHAT_MODE_SLASH_COMMANDS } from './chat_mode_slash.mjs';
import { orchestratorSlash, pickAndSetModel } from './orchestrator_flow.mjs';
import { attachGoalCron, detachGoalCron } from '../goals_cron.mjs';
import { loadDotenvIfAny } from '../dotenv_min.mjs';
import { SUBCOMMAND_GROUPS } from './subcommands.mjs';
import { redactSecrets } from '../mas/redact.mjs';
import { splitWhitespace, _mod, _promptText, _promptConfirm, readConfigForMerge, _refuse } from './slash_helpers.mjs';
import { _dashboard, parseDashboardUrl } from './slash_dashboard.mjs';
import { _channels, _context } from './slash_channels.mjs';
import { _trainer } from './slash_trainer.mjs';
import { _workflow } from './slash_workflow.mjs';
import { _team } from './slash_team.mjs';
import { _help, _status, _version, _usage } from './slash_basics.mjs';
import { gatewaySlash } from './slash_gateway.mjs';

// Re-export so callers/tests that import parseDashboardUrl from this module
// (the dispatcher was its original home) keep resolving after the extraction.
export { parseDashboardUrl };

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

// ─── handlers ────────────────────────────────────────────────────────────

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


// Default in-chat approval hook: prompts the operator to confirm each
// sensitive tool call. Used to drive the fail-closed tool runner from the
// Ink REPL, where stdin is owned by Ink so a raw readline prompt can't run.
export function _makeInkApprove(ctx) {
  return async function approve({ tool, args, agent }) {
    const raw = typeof args === 'object' ? JSON.stringify(args) : String(args ?? '');
    const summary = redactSecrets(raw).slice(0, 300);
    const ok = await _promptConfirm(ctx, {
      title: `Approve ${tool}?`,
      subtitle: `agent ${agent}: ${summary}`,
    });
    return { approved: ok, reason: ok ? 'approved in chat' : 'denied in chat' };
  };
}

// Register a custom OpenAI-compatible endpoint with the given fields, set it
// active, and return a summary string. Shared by the arg form and the
// interactive flow.
async function _registerCustom(ctx, registry, { name, baseUrl, apiKey }) {
  if (typeof ctx.readConfig !== 'function' || typeof ctx.writeConfig !== 'function') {
    return 'add custom: config writer unavailable in this session — use: pompos providers add <name> <baseUrl> [apiKey]';
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
    subtitle: 'paste it now, or Esc to skip (set later via: pompos auth)',
    secret: true,
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
  const apiKey = await _promptText(ctx, { title: `api-key for ${name}`, subtitle: 'leave blank for an auth-less endpoint (e.g. local vLLM)', allowEmpty: true, secret: true });
  if (apiKey === null) return 'cancelled';
  return _registerCustom(ctx, registry, { name, baseUrl, apiKey });
}

async function _provider(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  // `/provider add <name> <baseUrl> [apiKey]` — register a custom OpenAI-compat endpoint.
  const addMatch = args && args.match(/^add\s+(.+)$/i);
  if (addMatch) {
    const [name, baseUrl, apiKey] = splitWhitespace(addMatch[1]);
    if (!name || !baseUrl) return 'usage: /provider add <name> <baseUrl> [apiKey]';
    return _registerCustom(ctx, registry, { name, baseUrl, apiKey });
  }
  // No arg → drill-in modal picker (family -> provider); falls back to a hint
  // string when ctx.openPicker isn't available (non-Ink / picker not settled).
  let _fromPicker = false;
  if (!args) {
    if (typeof ctx.openPicker === 'function') {
      const picked = await _pickProviderDrillIn(ctx, registry);
      if (!picked) return 'cancelled';
      if (picked === '__add_custom__') return _addCustomFlow(ctx, registry);
      args = picked;
      _fromPicker = true;
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
  // Keyless CLI not signed in → inline connect menu ('EXIT' = foreground login).
  const r = await runProviderLogin(ctx, args, { promptText: _promptText });
  if (r !== null) return r;
  // Picked from the modal → chain straight into a model pick so provider+model
  // are set together (no separate /model step). Composites have no model list.
  if (_fromPicker && args !== 'orchestrator' && typeof ctx.openPicker === 'function') {
    const mm = await pickAndSetModel(ctx, registry, args);
    if (mm) return `provider → ${args} · ${mm}`;
  }
  return `provider → ${args}`;
}


async function _model(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  if (!args) {
    if (typeof ctx.openPicker === 'function') {
      // Shared canonical picker: provider drill-in (only when the active
      // provider has no models) → model loop with the "⇄ switch provider"
      // and custom-id rows. Session-only — /model does not persist to disk.
      const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
      if (!r) return 'cancelled';
      const switched = r.provider !== ctx.getActiveProvName();
      if (switched) {
        const next = _providerLookup(registry, r.provider);
        if (!next) return `unknown provider: ${r.provider}`;
        if (ctx.setActiveProvName) ctx.setActiveProvName(r.provider);
        if (ctx.setProv) ctx.setProv(next);
      }
      // Model pick cancelled (null) → keep any provider switch, leave model.
      if (r.model == null) {
        return switched ? `provider → ${r.provider} (model unchanged)` : 'cancelled';
      }
      if (ctx.setActiveModel) ctx.setActiveModel(r.model);
      return switched
        ? `provider → ${r.provider} · model → ${r.model}`
        : `model → ${r.model}`;
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
  // `clear`/`unset` are not skill names — treat them as the explicit clear verb
  // so they reach the clear branch instead of being composed as a skill.
  const isClear = /^(clear|unset)$/i.test((args || '').trim());
  const names = isClear ? [] : args.split(',').map((s) => s.trim()).filter(Boolean);
  const messages = ctx.getMessages().slice(); // mutable copy
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  const sid = ctx.getSessionId && ctx.getSessionId();
  const sessionsMod = await _mod(ctx, 'sessionsMod', () => import('../sessions.mjs'));

  if (names.length === 0) {
    // Footgun guard: bare `/skill` used to silently wipe the active skills.
    // Now no-arg opens the skill picker; clearing requires explicit /skill clear.
    if (!isClear) {
      if (typeof ctx.openPicker === 'function') return _skillsList('', ctx);
      return 'usage: /skill <name>[,<name>]  ·  /skill clear to unset  ·  /skills to pick';
    }
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

// /skills — list + pick installed skills (the v5.4 alias only forwarded to
// _skill, which activates/clears but never *shows* what's available). With an
// arg it activates directly (like /skill); with no arg it opens a picker (or
// lists, or — when nothing is installed — explains how to install).
async function _skillsList(args, ctx) {
  if (args && args.trim()) return _skill(args, ctx);
  const skillsMod = await _mod(ctx, 'skillsMod', () => import('../skills.mjs'));
  let names = [];
  try { names = (skillsMod.listSkills(ctx.cfgDir) || []).map((s) => s.name).filter(Boolean); }
  catch (e) { return `skills unavailable: ${e?.message || e}`; }
  if (!names.length) {
    return [
      'no skills installed.',
      'starter pack:  pompos skills starter',
      'install more:  pompos skills install <owner>/<repo>',
      'then /skills to pick, or /skill <name>[,<name>] to activate.',
    ].join('\n');
  }
  if (typeof ctx.openPicker === 'function') {
    const picked = await ctx.openPicker({
      kind: 'skill',
      title: 'activate a skill',
      subtitle: `${names.length} installed · Enter activates · Esc cancels`,
      items: names.map((n) => ({ id: n, label: n, desc: '' })),
    });
    if (!picked) return 'cancelled';
    return _skill(typeof picked === 'string' ? picked : picked.id, ctx);
  }
  return `installed skills (${names.length}):\n${names.map((n) => `  · ${n}`).join('\n')}\n(activate: /skill <name>[,<name>])`;
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
  if (!tokens.length && typeof ctx.openPicker === 'function') {
    const picked = await ctx.openPicker({
      kind: 'menu', title: 'Memory', subtitle: 'view a memory store',
      items: [
        { id: 'core', label: 'Core', desc: 'persistent core memory' },
        { id: 'recent', label: 'Recent', desc: 'last ~20 messages' },
        { id: 'episodic', label: 'Episodic', desc: 'consolidated topic files' },
      ],
    });
    const pid = picked && typeof picked === 'object' ? picked.id : picked;
    return _memory(typeof pid === 'string' && pid ? pid : 'core', ctx);
  }
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
    if (!sub && typeof ctx.openPicker === 'function') {
      const picked = await ctx.openPicker({
        kind: 'menu', title: 'Agents', subtitle: `${agentsMod.listAgents(ctx.cfgDir).length} registered`,
        items: [
          { id: 'list', label: 'List agents', desc: 'show all' },
          { id: 'add', label: 'Add agent…', desc: '/agent add <name> [role]' },
          { id: 'edit', label: 'Edit agent…', desc: 'pick provider + model' },
          { id: 'show', label: 'Show agent…', desc: 'print one record' },
          { id: 'remove', label: 'Remove agent…', desc: 'delete a record' },
        ],
      });
      const pid = picked && typeof picked === 'object' ? picked.id : picked;
      return _agent(typeof pid === 'string' && pid ? pid : 'list', ctx);
    }
    if (!sub || sub === 'list') {
      const agents = agentsMod.listAgents(ctx.cfgDir);
      if (agents.length === 0) return 'no agents registered. /agent add <name> [...] to create.';
      return agents.map((a) => {
        const provLine = a.model ? `${a.provider}/${a.model}` : a.provider;
        return `• ${a.name} — ${a.displayName} — ${provLine} — tools=[${(a.tools || []).join(',')}]`;
      }).join('\n');
    }
    if (sub === 'show') {
      if (!aname) return 'usage: /agent show <name> [json]';
      const a = agentsMod.getAgent(aname, ctx.cfgDir);
      if (!a) return `no agent "${aname}"`;
      return rest[1] === 'json'
        ? JSON.stringify(a, null, 2)
        : renderRecord(a, { fields: ['name', 'displayName', 'provider', 'model', 'role', 'tools', 'tags', 'iconEmoji', 'memoryWrite', 'skillWrite', 'createdAt', 'updatedAt'] });
    }
    if (sub === 'add') {
      let name = aname;
      // --provider/--model so the dashboard can create an agent as fully as
      // the REST route it replaced; the rest becomes the role, as always. A
      // value that is itself another flag (`--provider --model opus`) is
      // rejected rather than silently stored as provider:"--model"; a flag
      // with nothing after it at all (end-of-args) still defaults silently.
      let provider, model;
      const roleWords = [];
      for (let i = 1; i < rest.length; i += 1) {
        const t = rest[i];
        if (t === '--provider' || t === '--model') {
          const value = rest[i + 1];
          if (value !== undefined && value.startsWith('--')) {
            return _refuse(ctx, `/agent add: ${t} needs a value, got "${value}"`);
          }
          if (t === '--provider') provider = value;
          else model = value;
          i += 1; // consume the value token too
        } else {
          roleWords.push(t);
        }
      }
      let roleText = roleWords.join(' ').trim();
      // Guided fill: no name typed + a modal available → prompt for it. A
      // declined prompt (Esc) is "cancelled", not a refusal — left off
      // ctx.__persistFailed, matching how the dashboard treats CANCELLED.
      if (!name && typeof ctx.openPicker === 'function') {
        name = await _promptText(ctx, { title: 'New agent — name', subtitle: 'short id, e.g. scout (Esc cancels)' });
        if (!name) return 'agent add: cancelled';
        if (!roleText) {
          const r = await _promptText(ctx, { title: `Role for ${name}`, subtitle: 'one line describing what this agent does (Esc to skip)', allowEmpty: true });
          roleText = r || '';
        }
      }
      if (!name) return _refuse(ctx, 'usage: /agent add <name> [--provider <p>] [--model <m>] [role text…]');
      let a;
      try {
        a = agentsMod.registerAgent({ name, role: roleText, provider, model }, ctx.cfgDir);
      } catch (e) {
        // e.g. AGENT_EXISTS — throws before any write, so nothing changed;
        // the outer catch below used to return this ok:true.
        return _refuse(ctx, `/agent add: ${e?.message || e}`);
      }
      const modelHint = a.model ? '' : ` — set its model with /agent edit ${a.name}`;
      return `✓ added agent ${a.name} (tools=${(a.tools || []).join(',')})${modelHint}`;
    }
    if (sub === 'edit') {
      if (!aname) return _refuse(ctx, 'usage: /agent edit <name>');
      const existing = agentsMod.getAgent(aname, ctx.cfgDir);
      if (!existing) return _refuse(ctx, `no agent "${aname}"`);
      if (typeof ctx.openPicker !== 'function') {
        return `agent edit: picker unavailable here — use: pompos agent edit ${aname} --provider <p> --model <m>`;
      }
      const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
      const r = await pickProviderModel(ctx, registry, { pickProvider: true, includeDefault: true, includeSwitch: false });
      if (!r || r.model == null) return 'agent edit: cancelled';
      const patched = agentsMod.patchAgent(aname, { provider: r.provider, model: r.model || '' }, ctx.cfgDir);
      return `✓ ${patched.name} → ${patched.provider}${patched.model ? '/' + patched.model : ''}`;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!aname) return _refuse(ctx, 'usage: /agent remove <name>');
      if (typeof ctx.openPicker === 'function') {
        const ok = await _promptConfirm(ctx, { title: `Remove agent "${aname}"?`, subtitle: 'This cannot be undone. Enter selects · Esc cancels' });
        if (!ok) return `agent remove: cancelled — "${aname}" not removed`;
      }
      agentsMod.removeAgent(aname, ctx.cfgDir);
      return `✓ removed agent ${aname}`;
    }
    return `/agent: unknown sub "${sub}" — list|show|add|edit|remove`;
  } catch (e) {
    // removeAgent (and patchAgent, via `edit`) validate/check existence
    // BEFORE writing — e.g. removing a name that is not registered — so
    // nothing changed on disk when this throws. Returning the message
    // directly used to report ok:true over HTTP for the same reason the
    // explicit refusals above exist.
    return _refuse(ctx, `/agent error: ${e?.message || e}`);
  }
}

async function _loop(args, ctx, write) {
  // v5.4 minimal port: parses + reports. The full streaming loop in
  // cli.mjs:3091 needs an in-Ink writeFn + abort wiring; we ship a faithful
  // single-shot iteration via loop-engine.mjs to avoid silent regressions.
  // For multi-iter the operator can still set POMPOS_NO_INK=1.
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
    if (typeof ctx.openPicker === 'function') {
      const active = goalsMod.listGoals(ctx.cfgDir).filter((g) => g.status === 'active');
      const picked = await ctx.openPicker({
        kind: 'menu', title: 'Goals', subtitle: `${active.length} active`,
        items: [
          { id: 'list', label: 'List goals', desc: 'show all' },
          { id: 'add', label: 'Add goal…', desc: '/goal add <name> [--desc] [--cron]' },
          { id: 'show', label: 'Show goal…', desc: 'print one record' },
          { id: 'close', label: 'Close goal…', desc: 'mark done/abandoned' },
          ...active.map((g) => ({ id: g.name, label: `↪ switch: ${g.name}`, desc: g.description || '' })),
        ],
      });
      const pid = picked && typeof picked === 'object' ? picked.id : picked;
      if (pid && typeof pid === 'string') return _goal(pid, ctx);
      // cancelled → fall through to the text list below
    }
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
    // Guided fill: no name + a modal available → prompt name + desc, and offer
    // a cron preset picker instead of a hand-typed spec. Typed form unchanged.
    if (!name && typeof ctx.openPicker === 'function') {
      name = await _promptText(ctx, { title: 'New goal — name', subtitle: 'short id (Esc cancels)' });
      if (!name) return 'goal add: cancelled';
      if (!desc) {
        const d = await _promptText(ctx, { title: `Goal "${name}" — description`, subtitle: 'what is this goal? (Esc to skip)', allowEmpty: true });
        desc = d || '';
      }
      if (!cron) {
        const cp = await ctx.openPicker({
          kind: 'menu', title: 'Schedule (optional)', subtitle: 'run this goal on a cron?',
          items: [
            { id: '', label: 'none', desc: 'no schedule' },
            { id: '0 9 * * *', label: 'daily 09:00', desc: '0 9 * * *' },
            { id: '0 * * * *', label: 'hourly', desc: '0 * * * *' },
            { id: '0 9 * * 1', label: 'weekly (Mon 09:00)', desc: '0 9 * * 1' },
            { id: '__custom__', label: 'custom…', desc: 'type a cron spec', freeText: true },
          ],
        });
        if (cp && typeof cp === 'object' && cp.id === '__custom__') cron = String(cp.query || '').trim() || null;
        else { const cid = cp && typeof cp === 'object' ? cp.id : cp; cron = cid && typeof cid === 'string' ? cid : null; }
      }
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
            cronNote = ` (cron attach failed: ${ce?.message || ce} — use: pompos goal add ${g.name} --cron "${cron}")`;
          }
        } else {
          cronNote = ' (cron recorded — attach via: pompos goal add --cron)';
        }
      }
      return `✓ goal ${g.name} added (status: active${cron ? `, cron: ${cron}` : ''})${cronNote}`;
    } catch (e) { return `goal error: ${e?.message || e}`; }
  }
  if (sub === 'list') return JSON.stringify(goalsMod.listGoals(ctx.cfgDir), null, 2);
  if (sub === 'show') {
    const name = rest[0];
    if (!name) return 'usage: /goal show <name> [json]';
    const g = goalsMod.getGoal(name, ctx.cfgDir);
    if (!g) return `no goal "${name}"`;
    return rest[1] === 'json'
      ? JSON.stringify(g, null, 2)
      : renderRecord(g, { fields: ['name', 'status', 'description', 'schedule', 'channels', 'createdAt', 'memoryPath'] });
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
      return `✓ goal ${g.name} closed (status: ${g.status})${detachNote} — start a fresh goal with /goal add ${g.name} --desc "..."`;
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
    const replState = globalThis.__pomposReplState || {};
    const cur = replState.channel && replState.externalId
      ? threads.findByExternal(replState.channel, replState.externalId)
      : null;
    if (!cur) {
      return `handoff: no thread bound to this conversation — /handoff moves a channel-bound thread (e.g. a Slack conversation on the daemon), not the local chat REPL (channel ${replState.channel || 'none'}).`;
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
    if (!names.length) return 'no personalities installed — `pompos personality install <name> <file.md>`';
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
    let nm = a, src = b;
    // Guided fill: missing name/file + a modal → prompt for them, and retry on
    // a bad path instead of erroring out (up to a few attempts).
    if ((!nm || !src) && typeof ctx.openPicker === 'function') {
      if (!nm) {
        nm = await _promptText(ctx, { title: 'Install personality — name', subtitle: 'short id to install it as (Esc cancels)' });
        if (!nm) return 'personality install: cancelled';
      }
      if (fs.existsSync(path.join(dir, `${nm}.md`))) return `personality already installed: ${nm}`;
      for (let attempt = 0; attempt < 3 && !src; attempt++) {
        const p = await _promptText(ctx, { title: `Source file for ${nm}`, subtitle: attempt ? 'not found — try again (Esc cancels)' : 'path to a .md file (Esc cancels)' });
        if (!p) return 'personality install: cancelled';
        if (fs.existsSync(p)) { src = p; break; }
      }
      if (!src) return 'personality install: source file not found after 3 tries';
    }
    if (!nm || !src) return 'usage: /personality install <name> <file.md>';
    const dst = path.join(dir, `${nm}.md`);
    if (fs.existsSync(dst)) return `personality already installed: ${nm}`;
    if (!fs.existsSync(src)) return `source file not found: ${src}`;
    fs.writeFileSync(dst, fs.readFileSync(src, 'utf8'));
    return `installed ${nm}`;
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    if (!a) return 'usage: /personality remove <name>';
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) return `personality not installed: ${a}`;
    if (typeof ctx.openPicker === 'function') {
      const ok = await _promptConfirm(ctx, { title: `Remove personality "${a}"?`, subtitle: 'This cannot be undone. Enter selects · Esc cancels' });
      if (!ok) return `personality remove: cancelled — "${a}" not removed`;
    }
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
  // A missing file is fresh; an unparseable one is not ours to discard — see
  // readConfigForMerge's doc comment. Refusing also trips ctx.__persistFailed,
  // the same signal /provider and /model use (daemon/lib/slash_ctx.mjs), so
  // the HTTP envelope reports {ok:false} instead of the caller reading prose
  // to guess whether this succeeded.
  const merged = readConfigForMerge(cfgPath, fs);
  if (merged.error) { ctx.__persistFailed = merged.error; return merged.error; }
  const diskCfg = merged.cfg;
  diskCfg.persona = { ...(diskCfg.persona || {}), personality: name };
  try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
  fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
  // Mirror onto the in-memory cfg so the next turn picks up the change.
  if (ctx.cfg) {
    ctx.cfg.persona = { ...(ctx.cfg.persona || {}), personality: name };
  }
  return `active personality → ${name}`;
}

async function _task(args, ctx, write) {
  let tasksMod, loopMod;
  try {
    tasksMod = await _mod(ctx, 'tasksMod', () => import('../tasks.mjs'));
    loopMod = await _mod(ctx, 'loopMod', () => import('../loop-engine.mjs'));
  } catch (e) { return `/task unavailable: ${e?.message || e}`; }
  let tokens;
  try { tokens = loopMod.splitArgs(args); }
  catch (e) { return `/task error: ${e?.message || e}`; }
  const sub = tokens[0];
  const id = tokens[1];

  try {
    if (!sub && typeof ctx.openPicker === 'function') {
      const picked = await ctx.openPicker({
        kind: 'menu', title: 'Tasks', subtitle: `${tasksMod.listTasks(ctx.cfgDir).length} task(s)`,
        items: [
          { id: 'list', label: 'List tasks', desc: 'show all' },
          { id: 'start', label: 'Start task…', desc: 'open a new multi-agent task' },
          { id: 'tick', label: 'Tick task…', desc: 'one router turn' },
          { id: 'show', label: 'Show task…', desc: 'print a record' },
          { id: 'transcript', label: 'Transcript…', desc: 'dump turns' },
          { id: 'done', label: 'Mark done…', desc: 'close a task' },
          { id: 'abandon', label: 'Abandon…', desc: 'abandon a task' },
          { id: 'remove', label: 'Remove…', desc: 'delete a task' },
        ],
      });
      const pid = picked && typeof picked === 'object' ? picked.id : picked;
      return _task(typeof pid === 'string' && pid ? pid : 'list', ctx, write);
    }
    if (!sub || sub === 'list') {
      const items = tasksMod.listTasks(ctx.cfgDir);
      if (!items.length) return 'no tasks yet. /task start <team> --title "..." to create one.';
      return items.map((t) =>
        `• ${t.id} [${t.status || 'unknown'}] ${t.title || '(no title)'}${t.team ? ` — team=${t.team}` : ''}${t.lead ? ` — lead=${t.lead}` : ''}`
      ).join('\n');
    }
    if (sub === 'show') {
      if (!id) return 'usage: /task show <id> [json]';
      const t = tasksMod.getTask(id, ctx.cfgDir);
      if (!t) return `no task "${id}"`;
      return tokens[2] === 'json'
        ? JSON.stringify(t, null, 2)
        : renderRecord(t, { fields: ['id', 'status', 'title', 'description', 'team', 'lead', 'slackChannel', 'createdAt', 'updatedAt'] });
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
      if (!id) return _refuse(ctx, `usage: /task ${sub} <id>`);
      const target = sub === 'done' ? 'done' : 'abandoned';
      const next = tasksMod.patchTask(id, { status: target }, ctx.cfgDir);
      // Best-effort closing post in the original Slack thread (parity with the
      // CLI cmdTask), so collaborators see the resolution. Never rolls back
      // the status change.
      let slackNote = '';
      if (next && next.slackChannel && next.slackThreadTs) {
        try {
          loadDotenvIfAny(ctx.cfgDir);
          const SlackChannel = ctx.SlackChannel || (await import('../channels/slack.mjs')).SlackChannel;
          const slack = new SlackChannel({ requireInbound: false });
          await slack.start(async () => '', {});
          const threadId = `${next.slackChannel}:${next.slackThreadTs}`;
          const msg = target === 'done'
            ? `:white_check_mark: Task *${next.title}* marked done.`
            : `:no_entry: Task *${next.title}* abandoned.`;
          await slack.send(threadId, msg);
          await slack.stop().catch(() => {});
          slackNote = ' (posted to Slack thread)';
        } catch (e) { slackNote = ` (Slack post failed: ${e?.message || e})`; }
      }
      return `✓ task ${id} → ${next?.status || target}${slackNote}`;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!id) return _refuse(ctx, 'usage: /task remove <id>');
      if (typeof ctx.openPicker === 'function') {
        const ok = await _promptConfirm(ctx, { title: `Remove task ${id}?`, subtitle: 'This cannot be undone. Enter selects · Esc cancels' });
        if (!ok) return `task remove: cancelled — ${id} not removed`;
      }
      tasksMod.removeTask(id, ctx.cfgDir);
      return `✓ removed task ${id}`;
    }
    if (sub === 'start') {
      // /task start <team> --title "..." [--description "..."] [--lead <name>]
      const teamsMod = await _mod(ctx, 'teamsMod', () => import('../teams.mjs'));
      const agentsMod = await _mod(ctx, 'agentsMod', () => import('../agents.mjs'));
      const rest = tokens.slice(1);
      let teamName = null, title = '', description = '', lead = null;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === '--title') title = rest[++i] || '';
        else if (t === '--description' || t === '--desc') description = rest[++i] || '';
        else if (t === '--lead') lead = rest[++i] || null;
        else if (!teamName && !t.startsWith('--')) teamName = t;
      }
      // Guided fill: missing team/title + a modal available → pick the team
      // from the registry and prompt for a title. Typed form unchanged.
      if ((!teamName || !title) && typeof ctx.openPicker === 'function') {
        if (!teamName) {
          const teams = teamsMod.listTeams(ctx.cfgDir);
          if (!teams.length) return _refuse(ctx, 'task start: no teams yet — create one with /team add first');
          const tp = await ctx.openPicker({ kind: 'menu', title: 'Start task — pick a team', items: teams.map((t) => ({ id: t.name, label: t.name, desc: `lead=${t.lead || '?'} · agents=${(t.agents || []).join(',')}` })) });
          teamName = tp && typeof tp === 'object' ? tp.id : tp;
          if (!teamName || typeof teamName !== 'string') return 'task start: cancelled';
        }
        if (!title) {
          title = await _promptText(ctx, { title: `Task title (team: ${teamName})`, subtitle: 'one line describing the task (Esc cancels)' });
          if (!title) return 'task start: cancelled';
        }
        if (!description) {
          const d = await _promptText(ctx, { title: 'Task description', subtitle: 'optional detail (Esc to skip)', allowEmpty: true });
          description = d || '';
        }
      }
      if (!teamName || !title) return _refuse(ctx, 'usage: /task start <team> --title "..." [--description "..."] [--lead <name>]');
      const team = teamsMod.getTeam(teamName, ctx.cfgDir);
      if (!team) return _refuse(ctx, `no team "${teamName}"`);
      const leadName = lead || team.lead;
      const leadAgent = agentsMod.getAgent(leadName, ctx.cfgDir);
      const seeded = tasksMod.registerTask(
        { title, description, team: teamName, lead: leadName, slackChannel: team.slackChannel, status: 'pending' },
        ctx.cfgDir,
      );
      let ts = '';
      if (team.slackChannel) {
        try {
          loadDotenvIfAny(ctx.cfgDir);
          const SlackChannel = ctx.SlackChannel || (await import('../channels/slack.mjs')).SlackChannel;
          const slack = new SlackChannel({ requireInbound: false });
          await slack.start(async () => '', {});
          const text = tasksMod.buildKickoffMessage({
            id: seeded.id, title: seeded.title, description: seeded.description,
            leadDisplayName: (leadAgent && leadAgent.displayName) || leadName,
            teamDisplayName: team.displayName || team.name,
          });
          const res = await slack.send(team.slackChannel, text);
          ts = (res && res.ts) || '';
          await slack.stop().catch(() => {});
        } catch (e) {
          // The task record was already written above (registerTask); this
          // best-effort rollback is the only thing standing between "the
          // Slack post failed" and "a task now exists that nobody was told
          // about" — either way, the /task start the operator asked for did
          // not complete, so this must not read as success over HTTP.
          try { tasksMod.removeTask(seeded.id, ctx.cfgDir); } catch { /* best-effort */ }
          return _refuse(ctx, `task start: ${e?.message || e}`);
        }
      }
      const turns = ts ? [{ agent: 'system', text: `Task opened by user. Lead: ${leadName}.`, ts }] : [];
      const finalTask = tasksMod.patchTask(seeded.id, { slackThreadTs: ts, status: ts ? 'running' : 'pending', turns }, ctx.cfgDir);
      return `✓ task ${finalTask.id} started (status: ${finalTask.status}${ts ? `, slack thread ${ts}` : ', no Slack thread'})`;
    }
    if (sub === 'tick') {
      // /task tick <id> [message] — one multi-agent router turn. The router
      // emits through a logger callback (not raw stdout), so it runs inline in
      // the Ink chat with output routed through `write`.
      if (!id) return 'usage: /task tick <id> [message]';
      const teamsMod = await _mod(ctx, 'teamsMod', () => import('../teams.mjs'));
      const agentsMod = await _mod(ctx, 'agentsMod', () => import('../agents.mjs'));
      const task = tasksMod.getTask(id, ctx.cfgDir);
      if (!task) return `no task "${id}"`;
      const team = teamsMod.getTeam(task.team, ctx.cfgDir);
      if (!team) return `task tick: team "${task.team}" disappeared`;
      const agentsById = {};
      for (const name of team.agents) {
        const rec = agentsMod.getAgent(name, ctx.cfgDir);
        if (!rec) return `task tick: agent "${name}" disappeared`;
        agentsById[name] = rec;
      }
      loadDotenvIfAny(ctx.cfgDir);
      const router = await _mod(ctx, 'routerMod', () => import('../mas/mention_router.mjs'));
      const leadAgent = agentsById[team.lead];
      const apiKey = ctx.resolveAuthKey ? ctx.resolveAuthKey(leadAgent.provider) : '';
      const baseUrl = ctx.resolveBaseUrl ? ctx.resolveBaseUrl(leadAgent.provider) : undefined;
      const userMsg = tokens.slice(2).join(' ').trim();
      try {
        if (typeof write === 'function') { try { write('  ↻ running task turn…\n'); } catch {} }
        // Default-on isolation: confine every tool the team runs. Lazy-imported
        // so the sandbox backends stay off the chat module-load path.
        const { defaultSandboxSpec } = await import('../sandbox/index.mjs');
        const result = await router.runTaskTurn({
          task, team, agentsById,
          userMessage: userMsg || undefined,
          configDir: ctx.cfgDir,
          apiKey, baseUrl,
          logger: (line) => { if (typeof write === 'function') { try { write(line); } catch {} } },
          approve: _makeInkApprove(ctx),
          security: ctx.cfg?.security,
          sandbox: defaultSandboxSpec(ctx.cfg, { cwd: process.cwd(), configDir: ctx.cfgDir }),
        });
        return `✓ task ${result.task.id} → ${result.task.status} (${result.iterations} agent turn(s)${result.stoppedBy ? `, stopped by ${result.stoppedBy}` : ''})`;
      } catch (e) {
        return `task tick: ${e?.message || e}`;
      }
    }
    return `/task: unknown sub "${sub}" — start|tick|list|show|transcript|abandon|done|remove`;
  } catch (e) {
    // patchTask/removeTask (done, abandon, remove) check existence BEFORE
    // writing, so a bad id throws with nothing changed on disk. Returning
    // the message directly used to report ok:true over HTTP for the same
    // reason the explicit refusals above exist.
    return _refuse(ctx, `/task error: ${e?.message || e}`);
  }
}

// /trainer — moved to ./slash_trainer.mjs (Group 4) so the set/fallback/show/
// clear branches can grow off this file's size ratchet.

// /menu — in-chat command palette over the full subcommand catalog. The
// no-arg launcher menu used to be the home screen; defaulting to chat hid it
// behind `pompos menu`. This restores discoverability: browse subcommands
// and get the exact command to run. (Most subcommands own stdout / spawn, so
// they can't safely run inline in the Ink scrollback — we echo the command.)
async function _menu(args, ctx, write) {
  if (typeof ctx.openPicker === 'function') {
    const items = [];
    const seen = new Set();
    for (const [group, cmds] of SUBCOMMAND_GROUPS) {
      for (const c of cmds) {
        if (seen.has(c)) continue;
        seen.add(c);
        // Mark which subcommands can run in-chat (a /slash equivalent exists).
        const inChat = SLASH_HANDLERS.has(`/${c}`);
        items.push({ id: c, label: c, desc: inChat ? `${group} · runs in chat` : group });
      }
    }
    const picked = await ctx.openPicker({
      kind: 'menu',
      title: 'pompos subcommands',
      subtitle: 'Enter runs it in chat (or shows the shell command) · Esc cancels',
      items,
    });
    if (!picked) return 'cancelled';
    const cmd = typeof picked === 'string' ? picked : picked.id;
    // If there's an in-chat slash equivalent, dispatch it directly instead of
    // telling the user to leave chat.
    const handler = SLASH_HANDLERS.get(`/${cmd}`);
    if (handler) return handler('', ctx, write);
    return `run from a shell:  pompos ${cmd}`;
  }
  return [
    'subcommands:',
    ...SUBCOMMAND_GROUPS.map(([g, cmds]) => `  ${g.padEnd(9)} ${cmds.join(' ')}`),
    '(run: pompos <subcommand>)',
  ].join('\n');
}

// /orchestrator — moved to ./orchestrator_flow.mjs (orchestratorSlash) so the
// interactive fetch+pick planner/worker editor can grow off the ratchet.
// /channels + /context — moved to ./slash_channels.mjs (Group 3) so they can
// grow off this file's size ratchet.

// /agentic + /plan live in ./chat_mode_slash.mjs (Group 1) — kept out of this
// file (at its size ratchet) so the toggles can grow there. Register their
// catalog rows in the shared SLASH_COMMANDS so /help, the popup,
// ghost-autocomplete, and the d6 drift-guard see them (idempotent — ESM runs
// module init once; appended per the catalog's ordering note).
for (const entry of CHAT_MODE_SLASH_COMMANDS) {
  if (!SLASH_COMMANDS.some((c) => c.cmd === entry.cmd)) SLASH_COMMANDS.push(entry);
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
  ['/login', (a, ctx) => loginSlash(a, ctx, { promptText: _promptText })],
  ['/hud', hudSlash],
  ['/agentic', agenticSlash],
  ['/plan', planSlash],
  ['/model', _model],
  ['/skill', _skill],
  ['/skills', _skillsList],
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
  ['/workflow', _workflow],
  ['/trainer', _trainer],
  ['/dashboard', _dashboard],
  ['/gateway', gatewaySlash],
  ['/menu', _menu],
  ['/channels', _channels],
  ['/orchestrator', orchestratorSlash],
  ['/context', _context],
  // /setup — full wizard (every step); /config — pick ONE setting to change
  // (in-chat where possible; credential steps unmount, run, re-enter chat).
  ['/setup', async (_a, ctx) => { ctx.requestSetup = true; return 'EXIT'; }],
  ['/config', async (a, ctx) => (await import('./config_picker.mjs')).runConfigSlash(a, ctx, SLASH_HANDLERS)],
  ['/exit', async () => 'EXIT'],
  ['/quit', async () => 'EXIT'],
]);

/**
 * Primary entry point. Resolves the command name to a SLASH_HANDLERS entry
 * and invokes it. Unknown commands return a friendly "unknown" string
 * (rendered to scrollback) rather than throwing.
 */
export async function dispatchSlash(cmd, args, ctx, write) {
  const handler = SLASH_HANDLERS.get(cmd);
  if (!handler) {
    const hint = nearest(cmd, [...SLASH_HANDLERS.keys()]);
    return `unknown slash command: ${cmd}${hint ? ` — did you mean ${hint}?` : ''} (try /help)`;
  }
  return handler(args || '', ctx || {}, write);
}
