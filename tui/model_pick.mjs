// tui/model_pick.mjs — the single canonical provider→model picker for the Ink
// REPL. Hoisted out of slash_dispatcher.mjs so /model, /provider, /trainer,
// /orchestrator and /agent all pick a model the same way: a family→provider
// drill-in, a model loop with live-fetch + a free-text custom-id row, and a
// "⇄ switch provider" row. Reuses ctx.openPicker (the host modal).
//
// Exports:
//   pickProviderModel(ctx, registry, opts) → { provider, model } | null
//   plus the lower-level helpers the dispatcher still references by name.

import { providerFamilies, providerTag } from './provider_families.mjs';
import { supportsLiveFetch, fetchModelsForProvider } from '../providers/model_catalogue.mjs';

export function providerLookup(registry, name) {
  if (typeof registry.lookupProv === 'function') return registry.lookupProv(name);
  return registry.PROVIDERS ? registry.PROVIDERS[name] : null;
}

export function infoFor(registry, provName) {
  return (registry.PROVIDER_INFO && registry.PROVIDER_INFO[provName]) || {};
}

// A composite provider (orchestrator) has no real model list — its only
// "model" is the provider name itself, so the model picker would dead-end
// on a single bogus row. Detect it so we can redirect to a provider pick.
export function isCompositeProvider(info, provName) {
  if (info && info.composite) return true;
  const s = info && Array.isArray(info.suggestedModels) ? info.suggestedModels : null;
  return !!(s && s.length === 1 && s[0] === provName);
}

// Whether the active provider exposes any selectable model (suggested ≠ provider name, or live-fetchable).
export function hasRealModels(info, provName) {
  if (supportsLiveFetch(info, provName)) return true;
  const s = info && Array.isArray(info.suggestedModels) ? info.suggestedModels : [];
  return s.some((m) => m && m !== provName);
}

// Pick a provider via the family drill-in (API key / CLI-Local / Mock),
// mirroring the legacy readline wizard. Single-option steps auto-advance.
// orchestrator is never listed. Returns a provider id or null on cancel.
export async function pickProviderDrillIn(ctx, registry) {
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

// Build the model-picker rows: suggested + live-fetched models (deduped, default
// tagged) plus pinned sentinel rows for live-fetch and free-text custom entry.
//
// opts (all optional, defaults preserve the original /model behavior):
//   includeDefault — prepend a "▷ provider's own default model" row (→ '')
//   includeSwitch  — show the "⇄ pick a different provider" row (default true)
export function buildModelItems(info, provName, dynamicModels, opts = {}) {
  const base = Array.isArray(info.suggestedModels) ? info.suggestedModels : [];
  const all = Array.from(new Set([...(dynamicModels || []), ...base])).filter((m) => m && m !== provName);
  const items = [];
  if (opts.includeDefault) {
    items.push({
      id: '__default__',
      label: "▷ provider's own default model",
      desc: 'no -m override',
      pinned: true,
    });
  }
  if (supportsLiveFetch(info, provName)) {
    items.push({
      id: '__fetch_models__',
      label: '↻ fetch live model list',
      desc: 'pull the current catalogue (may take a few seconds)',
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
  // Reach another provider's models (e.g. claude-cli's opus) without leaving
  // /model — the active provider isn't the only place to pick a model.
  if (opts.includeSwitch !== false) {
    items.push({
      id: '__switch_provider__',
      label: '⇄ pick a different provider…',
      desc: 'switch provider (e.g. claude-cli for opus/sonnet), then its model',
      pinned: true,
    });
  }
  return items;
}

// Run the model picker for `provName`, looping on the live-fetch row and
// resolving the free-text row from the typed filter. Returns a concrete model
// id, '' for the provider-default row, '__switch_provider__', or null on cancel.
export async function pickModelLoop(ctx, registry, provName, opts = {}) {
  const info = infoFor(registry, provName);
  let dynamic = [];
  let note = '';
  for (let guard = 0; guard < 50; guard++) {
    const items = buildModelItems(info, provName, dynamic, opts);
    const cur = typeof ctx.getActiveModel === 'function' ? ctx.getActiveModel() : '';
    const picked = await ctx.openPicker({
      kind: 'model',
      title: `select model for ${provName}`,
      subtitle: note || `current: ${cur || '(default)'}`,
      items,
    });
    if (picked == null) return null;
    if (typeof picked === 'object') {
      // free-text custom row → { id, query }
      const typed = String(picked.query || '').trim();
      if (!typed) { note = 'type a model id into the filter first'; continue; }
      return typed;
    }
    if (picked === '__default__') return '';
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
    // Switch to a different provider's models (e.g. claude-cli's opus).
    if (picked === '__switch_provider__') return '__switch_provider__';
    return picked;
  }
  return null;
}

// Flat provider picker used to escape a composite/model-less active provider
// or to switch providers from inside /model. Hides composites + mock,
// mirroring the legacy wizard's filter (cli.mjs:1979).
//
// opts (optional): { exclude: string[], includeAuto: boolean }. `exclude`
// hides extra providers (orchestrator self-reference); `includeAuto` adds an
// "auto" row (trainer) that resolves to the '__auto__' sentinel.
export async function pickProviderForModel(ctx, registry, subtitle, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const info = registry.PROVIDER_INFO || {};
  const known = Object.keys(registry.PROVIDERS || {})
    .filter((id) => id !== 'mock' && !((info[id] || {}).composite) && !exclude.has(id))
    .sort();
  const items = known.map((id) => ({
    id,
    label: id,
    desc: info[id] && info[id].docs ? String(info[id].docs).split('\n')[0].slice(0, 60) : '',
  }));
  if (opts.includeAuto) {
    items.unshift({
      id: '__auto__',
      label: 'auto — let the trainer pick',
      desc: 'claude-cli on a Pro/Max session, otherwise mirrors the chat model',
      pinned: true,
    });
  }
  const active = typeof ctx.getActiveProvName === 'function' ? ctx.getActiveProvName() : '';
  const picked = await ctx.openPicker({
    kind: 'provider',
    title: 'select provider (then a model)',
    subtitle: subtitle || `${active} has no selectable models — pick a provider`,
    items,
  });
  return typeof picked === 'string' ? picked : null;
}

// The canonical entry point. Drill provider → model, honoring `opts`, and
// return { provider, model } (model '' = provider default) or null on cancel.
//
// opts (all optional):
//   includeSwitch  — show "⇄ pick a different provider" in the model list (default true)
//   includeAuto    — always open the provider step first with an "auto" row (trainer)
//   pickProvider   — always open the provider step (orchestrator planner/worker)
//   includeDefault — add the "▷ provider's own default model" row (orchestrator/agent)
//   exclude        — provider ids to hide (orchestrator: ['orchestrator','mock'])
//   startProvider  — begin at this provider (skip the active-provider seed)
//   title          — provider-step title override
export async function pickProviderModel(ctx, registry, opts = {}) {
  const includeSwitch = opts.includeSwitch !== false;
  const exclude = opts.exclude || [];
  const loopOpts = { includeSwitch, includeDefault: !!opts.includeDefault };

  let provName = opts.startProvider || (typeof ctx.getActiveProvName === 'function' ? ctx.getActiveProvName() : '');
  let info = infoFor(registry, provName);
  let switched = !!opts.startProvider;

  // Open the provider step when the active provider can't offer a model, or
  // when the caller always wants a provider choice (orchestrator's pickProvider,
  // trainer's includeAuto). startProvider skips the step (provider already chosen).
  const mustPickProvider = !opts.startProvider && (
    !!opts.pickProvider
    || !!opts.includeAuto
    || isCompositeProvider(info, provName)
    || !hasRealModels(info, provName)
  );
  if (mustPickProvider) {
    const picked = await pickProviderForModel(ctx, registry, opts.title, { exclude, includeAuto: opts.includeAuto });
    if (picked == null) return null;
    if (picked === '__auto__') return { provider: 'auto', model: '' };
    if (picked !== provName) { provName = picked; switched = true; info = infoFor(registry, provName); }
  }

  for (let guard = 0; guard < 25; guard++) {
    const model = await pickModelLoop(ctx, registry, provName, loopOpts);
    if (model === '__switch_provider__') {
      const np = await pickProviderForModel(ctx, registry, `current: ${provName} — pick a provider`, { exclude });
      if (np == null) continue;            // cancelled the switch → back to the model list
      if (np === '__auto__') return { provider: 'auto', model: '' };
      if (np !== provName) { provName = np; switched = true; info = infoFor(registry, provName); }
      continue;
    }
    // Cancelled the model step. Report the (possibly switched) provider with a
    // null model so /model can keep a provider switch while leaving the model
    // unchanged; spec/record callers treat a null model as a full cancel.
    if (model == null) return { provider: provName, model: null };
    return { provider: provName, model };
  }
  return null;
}
