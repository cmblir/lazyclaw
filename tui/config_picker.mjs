// tui/config_picker.mjs — the `/config` slash: change ONE setting without
// re-running the whole wizard.
//
// Split of duties (user-requested):
//   /setup  — first-run / full re-setup: leaves chat and runs EVERY wizard
//             step (the behavior /config used to have).
//   /config — settings editor: pick a single item. In-chat items (provider /
//             model / context / trainer / orchestrator) delegate to their
//             existing slash handlers and stay inside chat; credential items
//             (channel tokens, outbound webhook) need readline prompts, so
//             they unmount, run JUST that step, and re-enter chat.
//
// On the legacy readline path (no ctx.openPicker modal) /config falls back
// to the full wizard — same as before, no silent degradation.

const CONFIG_ITEMS = [
  { id: 'provider',     label: 'provider',            desc: 'switch the chat provider (family → vendor picker)' },
  { id: 'model',        label: 'model',               desc: 'switch the model (live list when the provider supports it)' },
  { id: 'context',      label: 'context window',      desc: 'history turns / token budget sent per turn' },
  { id: 'trainer',      label: 'trainer',             desc: 'learning-loop provider/model (auto = $0 on claude-cli)' },
  { id: 'orchestrator', label: 'orchestrator',        desc: 'multi-agent on/off, planner, workers' },
  { id: 'channel',      label: 'channel credentials', desc: 'Slack/Telegram/Matrix tokens — leaves chat for the prompts, then returns' },
  { id: 'webhook',      label: 'outbound webhook',    desc: 'message-send webhook URL — leaves chat, then returns' },
  { id: 'wizard',       label: 'everything (full wizard)', desc: 'rerun all setup steps — same as /setup' },
];

export async function runConfigSlash(_args, ctx, handlers) {
  if (typeof ctx.openPicker !== 'function') {
    // Legacy readline path has no modal picker — keep the old /config
    // behavior there (full wizard) rather than failing.
    ctx.requestSetup = true;
    return 'EXIT';
  }
  const picked = await ctx.openPicker({
    kind: 'config-item',
    title: 'config — change one setting',
    subtitle: 'Enter to edit · Esc to cancel · /setup reruns the whole wizard',
    items: CONFIG_ITEMS.map((i) => ({ id: i.id, label: i.label, desc: i.desc })),
  });
  const id = typeof picked === 'string' ? picked : (picked && picked.id);
  if (!id || id === 'CANCEL') return 'config: cancelled';
  if (id === 'wizard') { ctx.requestSetup = true; return 'EXIT'; }
  if (id === 'channel' || id === 'webhook') {
    // These steps need raw readline prompts (secrets), so the REPL unmounts,
    // chat.mjs runs the single step, and chat restarts automatically.
    ctx.requestConfigStep = id;
    return 'EXIT';
  }
  const handler = handlers && handlers.get && handlers.get(`/${id}`);
  if (!handler) return `config: no in-chat editor for "${id}"`;
  return handler('', ctx);
}

export { CONFIG_ITEMS };
