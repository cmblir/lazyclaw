// Provider, rate-card, and orchestrator-config commands, extracted from
// cli.mjs (Phase D3, picker-dependent batch — uses _fetchModelsForProvider).
import { readConfig, writeConfig } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { _fetchModelsForProvider } from '../tui/pickers.mjs';
import { probeProvider } from '../providers/probe.mjs';

export async function cmdRates(sub, positional, flags = {}) {
  // Manage cfg.rates without hand-editing JSON. Same shape as
  // RATE_CARD_SHAPE in providers/rates.mjs:
  //   { 'provider/model': { inputPer1M, outputPer1M, cacheReadPer1M?, cacheCreatePer1M?, currency? } }
  switch (sub) {
    case undefined:
    case 'list': {
      const cfg = readConfig();
      const rates = cfg.rates && typeof cfg.rates === 'object' ? cfg.rates : {};
      // Same --filter / --limit pattern as v3.33-v3.36 across
      // sessions/skills/workflows. Filter on key (provider/model)
      // case-insensitive, then post-filter cap.
      let entries = Object.entries(rates);
      if (flags.filter) {
        const f = String(flags.filter).toLowerCase();
        entries = entries.filter(([key]) => key.toLowerCase().includes(f));
      }
      if (flags.limit !== undefined) {
        const n = parseInt(flags.limit, 10);
        if (Number.isFinite(n) && n > 0) entries = entries.slice(0, n);
      }
      console.log(JSON.stringify(Object.fromEntries(entries), null, 2));
      return;
    }
    case 'set': {
      const key = positional[0];
      if (!key || !key.includes('/')) {
        console.error('Usage: lazyclaw rates set <provider/model> --input <N> --output <N> [--cache-read <N>] [--cache-create <N>] [--currency USD]');
        process.exit(2);
      }
      const inputPer1M = flags.input !== undefined ? Number(flags.input) : null;
      const outputPer1M = flags.output !== undefined ? Number(flags.output) : null;
      if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M) || inputPer1M < 0 || outputPer1M < 0) {
        console.error('rates set: --input and --output must be non-negative numbers (per million tokens)');
        process.exit(2);
      }
      const card = { inputPer1M, outputPer1M };
      if (flags['cache-read'] !== undefined) card.cacheReadPer1M = Number(flags['cache-read']);
      if (flags['cache-create'] !== undefined) card.cacheCreatePer1M = Number(flags['cache-create']);
      if (flags.currency) card.currency = String(flags.currency);
      else card.currency = 'USD';
      const cfg = readConfig();
      cfg.rates = cfg.rates || {};
      cfg.rates[key] = card;
      writeConfig(cfg);
      console.log(JSON.stringify({ ok: true, key, card }));
      return;
    }
    case 'delete':
    case 'unset': {
      const key = positional[0];
      if (!key) { console.error('Usage: lazyclaw rates delete <provider/model>'); process.exit(2); }
      const cfg = readConfig();
      const had = !!(cfg.rates && cfg.rates[key]);
      if (cfg.rates) delete cfg.rates[key];
      writeConfig(cfg);
      console.log(JSON.stringify({ ok: true, key, removed: had }));
      return;
    }
    case 'shape': {
      // Print the reference shape so users can copy-paste into config.
      const mod = await import('../providers/rates.mjs');
      console.log(JSON.stringify(mod.RATE_CARD_SHAPE, null, 2));
      return;
    }
    case 'copy': {
      // Clone a rate card from <src/model> to <dst/model>. Useful when
      // a new model launches at the same price as a known one and you
      // don't want to retype every field.
      //
      // Refuses to overwrite an existing destination unless --force is
      // passed (a rate card is operator-curated; silent overwrite is
      // exactly the wrong default).
      const src = positional[0];
      const dst = positional[1];
      if (!src || !dst || !src.includes('/') || !dst.includes('/')) {
        console.error('Usage: lazyclaw rates copy <src-provider/model> <dst-provider/model> [--force]');
        process.exit(2);
      }
      const cfg = readConfig();
      const rates = cfg.rates && typeof cfg.rates === 'object' ? cfg.rates : {};
      if (!rates[src]) {
        console.error(`rates copy: source key "${src}" not found in cfg.rates`);
        process.exit(1);
      }
      if (rates[dst] && !flags.force) {
        console.error(`rates copy: destination "${dst}" already exists (pass --force to overwrite)`);
        process.exit(1);
      }
      // Deep clone (small object) so a later edit to one doesn't
      // mutate the other.
      cfg.rates = rates;
      cfg.rates[dst] = JSON.parse(JSON.stringify(rates[src]));
      writeConfig(cfg);
      console.log(JSON.stringify({ ok: true, src, dst, card: cfg.rates[dst] }));
      return;
    }
    case 'validate': {
      // Shape check shared with daemon's GET /rates/validate via
      // rates-validate.mjs. Single source of truth.
      const cfg = readConfig();
      await ensureRegistry();
      const { validateRates } = await import('../rates-validate.mjs');
      const result = validateRates(cfg.rates, getRegistry().PROVIDERS);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }
    default:
      console.error('Usage: lazyclaw rates <list|set <key>|delete <key>|shape|validate>');
      process.exit(2);
  }
}

// Loads on first use to avoid paying the import cost when the user
// only ran `lazyclaw chat` or similar; cli.mjs is already a 2700-line
// hot path and we don't need every helper paged in.



// `lazyclaw memory <show|dream|edit> [args]`
//
// show core|recent|episodic [topic]    print contents to stdout
// dream                                consolidate recent into episodic
// edit core                            open $EDITOR on core.md


export async function cmdProviders(sub, positional, flags = {}) {
  await ensureRegistry();
  switch (sub) {
    case undefined:
    case 'list': {
      // Defensive: if metadata is missing for a registered provider, fall back
      // to a minimal shape so this never crashes the CLI even mid-refactor.
      // --filter / --limit pattern matches v3.33-v3.46 across the other
      // list surfaces. Filter on provider name, case-insensitive.
      let out = Object.keys(getRegistry().PROVIDERS).map(name => {
        const meta = getRegistry().PROVIDER_INFO[name] || { name, requiresApiKey: false, docs: '' };
        return {
          name,
          requiresApiKey: !!meta.requiresApiKey,
          defaultModel: meta.defaultModel || null,
          suggestedModels: meta.suggestedModels || [],
        };
      });
      if (flags.filter) {
        const f = String(flags.filter).toLowerCase();
        out = out.filter(p => p.name.toLowerCase().includes(f));
      }
      if (flags.limit !== undefined) {
        const n = parseInt(flags.limit, 10);
        if (Number.isFinite(n) && n > 0) out = out.slice(0, n);
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'info': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw providers info <name>'); process.exit(2); }
      const meta = getRegistry().PROVIDER_INFO[name];
      if (!meta) {
        console.error(`unknown provider: ${name} (registered: ${Object.keys(getRegistry().PROVIDERS).join(', ')})`);
        process.exit(2);
      }
      console.log(JSON.stringify(meta, null, 2));
      return;
    }
    case 'test': {
      // Smoke-test a provider with a tiny ("ping") prompt. Useful after
      // configuring a new API key — surfaces auth errors fast without
      // waiting for the next real call to fail.
      //
      // Output:
      //   { ok: bool, provider, model, durationMs, [reply | error, code] }
      //
      // Exit codes:
      //   0 — provider returned a non-empty reply
      //   1 — provider returned an error (auth failure, rate limit, ...)
      //   2 — invalid invocation (unknown name)
      //
      // No name OR --all: smoke-test every registered provider in
      // parallel. Output is `{ ok, results: [...] }` where ok is true
      // iff every entry passed. Exit 0 when all pass, 1 otherwise.
      const name = positional[0];
      const cfg = readConfig();
      const promptIdx = positional.indexOf('--prompt');
      const sharedPrompt = flags.prompt || (promptIdx >= 0 ? positional[promptIdx + 1] : null) || 'ping';
      if (!name || flags.all) {
        const apiKey = cfg['api-key'] || '';
        const t0all = Date.now();
        const results = await Promise.all(
          Object.entries(getRegistry().PROVIDERS).map(async ([pid, provider]) => {
            const meta = getRegistry().PROVIDER_INFO[pid] || {};
            const model = flags.model || cfg.model || meta.defaultModel || 'unknown';
            const t0 = Date.now();
            try {
              let reply = '';
              const stream = provider.sendMessage([{ role: 'user', content: sharedPrompt }], { apiKey, model });
              for await (const chunk of stream) {
                if (typeof chunk === 'string') reply += chunk;
              }
              return {
                name: pid, ok: reply.length > 0, model,
                durationMs: Date.now() - t0,
                replyLength: reply.length,
              };
            } catch (err) {
              return {
                name: pid, ok: false, model,
                durationMs: Date.now() - t0,
                error: err?.message || String(err),
                code: err?.code || null,
              };
            }
          }),
        );
        const allOk = results.every(r => r.ok);
        console.log(JSON.stringify({
          ok: allOk,
          totalDurationMs: Date.now() - t0all,
          results,
        }, null, 2));
        process.exit(allOk ? 0 : 1);
      }
      const provider = getRegistry().PROVIDERS[name];
      if (!provider) {
        console.error(`unknown provider: ${name} (registered: ${Object.keys(getRegistry().PROVIDERS).join(', ')})`);
        process.exit(2);
      }
      // cfg already declared above for the all-mode branch; reuse it.
      const meta = getRegistry().PROVIDER_INFO[name] || {};
      // --model wins over config.model wins over PROVIDER_INFO.defaultModel.
      const model = flags.model || cfg.model || meta.defaultModel || 'unknown';
      const prompt = flags.prompt || 'ping';
      const apiKey = cfg['api-key'] || '';
      // Shared, no-exit probe (providers/probe.mjs). The CLI prints JSON and
      // exits; the setup wizard renders one line and keeps going.
      const result = await probeProvider({ name, model, prompt, apiKey });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }
    case 'add': {
      // Register an OpenAI-compatible custom endpoint non-interactively.
      // Mirrors the picker's "+ Add custom" flow but scriptable, so users
      // can wire NIM / OpenRouter / vLLM into config without entering the
      // arrow-key UI.
      //   lazyclaw providers add nim \
      //     --base-url https://integrate.api.nvidia.com/v1 \
      //     --api-key nvapi-xxx \
      //     [--default-model meta/llama-3.1-70b] \
      //     [--no-probe]
      const name = positional[0];
      const baseUrl = flags['base-url'] || flags.baseUrl;
      const apiKey = flags['api-key'] || flags.apiKey || '';
      if (!name || !baseUrl) {
        console.error('Usage: lazyclaw providers add <name> --base-url <url> [--api-key <key>] [--default-model <id>] [--no-probe]');
        process.exit(2);
      }
      let validName;
      try { validName = getRegistry().validateCustomProviderName(name); }
      catch (e) { console.error(e.message); process.exit(2); }
      if (!/^https?:\/\//i.test(String(baseUrl))) {
        console.error('--base-url must start with http:// or https://');
        process.exit(2);
      }
      const cfg = readConfig();
      cfg.customProviders = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
      const idx = cfg.customProviders.findIndex((p) => p && p.name === validName);
      const entry = {
        name: validName,
        baseUrl: String(baseUrl).replace(/\/+$/, ''),
        apiKey: apiKey || undefined,
      };
      if (flags['default-model']) entry.defaultModel = flags['default-model'];
      if (idx >= 0) cfg.customProviders[idx] = { ...cfg.customProviders[idx], ...entry };
      else cfg.customProviders.push(entry);
      writeConfig(cfg);
      getRegistry().registerCustomProviders(cfg);

      let probe = null;
      if (!flags['no-probe']) {
        try {
          const list = await getRegistry().fetchOpenAICompatModels({
            baseUrl: entry.baseUrl, apiKey: entry.apiKey || '',
          });
          probe = { ok: true, modelCount: list.length, sample: list.slice(0, 8) };
          if (list.length) {
            const updated = readConfig();
            const i = (updated.customProviders || []).findIndex((p) => p && p.name === validName);
            if (i >= 0) {
              updated.customProviders[i].suggestedModels = list.slice(0, 50);
              if (!updated.customProviders[i].defaultModel) updated.customProviders[i].defaultModel = list[0];
              writeConfig(updated);
              getRegistry().registerCustomProviders(updated);
            }
          }
        } catch (e) {
          probe = { ok: false, error: e?.message || String(e) };
        }
      }
      console.log(JSON.stringify({
        ok: true, added: validName, baseUrl: entry.baseUrl, hasApiKey: !!entry.apiKey, probe,
      }, null, 2));
      return;
    }
    case 'remove': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw providers remove <name>'); process.exit(2); }
      const cfg = readConfig();
      const list = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
      const before = list.length;
      cfg.customProviders = list.filter((p) => !(p && p.name === name));
      if (cfg.customProviders.length === before) {
        console.error(`no custom provider named "${name}" — registered: ${list.map((p) => p.name).join(', ') || '(none)'}`);
        process.exit(2);
      }
      writeConfig(cfg);
      // The in-memory PROVIDERS map keeps the dropped entry until process
      // restart — fine for the CLI (each invocation re-registers from
      // disk). We don't try to mutate it here.
      console.log(JSON.stringify({ ok: true, removed: name }, null, 2));
      return;
    }
    case 'models': {
      // Fetch + print the live model list from a provider's /v1/models.
      // Works for any registered OpenAI-compatible endpoint (custom +
      // openai + ollama). Used by the picker but useful standalone too:
      //   lazyclaw providers models nim
      //   lazyclaw providers models openai --filter gpt-4
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw providers models <name> [--filter <substr>]'); process.exit(2); }
      if (!getRegistry().PROVIDERS[name]) {
        console.error(`unknown provider: ${name}`);
        process.exit(2);
      }
      try {
        const list = await _fetchModelsForProvider(name);
        let out = list;
        if (flags.filter) {
          const f = String(flags.filter).toLowerCase();
          out = out.filter((m) => m.toLowerCase().includes(f));
        }
        console.log(JSON.stringify({ ok: true, provider: name, count: out.length, models: out }, null, 2));
        return;
      } catch (e) {
        console.log(JSON.stringify({ ok: false, provider: name, error: e?.message || String(e) }, null, 2));
        process.exit(1);
      }
    }
    default:
      console.error('Usage: lazyclaw providers <list|info <name>|test <name>|add <name> --base-url <url> [--api-key <k>]|remove <name>|models <name>>');
      process.exit(2);
  }
}

// `lazyclaw orchestrator` — read/write the cfg.orchestrator section
// without editing config.json by hand. Mirrors the shape `lazyclaw
// providers` / `lazyclaw rates` already use.
//
// Subcommands:
//   status                        Print current planner / workers / maxSubtasks as JSON.
//   set-planner <provider[:model]>  Replace the planner spec.
//   workers add <provider[:model]>  Append a worker (idempotent — duplicates skipped).
//   workers remove <provider[:model]>  Drop a worker by exact match. Idempotent.
//   workers clear                 Empty the workers list.
//   workers set <provider[:model],...>  Replace the whole list (comma-separated).
//   set-max-subtasks <N>          Cap the number of subtasks (clamped 1..10).
//   clear                         Delete the entire cfg.orchestrator block.
export async function cmdOrchestrator(sub, positional, _flags = {}) {
  await ensureRegistry();
  const cfg = readConfig();
  const orch = cfg.orchestrator && typeof cfg.orchestrator === 'object' ? cfg.orchestrator : {};
  const known = Object.keys(getRegistry().PROVIDERS);
  const validateSpec = (spec) => {
    if (!spec) throw new Error('provider spec required (e.g. "claude-cli" or "openai:gpt-4o")');
    const colon = spec.indexOf(':');
    const provName = colon > 0 ? spec.slice(0, colon) : spec;
    if (provName === 'orchestrator') throw new Error('"orchestrator" cannot reference itself — pick a real provider');
    if (!known.includes(provName)) {
      throw new Error(`unknown provider "${provName}" — registered: ${known.join(', ')}`);
    }
    return spec;
  };
  const saveAndPrint = (next) => {
    if (next === null) delete cfg.orchestrator;
    else cfg.orchestrator = next;
    writeConfig(cfg);
    console.log(JSON.stringify(cfg.orchestrator || null, null, 2));
  };
  switch (sub) {
    case undefined:
    case 'status': {
      console.log(JSON.stringify({
        ok: true,
        configured: !!cfg.orchestrator,
        planner: orch.planner || null,
        workers: Array.isArray(orch.workers) ? orch.workers : [],
        maxSubtasks: Number.isFinite(orch.maxSubtasks) ? orch.maxSubtasks : null,
        knownProviders: known,
      }, null, 2));
      return;
    }
    case 'on':
    case 'off': {
      // Route cfg.provider to/from 'orchestrator' (shared with /orchestrator).
      const cf = await import('../config_features.mjs');
      cf.orchestratorEnable(cfg, sub === 'on');
      writeConfig(cfg);
      const w = Array.isArray(orch.workers) ? orch.workers.length : 0;
      console.log(JSON.stringify({ ok: true, enabled: sub === 'on', provider: cfg.provider, ...(sub === 'on' && w === 0 ? { warning: 'no workers configured — add one: lazyclaw orchestrator workers add <provider[:model]>' } : {}) }, null, 2));
      return;
    }
    case 'set-planner': {
      try {
        const spec = validateSpec(positional[0]);
        saveAndPrint({ ...orch, planner: spec });
      } catch (e) { console.error(`orchestrator: ${e.message}`); process.exit(2); }
      return;
    }
    case 'workers': {
      const wsub = positional[0];
      const workers = Array.isArray(orch.workers) ? orch.workers.slice() : [];
      switch (wsub) {
        case 'add': {
          try {
            const spec = validateSpec(positional[1]);
            if (!workers.includes(spec)) workers.push(spec);
            saveAndPrint({ ...orch, workers });
          } catch (e) { console.error(`orchestrator: ${e.message}`); process.exit(2); }
          return;
        }
        case 'remove': {
          const spec = positional[1];
          if (!spec) { console.error('orchestrator: workers remove <provider[:model]>'); process.exit(2); }
          const idx = workers.indexOf(spec);
          if (idx >= 0) workers.splice(idx, 1);
          saveAndPrint({ ...orch, workers });
          return;
        }
        case 'clear': {
          saveAndPrint({ ...orch, workers: [] });
          return;
        }
        case 'set': {
          const raw = positional[1] || '';
          const specs = raw.split(',').map((s) => s.trim()).filter(Boolean);
          try {
            specs.forEach(validateSpec);
            saveAndPrint({ ...orch, workers: specs });
          } catch (e) { console.error(`orchestrator: ${e.message}`); process.exit(2); }
          return;
        }
        default: {
          console.error('Usage: lazyclaw orchestrator workers <add <spec> | remove <spec> | clear | set <spec,spec,...>>');
          process.exit(2);
        }
      }
    }
    case 'set-max-subtasks': {
      const n = parseInt(positional[0], 10);
      if (!Number.isFinite(n) || n < 1) { console.error('orchestrator: set-max-subtasks <N>  (1..10)'); process.exit(2); }
      saveAndPrint({ ...orch, maxSubtasks: Math.min(10, Math.max(1, n)) });
      return;
    }
    case 'clear': {
      saveAndPrint(null);
      return;
    }
    default: {
      console.error(
        'Usage:\n' +
        '  lazyclaw orchestrator status\n' +
        '  lazyclaw orchestrator set-planner <provider[:model]>\n' +
        '  lazyclaw orchestrator workers add <provider[:model]>\n' +
        '  lazyclaw orchestrator workers remove <provider[:model]>\n' +
        '  lazyclaw orchestrator workers set <provider[:model],...>\n' +
        '  lazyclaw orchestrator workers clear\n' +
        '  lazyclaw orchestrator set-max-subtasks <N>\n' +
        '  lazyclaw orchestrator clear'
      );
      process.exit(2);
    }
  }
}
