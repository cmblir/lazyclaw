// tui/hud.mjs — claude-hud-style status row. The compact status bar shows
// provider · model · ctx; with the HUD enabled (cfg.chat.hud, default on) a
// second line adds real-time usage, session cost, the trainer model, and the
// orchestrator shape. Toggle from /config → "HUD status bar" or the /hud slash.
//
// Kept out of repl.mjs/chat.mjs (both at the file-size ratchet) so the gauge
// can grow without those files growing.

import { costFromUsage } from '../providers/rates.mjs';
import { resolveTrainer } from '../providers/registry.mjs';

// HUD on unless explicitly disabled — new users see the richer bar by default.
export function hudEnabled(cfg) {
  return !cfg || !cfg.chat || cfg.chat.hud !== false;
}

// Build the HUD field bundle from live chat state, or null when disabled.
// `usage` is the running session usage (_inkRunningUsage / runningUsage).
export function hudStatus(cfg, usage) {
  if (!hudEnabled(cfg)) return null;
  const u = usage || {};
  const inTok = Number(u.inputTokens) || 0;
  const outTok = Number(u.outputTokens) || 0;
  // Session cost: a provider-reported total (claude-cli) or rate-card math.
  let costUsd = 0;
  try {
    const c = costFromUsage({ provider: cfg && cfg.provider, model: cfg && cfg.model, usage: u }, cfg && cfg.rates);
    costUsd = (c && Number(c.cost)) || 0;
  } catch (_) { /* no rate card → no cost segment */ }
  // Trainer (learning-loop) model — "auto"/omitted mirrors the chat provider.
  let trainer = '';
  try {
    const t = resolveTrainer(cfg || {});
    if (t && t.provider) trainer = t.model ? `${t.provider}:${t.model}` : t.provider;
  } catch (_) { /* ignore */ }
  // Orchestrator shape, only when it's the active provider.
  let orch = '';
  if (cfg && cfg.provider === 'orchestrator' && cfg.orchestrator) {
    const o = cfg.orchestrator;
    const w = Array.isArray(o.workers) ? o.workers.length : 0;
    orch = `${o.planner || '?'} +${w}w`;
  }
  return { inTok, outTok, costUsd, trainer, orch };
}

const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n | 0));

// Render the HUD line (the extra row below the compact status line). Returns
// '' when there's nothing worth showing.
export function formatHudRow(f) {
  if (!f) return '';
  const seg = [`↑${fmtTok(f.inTok)} ↓${fmtTok(f.outTok)} tok`];
  if (f.costUsd > 0) seg.push(`$${f.costUsd.toFixed(4)}`);
  if (f.trainer) seg.push(`trainer ${f.trainer}`);
  if (f.orch) seg.push(`orch ${f.orch}`);
  return seg.join('   ');
}

// `/hud [on|off]` — toggle the HUD row. /config delegates here. No arg opens an
// on/off picker in the Ink UI, or flips the current value on the legacy path.
export async function hudSlash(args, ctx) {
  const cfg = ctx.readConfig ? ctx.readConfig() : (ctx.cfg || {});
  const cur = hudEnabled(cfg);
  const a = String(args || '').trim().toLowerCase();
  let next;
  if (a === 'on') next = true;
  else if (a === 'off') next = false;
  else if (!a && typeof ctx.openPicker === 'function') {
    const picked = await ctx.openPicker({
      kind: 'menu',
      title: 'HUD status bar',
      subtitle: `currently ${cur ? 'on' : 'off'}`,
      items: [
        { id: 'on', label: 'on', desc: 'usage / cost / trainer / orchestrator row' },
        { id: 'off', label: 'off', desc: 'compact bar (provider · model · ctx)' },
      ],
    });
    const id = picked && typeof picked === 'object' ? picked.id : picked;
    if (id !== 'on' && id !== 'off') return 'hud: cancelled';
    next = id === 'on';
  } else next = !cur;
  cfg.chat = (cfg.chat && typeof cfg.chat === 'object') ? cfg.chat : {};
  cfg.chat.hud = next;
  if (ctx.writeConfig) ctx.writeConfig(cfg);
  if (ctx.cfg) ctx.cfg.chat = cfg.chat; // mirror so getStatus sees it live
  return `HUD ${next ? 'on' : 'off'}`;
}
