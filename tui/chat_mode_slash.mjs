// tui/chat_mode_slash.mjs — /agentic and /plan slash handlers (Group 1).
//
// Extracted from slash_dispatcher.mjs (at its file-size ratchet ceiling) so
// the agentic REPL / plan mode toggles can grow without forcing that file
// over its pinned limit. slash_dispatcher imports + registers these in
// SLASH_HANDLERS and the shared SLASH_COMMANDS catalog.
//
// Both mirror the /hud toggle (tui/hud.mjs::hudSlash): read cfg, flip the
// chat.* key, persist via writeConfig when wired, and mirror onto the
// in-memory cfg so the next turn (makeRunTurn → chatAgenticGet /
// chatPlanModeGet) sees it live. No-arg flips the current value, or opens
// an on/off picker in the Ink UI.

import { chatAgenticGet, chatPlanModeGet, chatSet } from '../config_features.mjs';

async function _chatToggleSlash(args, ctx, { key, label, pickerDesc }) {
  const getter = key === 'agentic' ? chatAgenticGet : chatPlanModeGet;
  const cfg = ctx.readConfig ? ctx.readConfig() : (ctx.cfg || {});
  const cur = getter(cfg);
  const a = String(args || '').trim().toLowerCase();
  let next;
  if (a === 'on') next = true;
  else if (a === 'off') next = false;
  else if (!a && typeof ctx.openPicker === 'function') {
    const picked = await ctx.openPicker({
      kind: 'menu',
      title: `${label} mode`,
      subtitle: `currently ${cur ? 'on' : 'off'}`,
      items: [
        { id: 'on', label: 'on', desc: pickerDesc },
        { id: 'off', label: 'off', desc: 'off' },
      ],
    });
    const id = picked && typeof picked === 'object' ? picked.id : picked;
    if (id !== 'on' && id !== 'off') return `${label}: cancelled`;
    next = id === 'on';
  } else next = !cur;
  chatSet(cfg, key, next);
  if (ctx.writeConfig) ctx.writeConfig(cfg);
  if (ctx.cfg && ctx.cfg !== cfg) chatSet(ctx.cfg, key, next);
  return `${label} ${next ? 'on' : 'off'}`;
}

export const agenticSlash = (a, ctx) => _chatToggleSlash(a, ctx, {
  key: 'agentic', label: 'agentic',
  pickerDesc: 'run tools behind the approval gate (read/grep/skill by default)',
});

export const planSlash = (a, ctx) => _chatToggleSlash(a, ctx, {
  key: 'planMode', label: 'plan',
  pickerDesc: 'read-only: propose a plan, do not mutate',
});

// Catalog entries for the shared SLASH_COMMANDS list (consumed by /help, the
// popup, ghost-autocomplete, and the d6 drift-guard).
export const CHAT_MODE_SLASH_COMMANDS = [
  { cmd: '/agentic', help: 'toggle the agentic REPL (tools behind approval): /agentic on|off' },
  { cmd: '/plan', help: 'toggle plan mode (read-only: propose, do not mutate): /plan on|off' },
];
