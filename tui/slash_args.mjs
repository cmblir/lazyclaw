// tui/slash_args.mjs — slash-command ARGUMENT completion.
//
// Two surfaces, chosen per argument:
//   • inline  — candidates render directly in the popup (like the /command
//     popup): ↑/↓ select, Tab/Enter fill the token. For single-value args and
//     subcommand menus (/login, /hud, /memory, /config, /channels, /task, …).
//   • modal   — a "↹ pick" hint shows; Tab opens the drill-in modal picker.
//     For 2-step provider→model specs (/model, /trainer set, /orchestrator).
//
// argSpecFor() is the pure resolver the REPL calls on every keystroke. It is
// position-aware: tokens[0] is the subcommand, later tokens are values gated on
// it. listArgCandidates() builds the inline list; runArgCompleter() drives the
// modal. Kept out of slash_commands.mjs (which must stay a pure-data module to
// avoid the tui/ → cli.mjs circular import); this module may import freely.

import fs from 'node:fs';
import path from 'node:path';
import { pickProviderModel } from './model_pick.mjs';
import { CLI_LOGIN_PROVIDERS } from '../providers/cli_login.mjs';
import { KNOWN_CHANNELS } from '../config_features.mjs';
import { listAgents } from '../agents.mjs';
import { listSkills } from '../skills.mjs';
import { listGoals } from '../goals.mjs';

const ONOFF = ['on', 'off'];

const sp = (kind, completer, name) => ({ kind, completer, name });

// Per-command rules: (tokens) => spec | null. `tokens` is the arg portion split
// on whitespace; the last entry is what the user is typing. A command absent
// here has no argument completion.
const ARG_RULES = {
  '/login':        (t) => (t.length === 1 ? sp('inline', 'loginProvider', 'provider') : null),
  '/hud':          (t) => (t.length === 1 ? sp('inline', 'onoff', 'on|off') : null),
  '/memory':       (t) => (t.length === 1 ? sp('inline', 'memoryScope', 'scope') : null),
  '/context':      (t) => (t.length === 1 ? sp('inline', 'contextSub', 'sub') : null),
  '/task':         (t) => (t.length === 1 ? sp('inline', 'taskSub', 'sub') : null),
  '/team':         (t) => (t.length === 1 ? sp('inline', 'teamSub', 'sub') : null),
  '/handoff':      (t) => (t.length === 1 ? sp('inline', 'channelName', 'channel') : null),
  '/dashboard':    (t) => (t.length === 1 ? sp('inline', 'dashboardSub', 'sub') : null),
  '/goal':         (t) => (t.length === 1 ? sp('inline', 'goalFirst', 'goal/sub')
                          : (t[0] === 'show' || t[0] === 'close') && t.length === 2 ? sp('inline', 'goalName', 'goal')
                          : t[0] === 'close' && t.length === 3 ? sp('inline', 'goalOutcome', 'outcome') : null),
  '/skill':        (t) => (t.length === 1 ? sp('inline', 'skillName', 'skill') : null),
  '/skills':       (t) => (t.length === 1 ? sp('inline', 'skillName', 'skill') : null),
  '/provider':     (t) => (t.length === 1 ? sp('inline', 'provider', 'provider') : null),
  '/channels':     (t) => (t.length === 1 ? sp('inline', 'channelFirst', 'channel/setup')
                          : t.length === 2 ? sp('inline', 'channelAction', 'on|off|setup') : null),
  '/personality':  (t) => (t.length === 1 ? sp('inline', 'personalitySub', 'sub')
                          : (t[0] === 'use' || t[0] === 'show' || t[0] === 'remove') && t.length === 2
                            ? sp('inline', 'personalityName', 'name') : null),
  '/agent':        (t) => (t.length === 1 ? sp('inline', 'agentSub', 'sub')
                          : (t[0] === 'edit' || t[0] === 'show' || t[0] === 'remove') && t.length === 2
                            ? sp('inline', 'agentName', 'name') : null),
  '/trainer':      (t) => (t.length === 1 ? sp('inline', 'trainerSub', 'sub')
                          : (t[0] === 'set' || t[0] === 'fallback') && t.length === 2
                            ? sp('modal', 'trainerSpec', 'spec') : null),
  '/orchestrator': (t) => (t.length === 1 ? sp('inline', 'orchestratorSub', 'sub')
                          : t[0] === 'planner' && t.length === 2 ? sp('modal', 'orchestratorSpec', 'spec')
                          : t[0] === 'worker' && t.length === 2 ? sp('inline', 'workerAction', 'add|remove')
                          : t[0] === 'worker' && (t[1] === 'add' || t[1] === 'remove' || t[1] === 'rm') && t.length === 3
                            ? sp('modal', 'orchestratorSpec', 'spec') : null),
  // 2-step provider→model drill: modal.
  '/model':        (t) => (t.length === 1 ? sp('modal', 'model', 'model') : null),
};

// Resolve which argument (if any) is completable for `buffer`. Returns
// { cmd, kind, completer, name, partial } or null. `catalog` is accepted for
// back-compat but unused — rules live in ARG_RULES.
export function argSpecFor(buffer, _catalog) {
  if (!buffer || !buffer.startsWith('/')) return null;
  const at = buffer.indexOf(' ');
  if (at < 0) return null; // still typing the command itself
  const cmd = buffer.slice(0, at);
  const rule = ARG_RULES[cmd];
  if (!rule) return null;
  const tokens = buffer.slice(at + 1).split(/\s+/);
  const spec = rule(tokens);
  if (!spec) return null;
  return { cmd, ...spec, partial: tokens[tokens.length - 1] };
}

function safe(fn) { try { return fn() || []; } catch { return []; } }
function listMdNames(dir) {
  return safe(() => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort());
}

// Inline candidate sources → {value, desc}[] (unfiltered; caller filters).
const INLINE_SOURCES = {
  loginProvider:  () => Object.keys(CLI_LOGIN_PROVIDERS).map((v) => ({ value: v, desc: 'connect via CLI login' })),
  onoff:          () => ONOFF.map((v) => ({ value: v, desc: '' })),
  memoryScope:    () => ['core', 'recent', 'episodic'].map((v) => ({ value: v, desc: '' })),
  contextSub:     () => ['status', 'turns', 'tokens'].map((v) => ({ value: v, desc: '' })),
  taskSub:        () => ['start', 'tick', 'list', 'show', 'transcript', 'abandon', 'done', 'remove'].map((v) => ({ value: v, desc: '' })),
  teamSub:        () => ['list', 'show', 'add', 'remove'].map((v) => ({ value: v, desc: '' })),
  dashboardSub:   () => ['stop', 'kill'].map((v) => ({ value: v, desc: '' })),
  goalOutcome:    () => ['done', 'abandoned'].map((v) => ({ value: v, desc: '' })),
  goalName:       (ctx) => safe(() => listGoals(ctx.cfgDir).map((g) => ({ value: g.name, desc: g.status || '' })).filter((i) => i.value)),
  goalFirst:      (ctx) => ['add', 'list', 'show', 'close'].map((v) => ({ value: v, desc: '' }))
                      .concat(safe(() => listGoals(ctx.cfgDir).map((g) => ({ value: g.name, desc: g.status || 'goal' })).filter((i) => i.value))),
  personalitySub: () => ['list', 'show', 'install', 'remove', 'use'].map((v) => ({ value: v, desc: '' })),
  agentSub:       () => ['list', 'show', 'add', 'edit', 'remove'].map((v) => ({ value: v, desc: '' })),
  trainerSub:     () => ['show', 'set', 'fallback', 'clear'].map((v) => ({ value: v, desc: '' })),
  orchestratorSub:() => ['status', 'on', 'off', 'planner', 'worker', 'maxsubtasks'].map((v) => ({ value: v, desc: '' })),
  workerAction:   () => ['add', 'remove'].map((v) => ({ value: v, desc: '' })),
  channelName:    () => KNOWN_CHANNELS.map((v) => ({ value: v, desc: '' })),
  channelFirst:   () => [{ value: 'setup', desc: 'set channel credentials' }].concat(KNOWN_CHANNELS.map((v) => ({ value: v, desc: '' }))),
  channelAction:  () => [...ONOFF, 'setup', 'test'].map((v) => ({ value: v, desc: v === 'setup' ? 'set credentials' : v === 'test' ? 'verify credentials' : '' })),
  provider:       (_ctx, registry) => Object.keys((registry && registry.PROVIDERS) || {})
                      .filter((n) => n !== 'mock').sort().map((v) => ({ value: v, desc: '' })),
  agentName:      (ctx) => safe(() => listAgents(ctx.cfgDir).map((a) => ({ value: a.name, desc: a.model ? `${a.provider}/${a.model}` : a.provider }))),
  skillName:      (ctx) => safe(() => listSkills(ctx.cfgDir).map((s) => ({ value: s.name, desc: s.summary || '' }))),
  personalityName:(ctx) => listMdNames(path.join(ctx.cfgDir || '', 'personalities')).map((v) => ({ value: v, desc: '' })),
};

// Build the inline candidate list for an inline spec, filtered + prefix-sorted
// by the partial token. Returns {value, desc}[] (empty for non-inline specs).
export function listArgCandidates(spec, ctx, registry) {
  if (!spec || spec.kind !== 'inline') return [];
  const src = INLINE_SOURCES[spec.completer];
  if (!src) return [];
  const all = src(ctx || {}, registry) || [];
  const q = String(spec.partial || '').toLowerCase();
  const matched = q ? all.filter((i) => String(i.value).toLowerCase().includes(q)) : all.slice();
  matched.sort((a, b) => {
    const ap = String(a.value).toLowerCase().startsWith(q) ? 0 : 1;
    const bp = String(b.value).toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp;
  });
  return matched;
}

// Modal completers — run the drill-in picker and return the string to fill.
// Only reached for spec.kind === 'modal'.
export const ARG_COMPLETERS = {
  async model(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
    if (!r || r.model == null) return null;
    const active = typeof ctx.getActiveProvName === 'function' ? ctx.getActiveProvName() : '';
    return r.provider && r.provider !== active ? `${r.provider}/${r.model}` : r.model;
  },
  async trainerSpec(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeAuto: true, includeDefault: true });
    if (!r || r.model == null) return null;
    return r.provider === 'auto' ? 'auto' : (r.model ? `${r.provider}:${r.model}` : r.provider);
  },
  async orchestratorSpec(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { exclude: ['orchestrator', 'mock'], pickProvider: true, includeDefault: true, includeSwitch: false });
    if (!r || r.model == null) return null;
    return r.model ? `${r.provider}:${r.model}` : r.provider;
  },
};

// Run the modal completer named by spec.completer. Returns the fill string or null.
export async function runArgCompleter(spec, ctx, registry) {
  const fn = spec && ARG_COMPLETERS[spec.completer];
  if (!fn) return null;
  return fn(ctx, registry);
}
