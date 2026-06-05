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
  const out = {
    provider: ctx.getActiveProvName(),
    model: ctx.getActiveModel(),
    keyMasked: registry.maskApiKey(ctx.cfg && ctx.cfg['api-key']),
    messageCount: ctx.getMessages().length,
    sessionId: ctx.getSessionId() || null,
  };
  return JSON.stringify(out);
}

async function _version(_args, ctx) {
  const v = ctx.version || '0.0.0';
  return `lazyclaw ${v} (node ${process.version}, ${process.platform})`;
}

async function _usage(_args, ctx) {
  const msgs = ctx.getMessages();
  const runningUsage = ctx.getRunningUsage && ctx.getRunningUsage();
  const out = {
    messageCount: msgs.length,
    charsSent: (ctx.getCharsSent && ctx.getCharsSent()) || 0,
  };
  if (runningUsage) out.tokens = runningUsage;
  if (runningUsage && ctx.cfg && ctx.cfg.rates && typeof ctx.cfg.rates === 'object') {
    try {
      const { costFromUsage } = await import('../providers/rates.mjs');
      const r = costFromUsage(
        { provider: ctx.getActiveProvName(), model: ctx.getActiveModel(), usage: runningUsage },
        ctx.cfg.rates,
      );
      if (r) out.cost = r;
    } catch { /* never let cost-card lookup fail the slash */ }
  }
  return JSON.stringify(out);
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

async function _provider(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  const lookup = (name) => {
    if (typeof registry.lookupProv === 'function') return registry.lookupProv(name);
    return registry.PROVIDERS ? registry.PROVIDERS[name] : null;
  };
  if (!args) {
    return `provider: ${ctx.getActiveProvName()}\n(interactive picker not available in Ink chat — pass an arg: /provider <name>)`;
  }
  const next = lookup(args);
  if (!next) {
    const known = registry.PROVIDERS ? Object.keys(registry.PROVIDERS).join(', ') : '?';
    return `unknown provider: ${args} (known: ${known})`;
  }
  if (ctx.setActiveProvName) ctx.setActiveProvName(args);
  if (ctx.setProv) ctx.setProv(next);
  return `provider → ${args}`;
}

async function _model(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  if (!args) {
    return `model: ${ctx.getActiveModel() || '(default)'}\n(interactive picker not available in Ink chat — pass an arg: /model <name>)`;
  }
  const { parseSlashProviderModel } = registry;
  const parsed = typeof parseSlashProviderModel === 'function'
    ? parseSlashProviderModel(args)
    : { provider: null, model: args };
  if (parsed.provider) {
    const lookup = (name) => (typeof registry.lookupProv === 'function'
      ? registry.lookupProv(name)
      : (registry.PROVIDERS ? registry.PROVIDERS[name] : null));
    const next = lookup(parsed.provider);
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
    const items = mem.loadRecent(20, ctx.cfgDir);
    return JSON.stringify(items, null, 2);
  }
  if (which === 'episodic') {
    const topic = tokens[1];
    if (topic) {
      const body = mem.loadEpisodic(topic, ctx.cfgDir);
      return body || `(no episodic file "${topic}")`;
    }
    return JSON.stringify(mem.listEpisodic(ctx.cfgDir), null, 2);
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
      'usage: /loop <prompt> [--max N] [--until "<regex>"]',
      `  default --max ${loopMod.LOOP_MAX_DEFAULT}, ceiling ${loopMod.LOOP_MAX_CEILING}`,
      `  session: ${ctx.getSessionId && ctx.getSessionId() || '(none — turns will not be persisted)'}`,
      '  note: Ink chat runs /loop without mid-loop Ctrl-C abort; set LAZYCLAW_NO_INK=1 for the full loop UX.',
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
  const ac = new AbortController();
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
      signal: ac.signal,
    });
    if (ctx.setCharsSent && ctx.getCharsSent) {
      ctx.setCharsSent(ctx.getCharsSent() + parsed.prompt.length * result.iterations);
    }
    const tail = result.stoppedBy === 'until' ? ' (stopped by --until)'
              : result.stoppedBy === 'abort' ? ' (aborted)' : '';
    return `✓ loop done — ${result.iterations}/${parsed.max} iteration(s)${tail}`;
  } catch (err) {
    return `loop error: ${err?.message || String(err)}`;
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
      // Cron attach is cli.mjs-internal (_attachGoalCron); Ink chat skips it
      // and the operator can attach via the `lazyclaw goal add --cron` CLI.
      const cronNote = cron ? ' (cron attach via Ink chat is not wired in v5.4 — use the CLI form)' : '';
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
      return `✓ goal ${g.name} closed (status: ${g.status})`;
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

async function _personality(_args) {
  // cmdPersonality lives in cli.mjs and is readline-coupled (reads from
  // stdin via the global rl). Lifting it cleanly is a v5.5 follow-up; for
  // v5.4 we surface the CLI alternative so operators aren't stranded.
  return 'personality: interactive picker not yet wired into Ink chat — use `lazyclaw personality list|set <name>` from the shell, or restart with LAZYCLAW_NO_INK=1.';
}

async function _task() {
  return 'task: slash form lands in v5.5 — use the `lazyclaw task` CLI for now.';
}

async function _trainer() {
  return 'trainer: configure via config.json (cfg.trainer) or `lazyclaw trainer` CLI — slash form lands in v5.5.';
}

// ─── dispatch table ──────────────────────────────────────────────────────

export const SLASH_HANDLERS = new Map([
  ['/help', _help],
  ['/status', _status],
  ['/version', _version],
  ['/usage', _usage],
  ['/new', _newReset],
  ['/reset', _newReset],
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
