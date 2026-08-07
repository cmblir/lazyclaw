// tui/slash_channels.mjs — the /channels and /context slash-command handlers,
// extracted verbatim from slash_dispatcher.mjs. Imports the shared masked-prompt
// helper from slash_helpers.mjs and the dotenv shim from a leaf lib, never the
// dispatcher (no cycle).

import { loadDotenvIfAny } from '../dotenv_min.mjs';
import { _promptText } from './slash_helpers.mjs';

// /channels — view configured channels and toggle them. `/channels` lists;
// `/channels <name> on|off` enables/disables. Reads/writes cfg via ctx when
// available, else lib/config directly, so it works on both REPL paths.
export async function _channels(args, ctx = {}) {
  const cf = await import('../config_features.mjs');
  const cfgMod = await import('../lib/config.mjs');
  const read = typeof ctx.readConfig === 'function' ? ctx.readConfig : cfgMod.readConfig;
  const write = typeof ctx.writeConfig === 'function' ? ctx.writeConfig : cfgMod.writeConfig;
  const toks = (args || '').trim().split(/\s+/).filter(Boolean);
  const [name, action] = toks;

  // `/channels [<name>] setup` — set the channel's credentials (bot token,
  // homeserver, …) from chat instead of redirecting to /config. Reuses the
  // masked modal prompt (_promptText) so secrets are never echoed. No modal →
  // fall back to the readline channel step (same as /config's channel item).
  const wantSetup = toks.some((t) => /^setup$/i.test(t));
  if (wantSetup) {
    const channelMod = await import('../commands/setup_channels.mjs');
    const picked = toks.find((t) => !/^setup$/i.test(t));
    if (typeof ctx.openPicker !== 'function') {
      // Readline path: hand off to the existing channel wizard step.
      ctx.requestConfigStep = 'channel';
      return 'EXIT';
    }
    let chName = picked && picked.toLowerCase();
    if (!chName) {
      const sel = await ctx.openPicker({
        kind: 'menu',
        title: 'channel — set credentials',
        subtitle: 'pick a channel to configure',
        items: channelMod.CHANNEL_CATALOG.map((c) => ({
          id: c.name,
          label: c.label,
          desc: c.builtin ? '' : `needs: ${(c.deps && c.deps.length) ? c.deps.join(', ') : (c.binary || 'creds only')}`,
        })),
      });
      chName = sel && typeof sel === 'object' ? sel.id : sel;
      if (!chName || typeof chName !== 'string') return 'channel setup: cancelled';
    }
    const spec = channelMod.channelByName(chName);
    if (!spec) return `unknown channel: ${chName} (known: ${cf.KNOWN_CHANNELS.join(', ')})`;
    if (!spec.fields.length) {
      // No creds (e.g. http / whatsapp) — just enable it.
      const cfgDirX = ctx.cfgDir || (await import('node:path')).dirname(cfgMod.configPath());
      channelMod.persistChannel(cfgDirX, chName, {});
      if (ctx.cfg) { ctx.cfg.channels = ctx.cfg.channels || {}; ctx.cfg.channels[chName] = { ...(ctx.cfg.channels[chName] || {}), enabled: true }; }
      return `channel ${chName} → enabled (no credentials needed)`;
    }
    const answers = {};
    for (const f of spec.fields) {
      const v = await _promptText(ctx, {
        title: `${spec.label} — ${f.prompt}`,
        subtitle: f.optional ? 'optional · Esc to skip' : 'Esc cancels',
        secret: !!f.secret,
        allowEmpty: !!f.optional,
      });
      if (v === null) {
        if (f.optional) continue;       // Esc on an optional field → skip it
        return 'channel setup: cancelled';
      }
      if (v) answers[f.key] = v;
    }
    const path = await import('node:path');
    const cfgDirX = ctx.cfgDir || path.dirname(cfgMod.configPath());
    const entry = channelMod.persistChannel(cfgDirX, chName, answers);
    // Mirror the PERSISTED enabled state onto the in-session cfg so a follow-up
    // list is fresh — an in-tree channel whose runtime dep is missing stays
    // disabled (persistChannel gates it) rather than being force-enabled.
    if (ctx.cfg) { ctx.cfg.channels = ctx.cfg.channels || {}; ctx.cfg.channels[chName] = { ...(ctx.cfg.channels[chName] || {}), enabled: !!entry.ready }; }
    const setKeys = Object.keys(answers);
    let note = '';
    if (!entry.ready) {
      if (entry.missingDeps && entry.missingDeps.length) note += `\n(needs ${entry.missingDeps.join(', ')} — run: pompos channels install ${chName})`;
      if (entry.missingBinary) note += `\n(needs the ${entry.missingBinary} binary on your PATH)`;
    }
    return `✓ ${spec.label} credentials saved (${setKeys.join(', ') || 'none'}) → ${entry.ready ? 'channel enabled' : 'saved (enable once the requirement is installed)'}${note}`;
  }

  // `/channels <name> test` — verify the stored credentials with a live call.
  if (name && /^test$/i.test(action || '')) {
    const channelMod = await import('../commands/setup_channels.mjs');
    try { loadDotenvIfAny(ctx.cfgDir); } catch { /* best-effort */ }
    const r = await channelMod.verifyChannel(name.toLowerCase());
    if (r.ok === true) return `✓ ${name} verified — ${r.detail}`;
    if (r.ok === null) return `· ${name}: ${r.detail}`;
    return `✗ ${name}: ${r.detail}${r.hint ? `\n  fix: ${r.hint}` : ''}`;
  }

  if (name && /^(on|off|enable|disable)$/i.test(action || '')) {
    const en = /^(on|enable)$/i.test(action);
    const cfg = read();
    const key = name.toLowerCase();
    // Reject unknown names so a typo can't silently create a bogus
    // cfg.channels.<name> section (which would then leak into the list).
    // Stay permissive for pre-existing custom sections.
    const existing = (cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
    if (!cf.KNOWN_CHANNELS.includes(key) && !(key in existing)) {
      return `unknown channel: ${key} (known: ${cf.KNOWN_CHANNELS.join(', ')})`;
    }
    cf.channelSetEnabled(cfg, key, en); write(cfg);
    // Legacy fallback path: the readline ctx (_legacyCtx) has no
    // readConfig/writeConfig, so we read/wrote disk above against a fresh
    // cfg object. Mirror the toggle onto the in-session ctx.cfg so a
    // follow-up `/channels` (list) or other in-session read stays
    // consistent instead of showing the stale pre-toggle value.
    if (ctx.cfg && ctx.cfg !== cfg && typeof ctx.cfg === 'object') {
      cf.channelSetEnabled(ctx.cfg, key, en);
    }
    return en
      ? `channel ${key} → enabled`
      : `channel ${key} → disabled (re-enable with /channels ${key} on)`;
  }
  // No-arg + modal → an action menu: each row toggles in place, plus a
  // "set credentials" row. Falls through to the text list when no modal.
  if (!toks.length && typeof ctx.openPicker === 'function') {
    const statusRows = cf.channelStatusList(read());
    const items = statusRows.map((c) => ({
      id: `toggle:${c.name}`,
      label: `${c.name} — ${c.enabled ? 'enabled' : 'disabled'}`,
      desc: c.enabled ? 'Enter to disable' : 'Enter to enable',
    }));
    items.push({ id: 'setup', label: '+ Set credentials…', desc: 'pick a channel and enter bot token / homeserver / …' });
    const picked = await ctx.openPicker({ kind: 'menu', title: 'Channels', subtitle: `${statusRows.length} configured`, items });
    const pid = picked && typeof picked === 'object' ? picked.id : picked;
    if (!pid || typeof pid !== 'string') return 'cancelled';
    if (pid === 'setup') return _channels('setup', ctx);
    if (pid.startsWith('toggle:')) {
      const nm = pid.slice(7);
      const cur = statusRows.find((r) => r.name === nm);
      return _channels(`${nm} ${cur && cur.enabled ? 'off' : 'on'}`, ctx);
    }
  }
  const rows = cf.channelStatusList(read());
  if (!rows.length) return 'no channels configured. set credentials with /channels setup (or `pompos setup` for the full wizard).';
  // Cross-reference each channel's required env creds against the loaded env so
  // the list flags a channel that's "enabled" but missing its token.
  let channelMod = null;
  try {
    loadDotenvIfAny(ctx.cfgDir);
    channelMod = await import('../commands/setup_channels.mjs');
  } catch { /* hint is best-effort */ }
  const missingFor = (name) => {
    const spec = channelMod && channelMod.channelByName(name);
    if (!spec) return [];
    return spec.fields.filter((f) => !f.optional && !process.env[f.env]).map((f) => f.env);
  };
  const lines = ['configured channels:'];
  for (const c of rows) {
    const miss = missingFor(c.name);
    const credNote = miss.length ? ` · creds: missing ${miss.join(', ')}` : '';
    lines.push(`  ${c.name}  ${c.enabled ? 'enabled' : 'disabled'}${c.boundAgent ? ' · agent: ' + c.boundAgent : ''}${credNote}`);
  }
  lines.push('toggle: /channels <name> on|off   ·   set creds: /channels <name> setup');
  return lines.join('\n');
}

// /context — view/set the chat history window (turns + token budget). This is
// the sliding history budget sent each turn, NOT the model's hard context
// limit. ctx-or-lib/config fallback so it works on both REPL paths.
export async function _context(args, ctx = {}) {
  const cf = await import('../config_features.mjs');
  const cfgMod = await import('../lib/config.mjs');
  const read = typeof ctx.readConfig === 'function' ? ctx.readConfig : cfgMod.readConfig;
  const write = typeof ctx.writeConfig === 'function' ? ctx.writeConfig : cfgMod.writeConfig;
  const persist = (cfg) => { write(cfg); if (ctx.cfg) ctx.cfg = cfg; };
  const parts = (args || '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'status').toLowerCase();
  const fmt = () => { const w = cf.chatWindowGet(read()); return `context window: ${w.turns} turns · ${w.tokens} tokens  (history budget — not the model's hard limit)`; };
  // No-arg + modal → action menu → numeric picker (mirrors orchestrator maxsubtasks).
  if (!parts.length && typeof ctx.openPicker === 'function') {
    const w = cf.chatWindowGet(read());
    const action = await ctx.openPicker({
      kind: 'menu', title: 'Context window (history budget)', subtitle: `now ${w.turns} turns · ${w.tokens} tokens`,
      items: [
        { id: 'turns', label: 'Set turns…', desc: 'past turns to send' },
        { id: 'tokens', label: 'Set tokens…', desc: 'token budget (min 256)' },
        { id: 'status', label: 'Status', desc: 'show current' },
      ],
    });
    const aid = action && typeof action === 'object' ? action.id : action;
    if (!aid || typeof aid !== 'string' || aid === 'status') return fmt();
    if (aid === 'turns') {
      const np = await ctx.openPicker({ kind: 'menu', title: 'Turns to keep', subtitle: `currently ${w.turns}`, items: [5, 10, 15, 20, 30, 40, 50].map((x) => ({ id: String(x), label: String(x) })) });
      const v = parseInt(np && typeof np === 'object' ? np.id : np, 10);
      if (!Number.isFinite(v)) return 'context turns: cancelled';
      const cfg = read(); cf.chatWindowSet(cfg, { turns: v }); persist(cfg); return fmt();
    }
    if (aid === 'tokens') {
      const np = await ctx.openPicker({ kind: 'menu', title: 'Token budget', subtitle: `currently ${w.tokens}`, items: [2000, 4000, 8000, 12000, 16000, 32000].map((x) => ({ id: String(x), label: String(x) })) });
      const v = parseInt(np && typeof np === 'object' ? np.id : np, 10);
      if (!Number.isFinite(v) || v < 256) return 'context tokens: cancelled';
      const cfg = read(); cf.chatWindowSet(cfg, { tokens: v }); persist(cfg); return fmt();
    }
  }
  if (sub === 'status') return fmt();
  const n = parseInt(parts[1], 10);
  if (sub === 'turns') { if (!Number.isFinite(n) || n < 1) return 'usage: /context turns <N>'; const cfg = read(); cf.chatWindowSet(cfg, { turns: n }); persist(cfg); return fmt(); }
  if (sub === 'tokens') { if (!Number.isFinite(n) || n < 256) return 'usage: /context tokens <N>  (min 256)'; const cfg = read(); cf.chatWindowSet(cfg, { tokens: n }); persist(cfg); return fmt(); }
  return 'usage: /context [status | turns <N> | tokens <N>]';
}
