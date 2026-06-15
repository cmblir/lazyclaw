// tui/slash_args.mjs — slash-command ARGUMENT completion.
//
// argSpecFor() is PURE (it reads only the catalog's per-command `arg` data) so
// the REPL can cheaply decide whether the value being typed after a command is
// completable, and show a hint. The ARG_COMPLETERS run the actual pick — they
// may open the modal (ctx.openPicker) or drill the shared provider→model
// picker — and return the string to fill into the editor buffer, or null on
// cancel. Kept separate from slash_commands.mjs, which must stay a pure-data
// module to avoid the documented tui/ → cli.mjs circular import.

import { pickProviderModel } from './model_pick.mjs';

// Resolve which completer (if any) applies to `buffer`. Returns
// { cmd, name, completer, partial } or null.
//
// A command with `arg.after` only completes its value once one of those
// subcommands is present AND the user is past it (typing token index >= 1
// of the args, i.e. >= 2 tokens after the command).
export function argSpecFor(buffer, catalog) {
  if (!buffer || !buffer.startsWith('/')) return null;
  const sp = buffer.indexOf(' ');
  if (sp < 0) return null;                       // still typing the command itself
  const cmd = buffer.slice(0, sp);
  const entry = (catalog || []).find((c) => c.cmd === cmd);
  if (!entry || !entry.arg) return null;
  const tokens = buffer.slice(sp + 1).split(/\s+/);
  const partial = tokens[tokens.length - 1];
  if (Array.isArray(entry.arg.after)) {
    if (!entry.arg.after.includes(tokens[0]) || tokens.length < 2) return null;
  }
  return { cmd, name: entry.arg.name, completer: entry.arg.completer, partial };
}

export const ARG_COMPLETERS = {
  async model(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
    if (!r || r.model == null) return null;
    const active = typeof ctx.getActiveProvName === 'function' ? ctx.getActiveProvName() : '';
    // If the user switched providers in the picker, fill provider/model so the
    // /model arg path sets both; otherwise just the model id.
    return r.provider && r.provider !== active ? `${r.provider}/${r.model}` : r.model;
  },
  async provider(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
    return r && r.model != null ? r.provider : null;
  },
  async trainerSpec(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeAuto: true, includeDefault: true });
    if (!r || r.model == null) return null;
    return r.provider === 'auto' ? 'auto' : (r.model ? `${r.provider}:${r.model}` : r.provider);
  },
  async orchestratorSpec(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, {
      exclude: ['orchestrator', 'mock'], pickProvider: true, includeDefault: true, includeSwitch: false,
    });
    if (!r || r.model == null) return null;
    return r.model ? `${r.provider}:${r.model}` : r.provider;
  },
  async agentName(ctx, registry, agentsMod) {
    if (typeof ctx.openPicker !== 'function' || !agentsMod) return null;
    const names = agentsMod.listAgents(ctx.cfgDir).map((a) => a.name);
    if (!names.length) return null;
    const picked = await ctx.openPicker({ kind: 'menu', title: 'agent', items: names.map((n) => ({ id: n, label: n })) });
    return picked && typeof picked === 'object' ? picked.id : (picked || null);
  },
};

// Run the completer named by spec.completer. Returns the fill string or null.
export async function runArgCompleter(spec, ctx, registry, agentsMod) {
  const fn = spec && ARG_COMPLETERS[spec.completer];
  if (!fn) return null;
  return fn(ctx, registry, agentsMod);
}
