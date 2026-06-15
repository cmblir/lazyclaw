// tui/orchestrator_flow.mjs — interactive (fetch + pick) editing for the
// orchestrator's planner / workers and for picking a provider's model, so the
// user never has to type "provider:model" specs by hand. Driven by the Ink
// modal picker (ctx.openPicker); kept out of slash_dispatcher.mjs (at the
// file-size ratchet).

import { orchestratorGet, orchestratorSet, orchestratorEnable } from '../config_features.mjs';
import { readConfig as _readConfig, writeConfig as _writeConfig } from '../lib/config.mjs';
import { pickProviderModel } from './model_pick.mjs';

// Pick a provider (excluding orchestrator/mock) then its model → a spec string
// "provider" or "provider:model". Returns null on cancel. Wraps the canonical
// picker (pickProvider forces the provider step; the chat provider is never
// assumed for a planner/worker). includeSwitch is off — an orchestrator role
// is one explicit provider:model, not a hop between providers.
async function pickProviderModelSpec(ctx, registry, title) {
  const r = await pickProviderModel(ctx, registry, {
    title, exclude: ['orchestrator', 'mock'], pickProvider: true, includeDefault: true, includeSwitch: false,
  });
  if (!r || r.model == null) return null;
  return r.model ? `${r.provider}:${r.model}` : r.provider;
}

// Apply an interactive orchestrator edit. `action` ∈ planner | worker-add |
// worker-remove | maxsubtasks. Returns a status string (or null if unknown).
export async function orchestratorAction(ctx, registry, action) {
  const read = typeof ctx.readConfig === 'function' ? ctx.readConfig : null;
  const write = typeof ctx.writeConfig === 'function' ? ctx.writeConfig : null;
  if (!read || !write) return 'orchestrator: config not writable in this session';
  const cfg = read();
  const persist = () => { write(cfg); if (ctx.cfg) ctx.cfg.orchestrator = cfg.orchestrator; };

  if (action === 'planner') {
    const spec = await pickProviderModelSpec(ctx, registry, 'Orchestrator — pick the planner');
    if (!spec) return 'planner: cancelled';
    orchestratorSet(cfg, { planner: spec }); persist();
    return `planner → ${spec}`;
  }
  if (action === 'worker-add') {
    const spec = await pickProviderModelSpec(ctx, registry, 'Orchestrator — add a worker');
    if (!spec) return 'worker: cancelled';
    const workers = [...orchestratorGet(cfg).workers];
    if (!workers.includes(spec)) workers.push(spec);
    orchestratorSet(cfg, { workers }); persist();
    return `workers: ${workers.join(', ')}`;
  }
  if (action === 'worker-remove') {
    const workers = orchestratorGet(cfg).workers;
    if (!workers.length) return 'workers: (none to remove)';
    const picked = await ctx.openPicker({ kind: 'menu', title: 'Remove a worker', items: workers.map((w) => ({ id: w, label: w })) });
    const w = picked && typeof picked === 'object' ? picked.id : picked;
    if (!w) return 'worker: cancelled';
    const next = workers.filter((x) => x !== w);
    orchestratorSet(cfg, { workers: next }); persist();
    return `workers: ${next.join(', ') || '(none)'}`;
  }
  if (action === 'maxsubtasks') {
    const cur = orchestratorGet(cfg).maxSubtasks;
    const picked = await ctx.openPicker({
      kind: 'menu', title: 'Max subtasks per request', subtitle: `currently ${cur}`,
      items: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) })),
    });
    const n = parseInt(picked && typeof picked === 'object' ? picked.id : picked, 10);
    if (!Number.isFinite(n)) return 'maxSubtasks: cancelled';
    orchestratorSet(cfg, { maxSubtasks: Math.max(1, Math.min(10, n)) }); persist();
    return `maxSubtasks → ${n}`;
  }
  return null;
}

// Pick a model for the active provider and persist it as cfg.model. Returns a
// status fragment, or null on cancel. Used to chain provider→model in /provider.
export async function pickAndSetModel(ctx, registry, prov) {
  const r = await pickProviderModel(ctx, registry, { startProvider: prov, includeDefault: true, includeSwitch: false });
  if (!r || r.model == null) return null;
  const m = r.model;
  if (ctx.setActiveModel) ctx.setActiveModel(m || null);
  try {
    const c = (ctx.readConfig || _readConfig)();
    if (m) c.model = m; else delete c.model;
    (ctx.writeConfig || _writeConfig)(c);
    if (ctx.cfg) { if (m) ctx.cfg.model = m; else delete ctx.cfg.model; }
  } catch (_) { /* best-effort */ }
  return m ? `model → ${m}` : 'model → (default)';
}

// `/orchestrator [status|on|off|planner|worker add|remove|maxsubtasks ...]`.
// With no subcommand and a modal available, opens an arrow-key menu where every
// edit (planner, workers, maxSubtasks) is fetch+pick — no typed specs.
export async function orchestratorSlash(args, ctx = {}) {
  const read = typeof ctx.readConfig === 'function' ? ctx.readConfig : _readConfig;
  const write = typeof ctx.writeConfig === 'function' ? ctx.writeConfig : _writeConfig;
  const persist = (cfg) => { write(cfg); if (ctx.cfg) ctx.cfg.orchestrator = cfg.orchestrator; };
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  const fmt = () => {
    const s = orchestratorGet(read());
    return `orchestrator: ${s.active ? 'ON' : 'off'}  ·  planner: ${s.planner || '(default)'}  ·  workers: ${s.workers.length ? s.workers.join(', ') : '(none)'}  ·  maxSubtasks: ${s.maxSubtasks}`;
  };

  if (parts.length === 0 && typeof ctx.openPicker === 'function') {
    const s = orchestratorGet(read());
    const picked = await ctx.openPicker({
      kind: 'menu',
      title: 'Orchestration',
      subtitle: `now ${s.active ? 'ON' : 'off'} · planner ${s.planner || '(default)'} · ${s.workers.length} worker(s) · max ${s.maxSubtasks}`,
      items: [
        { id: 'planner', label: 'Set planner…', desc: 'pick provider + model' },
        { id: 'worker-add', label: 'Add worker…', desc: 'pick provider + model' },
        { id: 'worker-remove', label: 'Remove worker…', desc: 'pick from current workers' },
        { id: 'maxsubtasks', label: 'Max subtasks…', desc: 'cap subtasks per request (1–10)' },
        { id: 'on', label: 'Turn ON', desc: 'route chats through planner + workers' },
        { id: 'off', label: 'Turn OFF', desc: 'back to a single provider' },
        { id: 'status', label: 'Status', desc: 'show current config' },
      ],
    });
    const id = picked && typeof picked === 'object' ? picked.id : picked;
    if (!id || typeof id !== 'string') return fmt();
    if (id === 'planner' || id === 'worker-add' || id === 'worker-remove' || id === 'maxsubtasks') {
      const registry = await import('../providers/registry.mjs');
      const r = await orchestratorAction(ctx, registry, id);
      return `${r}\n${fmt()}`;
    }
    return orchestratorSlash(id, ctx);
  }

  const sub = (parts[0] || 'status').toLowerCase();
  if (sub === 'status') return fmt();
  const cfg = read();
  if (sub === 'on' || sub === 'enable') {
    if (!orchestratorGet(cfg).planner) {
      const base = cfg.provider && cfg.provider !== 'orchestrator' ? cfg.provider : 'claude-cli';
      orchestratorSet(cfg, { planner: base });
    }
    orchestratorEnable(cfg, true); persist(cfg);
    const after = orchestratorGet(read());
    return after.workers.length ? 'orchestration ON.\n' + fmt() : 'orchestration ON — but no workers yet. Add one: /orchestrator worker add <provider[:model]>';
  }
  if (sub === 'off' || sub === 'disable') { orchestratorEnable(cfg, false); persist(cfg); return 'orchestration off. provider → ' + read().provider; }
  if (sub === 'planner') {
    // No spec + a modal → drill the picker instead of erroring.
    if (!parts[1] && typeof ctx.openPicker === 'function') {
      const registry = await import('../providers/registry.mjs');
      const r = await orchestratorAction(ctx, registry, 'planner');
      return `${r}\n${fmt()}`;
    }
    if (!parts[1]) return 'usage: /orchestrator planner <provider[:model]>'; orchestratorSet(cfg, { planner: parts[1] }); persist(cfg); return 'planner → ' + parts[1];
  }
  if (sub === 'maxsubtasks') { const n = parseInt(parts[1], 10); if (!Number.isFinite(n)) return 'usage: /orchestrator maxsubtasks <N>'; orchestratorSet(cfg, { maxSubtasks: Math.max(1, Math.min(10, n)) }); persist(cfg); return fmt(); }
  if (sub === 'worker') {
    const action = (parts[1] || '').toLowerCase(); const spec = parts[2];
    const workers = [...orchestratorGet(cfg).workers];
    // worker add / remove with no spec + a modal → route through the picker
    // (add → provider/model pick; remove → pick from current workers).
    if ((action === 'add' || action === 'remove' || action === 'rm' || action === 'delete') && !spec && typeof ctx.openPicker === 'function') {
      const registry = await import('../providers/registry.mjs');
      const r = await orchestratorAction(ctx, registry, action === 'add' ? 'worker-add' : 'worker-remove');
      return `${r}\n${fmt()}`;
    }
    if (action === 'add' && spec) { if (!workers.includes(spec)) workers.push(spec); orchestratorSet(cfg, { workers }); persist(cfg); return 'workers: ' + workers.join(', '); }
    if ((action === 'remove' || action === 'rm' || action === 'delete') && spec) { const next = workers.filter((w) => w !== spec); orchestratorSet(cfg, { workers: next }); persist(cfg); return 'workers: ' + (next.join(', ') || '(none)'); }
    return 'usage: /orchestrator worker add|remove <provider[:model]>';
  }
  return 'usage: /orchestrator [status|on|off|planner <spec>|worker add|remove <spec>|maxsubtasks <N>]';
}
