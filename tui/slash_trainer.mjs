// tui/slash_trainer.mjs — the /trainer slash-command handler, extracted verbatim
// from slash_dispatcher.mjs. Drives the synthesis / learning model selection
// (set / fallback / show / clear) plus the bare-menu picker. Imports its leaf
// helpers from slash_helpers.mjs and the shared provider/model picker from
// model_pick.mjs, never the dispatcher (no cycle). Recurses internally
// (_trainer('show', ctx)) — that recursion stays inside this module.

import { pickProviderModel, providerLookup as _providerLookup } from './model_pick.mjs';
import { renderRecord } from '../lib/render.mjs';
import { splitWhitespace, _mod, _parseProvModel, _promptConfirm } from './slash_helpers.mjs';

export async function _trainer(args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  const tokens = splitWhitespace(args);

  // Bare /trainer with a modal available → an action menu (mirrors the bare
  // /orchestrator menu). "Set"/"Fallback" re-enter and drill the shared
  // provider→model picker; "Clear"/"Show" run their subcommands. Typed forms
  // (/trainer set <p:m>, etc.) still work and skip the menu.
  if (tokens.length === 0 && typeof ctx.openPicker === 'function') {
    let cur = '';
    try {
      if (typeof registry.resolveTrainer === 'function') {
        const e = registry.resolveTrainer(ctx.cfg || {});
        cur = `now: ${e.provider}${e.model ? ':' + e.model : ':(default)'}`;
      }
    } catch { /* show menu without the current hint */ }
    const picked = await ctx.openPicker({
      kind: 'menu',
      title: 'Trainer — synthesis / learning model',
      subtitle: cur || 'pick provider + model for trainer turns',
      items: [
        { id: 'set', label: 'Set trainer…', desc: 'pick provider + model (or auto / provider default)' },
        { id: 'fallback', label: 'Set fallback…', desc: 'pick a fallback provider + model' },
        { id: 'clear', label: 'Clear', desc: 'unset — mirror the chat provider/model' },
        { id: 'show', label: 'Show', desc: 'print the effective + configured trainer' },
      ],
    });
    const id = picked && typeof picked === 'object' ? picked.id : picked;
    if (!id || typeof id !== 'string') return _trainer('show', ctx); // cancelled → show status
    return _trainer(id, ctx); // re-enter; set/fallback open the picker (no spec)
  }

  const sub = tokens[0] || 'show';

  if (sub === 'show') {
    let effective = { provider: ctx.getActiveProvName ? ctx.getActiveProvName() : null,
                      model: ctx.getActiveModel ? ctx.getActiveModel() : null };
    try {
      if (typeof registry.resolveTrainer === 'function') {
        effective = registry.resolveTrainer(ctx.cfg || {});
      }
    } catch { /* fall through */ }
    const configured = (ctx.cfg && ctx.cfg.trainer) || null;
    const cfgRender = configured
      ? renderRecord(configured, { fields: ['provider', 'model', 'fallback'] }).split('\n').map((l) => '  ' + l).join('\n')
      : '(unset — trainer mirrors the chat provider/model)';
    return [
      'trainer (effective):',
      `  provider: ${effective.provider}`,
      `  model:    ${effective.model || '(default)'}`,
      'trainer (configured):',
      cfgRender,
    ].join('\n');
  }

  if (sub === 'set') {
    let spec = tokens[1];
    let _setFromPicker = false;
    // No spec + a modal available → drill the shared picker (with an "auto"
    // row and a "provider default" row) instead of requiring a typed spec.
    if (!spec && typeof ctx.openPicker === 'function') {
      const r = await pickProviderModel(ctx, registry, { includeAuto: true, includeDefault: true });
      if (!r || r.model == null) return 'trainer set: cancelled';
      spec = r.provider === 'auto' ? 'auto' : (r.model ? `${r.provider}:${r.model}` : r.provider);
      _setFromPicker = true;
    }
    if (!spec) return 'usage: /trainer set <provider>[:<model>]  (or `auto` for orchestrator-managed)';
    const parsed = typeof registry.parseProviderModel === 'function'
      ? registry.parseProviderModel(spec)
      : { provider: spec.split(':')[0], model: spec.split(':')[1] || null };
    if (!parsed || !parsed.provider) return `/trainer set: could not parse "${spec}"`;
    if (parsed.provider !== 'auto') {
      const next = _providerLookup(registry, parsed.provider);
      if (!next) return `/trainer set: unknown provider "${parsed.provider}"`;
    }
    // Optional `--fallback <provider[:model]>` — resolveTrainer routes here
    // when opts.useFallback is set. Validate before persisting.
    let fallbackSpec = null;
    const fi = tokens.indexOf('--fallback');
    if (fi >= 0) {
      fallbackSpec = tokens[fi + 1];
      if (!fallbackSpec) return 'usage: /trainer set <p:m> --fallback <p:m>';
      const fp = _parseProvModel(registry, fallbackSpec);
      if (!fp.provider) return `/trainer set: could not parse fallback "${fallbackSpec}"`;
      if (fp.provider !== 'auto' && !_providerLookup(registry, fp.provider)) {
        return `/trainer set: unknown provider "${fp.provider}"`;
      }
    }
    // Picker-driven set with no --fallback flag → offer an optional fallback
    // pick (the flag form stays the escape hatch for typed callers).
    if (_setFromPicker && !fallbackSpec && typeof ctx.openPicker === 'function') {
      const addFb = await _promptConfirm(ctx, { title: 'Add a fallback trainer?', subtitle: 'used when the primary is unavailable · Esc / deny to skip' });
      if (addFb) {
        const fr = await pickProviderModel(ctx, registry, { includeAuto: true, includeDefault: true });
        if (fr && fr.model != null) {
          fallbackSpec = fr.provider === 'auto' ? 'auto' : (fr.model ? `${fr.provider}:${fr.model}` : fr.provider);
        }
      }
    }
    // Read-merge-write so unrelated cfg keys survive.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfgPath = path.join(ctx.cfgDir, 'config.json');
    let diskCfg = {};
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
    diskCfg.trainer = { ...(diskCfg.trainer || {}), provider: parsed.provider };
    if (parsed.model) diskCfg.trainer.model = parsed.model;
    else delete diskCfg.trainer.model;
    if (fallbackSpec) diskCfg.trainer.fallback = fallbackSpec;
    try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
    if (ctx.cfg) ctx.cfg.trainer = { ...diskCfg.trainer };
    return `✓ trainer → ${parsed.provider}${parsed.model ? ':' + parsed.model : ''}${fallbackSpec ? ` (fallback: ${fallbackSpec})` : ''}`;
  }

  if (sub === 'fallback') {
    let spec = tokens[1];
    if (!spec && typeof ctx.openPicker === 'function') {
      const r = await pickProviderModel(ctx, registry, { includeAuto: true, includeDefault: true });
      if (!r || r.model == null) return 'trainer fallback: cancelled';
      spec = r.provider === 'auto' ? 'auto' : (r.model ? `${r.provider}:${r.model}` : r.provider);
    }
    if (!spec) return 'usage: /trainer fallback <provider>[:<model>]  |  clear';
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfgPath = path.join(ctx.cfgDir, 'config.json');
    let diskCfg = {};
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
    if (spec === 'clear' || spec === 'unset') {
      if (diskCfg.trainer) delete diskCfg.trainer.fallback;
      try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
      fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
      if (ctx.cfg && ctx.cfg.trainer) delete ctx.cfg.trainer.fallback;
      return '✓ trainer fallback cleared';
    }
    const fp = _parseProvModel(registry, spec);
    if (!fp.provider) return `/trainer fallback: could not parse "${spec}"`;
    if (fp.provider !== 'auto' && !_providerLookup(registry, fp.provider)) {
      return `/trainer fallback: unknown provider "${fp.provider}"`;
    }
    diskCfg.trainer = { ...(diskCfg.trainer || {}), fallback: spec };
    try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
    if (ctx.cfg) ctx.cfg.trainer = { ...diskCfg.trainer };
    return `✓ trainer fallback → ${spec}`;
  }

  if (sub === 'clear' || sub === 'unset') {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfgPath = path.join(ctx.cfgDir, 'config.json');
    let diskCfg = {};
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh */ }
    delete diskCfg.trainer;
    try { fs.mkdirSync(ctx.cfgDir, { recursive: true }); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));
    if (ctx.cfg) delete ctx.cfg.trainer;
    return '✓ trainer cleared (will mirror chat provider/model)';
  }

  return `/trainer: unknown sub "${sub}" — show|set <p:m>|clear`;
}
