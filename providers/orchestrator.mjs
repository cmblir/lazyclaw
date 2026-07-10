// Orchestrator provider — "openclaw-style" multi-agent dispatch.
//
// A user message arriving at PROVIDERS.orchestrator is NOT forwarded
// 1:1 to a single backend. Instead the provider performs three phases:
//
//   1. PLAN     — the configured planner provider decomposes the task
//                 into 2–5 self-contained subtasks (JSON shape).
//   2. EXECUTE  — each subtask is dispatched to a worker provider
//                 (round-robin over cfg.orchestrator.workers). Workers
//                 stream their replies; the orchestrator surfaces them
//                 inline so the user can watch progress.
//   3. SYNTHESIS — the planner re-enters with all subtask outputs and
//                 produces the final answer.
//
// Provider/model spec is "<provider>:<model>" (same shape as the chat
// REPL's `/model anthropic/claude-opus-4-7` after normalisation). When
// the model part is omitted, the worker's defaultModel from
// PROVIDER_INFO is used.
//
// Config (~/.lazyclaw/config.json):
//   {
//     "orchestrator": {
//       "planner": "claude-cli:claude-opus-4-7",
//       "workers": [
//         "claude-cli:claude-sonnet-4-6",
//         "openai:gpt-4o",
//         "gemini:gemini-2.5-pro"
//       ],
//       "maxSubtasks": 5,       // optional, default 5
//       "concurrency": 0        // optional; default = min(3, workers), parallel.
//                               //   0 or 1 = sequential (visible live streaming)
//     }
//   }
//
// Defaults: planner = the user's currently configured `cfg.provider`
// (so `lazyclaw onboard --provider claude-cli` works without any extra
// step), workers = [planner] (degenerates to a single-agent chain that
// still benefits from plan + synthesis structure).

// This module must NOT statically import ./registry.mjs — that formed a static
// import cycle (registry → orchestrator → registry). Provider lookup is now
// injected via makeOrchestratorProvider({ lookup }), so the dependency is
// one-directional (registry → orchestrator only).

function _parseSpec(spec) {
  if (!spec || typeof spec !== 'string') return { provider: '', model: '' };
  const colon = spec.indexOf(':');
  if (colon < 0) return { provider: spec.trim(), model: '' };
  return { provider: spec.slice(0, colon).trim(), model: spec.slice(colon + 1).trim() };
}

function _lookupProvider(spec, lookup) {
  const { provider, model } = _parseSpec(spec);
  const found = (typeof lookup === 'function' ? lookup(provider) : null) || {};
  const prov = found.prov;
  if (!prov) return null;
  const info = found.info || {};
  return {
    name: provider,
    model: model || info.defaultModel || '',
    prov,
    info,
  };
}

function _bestPlanArray(text) {
  // Planners sometimes wrap the JSON in prose / code fences. Try the
  // raw response first, then the largest [...] / [...]-shaped span.
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let arr = tryParse(text);
  if (Array.isArray(arr)) return arr;
  // Strip ```json fences
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) {
    arr = tryParse(fence[1].trim());
    if (Array.isArray(arr)) return arr;
  }
  // Largest [...] substring
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    arr = tryParse(text.slice(start, end + 1));
    if (Array.isArray(arr)) return arr;
  }
  return null;
}

// Default worker-pool concurrency when cfg.orchestrator.concurrency is unset.
// Parallel is the point of a worker pool; an unconfigured fleet should not run
// subtasks one at a time. Clamped to the worker count at the call site, and an
// explicit 0/1 still selects the sequential live-streaming path.
const DEFAULT_CONCURRENCY = 3;

// Opt-in agentic workers (cfg.orchestrator.agenticWorkers): an EXECUTE worker
// runs through runAgentTurn so it can actually DO work with its tools (shell,
// file read, recall) instead of only streaming text. Default OFF — the
// text-streaming path is byte-stable. Tool calls are confined by the sandbox
// the caller passes; the loop is bounded by workerMaxIterations.
const DEFAULT_WORKER_TOOLS = ['bash', 'read', 'grep', 'recall'];
const DEFAULT_WORKER_MAX_ITERATIONS = 8;
const AGENTIC_WORKER_ROLE =
  'You are an orchestrator worker. Complete ONLY the assigned subtask. Use your ' +
  'tools (shell, file read, grep, recall) to do real work when useful, then report ' +
  'the result concisely. Do not ask questions — act, then summarise what you found.';

const PLANNER_SYSTEM = `You are an orchestrator that decomposes a user request into independent subtasks for parallel worker agents.

Rules:
- Output ONLY a JSON array. No prose, no markdown, no code fences.
- Each entry has shape { "id": <int>, "task": "<one-sentence imperative>", "rationale": "<why this is a useful slice>" }.
- 2 to 5 subtasks. Each must be doable WITHOUT seeing the others' outputs (parallel-safe).
- If the request is genuinely atomic (e.g. "say hi"), return a single-element array.
- Do not add a synthesis / merge step — that runs separately after workers complete.
- Subtasks must be self-contained: include any context a worker needs to act on the task alone.`;

const SYNTHESIS_SYSTEM = `You are an orchestrator producing the final answer for the user.

You receive: (1) the user's original request, (2) the subtask plan you produced, (3) each worker's response.

Rules:
- Synthesize a single coherent answer. Distill — do not echo each worker verbatim.
- Cite worker findings briefly when they meaningfully diverge ("Worker A found …, Worker B confirmed").
- If a worker failed, acknowledge it but do not let it block the rest of the answer.
- Match the tone and length the user implied (one-line question → one-line answer; deep dive → deep dive).
- No JSON; this is the human-facing reply.`;

/**
 * Build an orchestrator provider. The chat REPL / agent / daemon path
 * treats it like any other provider — the `sendMessage` async iterable
 * yields markdown chunks describing plan + subtasks + synthesis.
 *
 * @param {Object} [opts]
 * @param {() => Record<string, unknown>} [opts.cfgGetter] reads ~/.lazyclaw/config.json
 * @param {(cfg, provider) => string} [opts.keyResolver] returns api-key for a worker provider (mirrors cli.mjs::_resolveAuthKey)
 */
export function makeOrchestratorProvider(opts = {}) {
  const cfgGetter = typeof opts.cfgGetter === 'function' ? opts.cfgGetter : () => ({});
  const keyResolver = typeof opts.keyResolver === 'function' ? opts.keyResolver : () => '';
  // Injected provider lookup: (provider) => { prov, info }. Supplied by the
  // registry so orchestrator never imports registry (breaks the static cycle).
  const lookup = typeof opts.lookup === 'function' ? opts.lookup : () => ({});

  return {
    name: 'orchestrator',
    async *sendMessage(messages, callerOpts = {}) {
      const cfg = cfgGetter() || {};
      const o = cfg.orchestrator && typeof cfg.orchestrator === 'object' ? cfg.orchestrator : {};
      const fallbackSpec = cfg.provider && cfg.provider !== 'orchestrator'
        ? `${cfg.provider}${cfg.model ? ':' + cfg.model : ''}`
        : 'claude-cli';
      // Unconfigured-orchestrator path (v5.3.2 fix): when cfg.orchestrator
      // is missing OR has no workers configured, the multi-agent pipeline
      // is unjustified — there is no second backend to delegate to. The
      // previous behaviour printed a "single-agent chain" banner and then
      // still ran Plan → Execute(N) → Synthesis against the same backend,
      // turning a trivial question into a 4-subtask decomposition. That
      // violates §1 truthfulness (the banner promised a single chain) and
      // the user's stated intent. Do a real passthrough instead.
      const hasWorkers = Array.isArray(o.workers) && o.workers.length > 0;
      if (!cfg.orchestrator || !hasWorkers) {
        const direct = _lookupProvider(fallbackSpec, lookup);
        if (!direct || direct.name === 'orchestrator') {
          yield `⚠ orchestrator: not configured and fallback provider \`${fallbackSpec}\` is not registered. ` +
            `Set \`cfg.orchestrator.planner\` + \`cfg.orchestrator.workers\`, or set \`cfg.provider\` to a real backend.\n`;
          return;
        }
        yield `> Orchestrator not configured — using single-shot \`${direct.name}${direct.model ? ':' + direct.model : ''}\`. ` +
          `Run \`lazyclaw orchestrator set-planner ${fallbackSpec}\` then \`lazyclaw orchestrator workers add <provider:model>\` to enable multi-agent.\n\n`;
        for await (const chunk of direct.prov.sendMessage(messages, {
          apiKey: keyResolver(cfg, direct.name),
          model: direct.model || undefined,
          signal: callerOpts.signal,
        })) yield String(chunk);
        return;
      }
      const plannerSpec = String(o.planner || fallbackSpec);
      const workerSpecs = o.workers.map(String);
      const maxSubtasks = Number.isFinite(o.maxSubtasks) && o.maxSubtasks > 0 ? Math.min(10, o.maxSubtasks) : 5;

      const planner = _lookupProvider(plannerSpec, lookup);
      if (!planner) {
        yield `⚠ orchestrator: planner provider "${plannerSpec}" is not registered. ` +
          `Set cfg.orchestrator.planner to a valid "provider:model" (e.g. "claude-cli:claude-opus-4-7").\n`;
        return;
      }
      // Self-recursion guard: a misconfigured cfg.orchestrator.planner =
      // "orchestrator" would otherwise spin forever, with each call
      // dispatching back to itself.
      if (planner.name === 'orchestrator') {
        yield `⚠ orchestrator: planner cannot be "orchestrator" — set cfg.orchestrator.planner to a real provider (e.g. "claude-cli:claude-opus-4-7").\n`;
        return;
      }
      const workers = workerSpecs.map((s) => _lookupProvider(s, lookup)).filter(Boolean).filter(w => w.name !== 'orchestrator');
      if (workers.length === 0) {
        yield `⚠ orchestrator: no usable workers (cfg.orchestrator.workers is empty, all unknown, or only references "orchestrator" itself).\n`;
        return;
      }

      const userText = (() => {
        // Most recent user message becomes the orchestration target. We
        // pass earlier turns as context to the planner only — workers
        // see a self-contained subtask string, not chat history.
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') return String(messages[i].content || '');
        }
        return '';
      })();

      // ── Phase 1: PLAN ───────────────────────────────────────────────
      yield `## 🦞 Orchestrator\n\n`;
      yield `Planner: \`${planner.name}${planner.model ? ':' + planner.model : ''}\`  ·  Workers: ${workers.map(w => `\`${w.name}${w.model ? ':' + w.model : ''}\``).join(', ')}\n\n`;
      yield `### 1. Planning\n\n`;

      const plannerMessages = [
        { role: 'system', content: PLANNER_SYSTEM },
        ...messages.filter(m => m.role === 'user' || m.role === 'assistant'),
      ];
      let planRaw = '';
      try {
        for await (const chunk of planner.prov.sendMessage(plannerMessages, {
          apiKey: keyResolver(cfg, planner.name),
          model: planner.model || undefined,
          signal: callerOpts.signal,
          maxTokens: 1024,
        })) {
          planRaw += String(chunk);
        }
      } catch (e) {
        yield `⚠ planner error: ${e?.message || String(e)}\n\n`;
        // Fallback: hand the user message to the first worker directly.
        const w = workers[0];
        yield `Falling back to direct call on \`${w.name}${w.model ? ':' + w.model : ''}\`:\n\n`;
        for await (const chunk of w.prov.sendMessage(messages, {
          apiKey: keyResolver(cfg, w.name),
          model: w.model || undefined,
          signal: callerOpts.signal,
        })) yield String(chunk);
        return;
      }

      const plan = _bestPlanArray(planRaw);
      if (!plan || plan.length === 0) {
        yield `⚠ planner returned no parseable JSON plan. Raw output:\n\n\`\`\`\n${planRaw.trim().slice(0, 800)}\n\`\`\`\n\nFalling back to single-shot on \`${planner.name}${planner.model ? ':' + planner.model : ''}\`:\n\n`;
        for await (const chunk of planner.prov.sendMessage(messages, {
          apiKey: keyResolver(cfg, planner.name),
          model: planner.model || undefined,
          signal: callerOpts.signal,
        })) yield String(chunk);
        return;
      }
      const trimmed = plan.slice(0, maxSubtasks).map((p, i) => ({
        id: Number.isFinite(p?.id) ? p.id : i + 1,
        task: String(p?.task || '').trim(),
        rationale: String(p?.rationale || '').trim(),
      })).filter(p => p.task);
      if (trimmed.length === 0) {
        yield `⚠ plan parsed but contained no usable subtasks. Falling back.\n\n`;
        for await (const chunk of planner.prov.sendMessage(messages, {
          apiKey: keyResolver(cfg, planner.name),
          model: planner.model || undefined,
          signal: callerOpts.signal,
        })) yield String(chunk);
        return;
      }

      for (const p of trimmed) {
        yield `${p.id}. **${p.task}**${p.rationale ? ` _— ${p.rationale}_` : ''}\n`;
      }
      yield `\n`;

      // ── Phase 2: EXECUTE ────────────────────────────────────────────
      // Concurrency policy (canonical spec §3 + C11 fix):
      //   concurrency <= 1  → sequential, streams each worker's chunks
      //                        inline as they arrive (live-feedback UX).
      //   concurrency >= 2  → Promise.all-based parallel dispatch. Each
      //                        worker buffers its own chunks; we flush
      //                        them IN PLAN ORDER (subtask 1, then 2, …)
      //                        so the user-facing output stays readable
      //                        regardless of which worker finished first.
      // The number is clamped to [1, workers.length] so a runaway value
      // can't accidentally over-subscribe a single worker.
      const rawConcurrency = Number.isFinite(o.concurrency) ? Math.floor(o.concurrency) : DEFAULT_CONCURRENCY;
      const concurrency = Math.max(1, Math.min(rawConcurrency, workers.length));
      yield `### 2. Executing ${trimmed.length} subtask${trimmed.length === 1 ? '' : 's'}${concurrency > 1 ? ` (concurrency=${concurrency}, parallel)` : ''}\n\n`;

      // Run one worker on one subtask through the agentic tool loop. Confined by
      // the caller's sandbox; bounded by workerMaxIterations; abort-propagating.
      const _runAgenticWorker = async (worker, sub) => {
        const { runAgentTurn } = await import('../mas/agent_turn.mjs');
        const r = await runAgentTurn({
          agent: {
            name: worker.name, provider: worker.name, model: worker.model,
            role: AGENTIC_WORKER_ROLE,
            tools: Array.isArray(o.workerTools) ? o.workerTools : DEFAULT_WORKER_TOOLS,
          },
          userMessage: sub.task,
          configDir: callerOpts.configDir,
          cwd: callerOpts.cwd,
          apiKey: keyResolver(cfg, worker.name),
          fetchImpl: callerOpts.fetchImpl,
          sandbox: callerOpts.sandbox,
          signal: callerOpts.signal,
          maxIterations: Number.isFinite(o.workerMaxIterations) ? o.workerMaxIterations : DEFAULT_WORKER_MAX_ITERATIONS,
        });
        // Structured control (additive): when a worker ends its subtask by
        // calling the `finish` tool and left no free-text answer, surface
        // the finish summary so the subtask isn't reported as empty. A
        // worker that both wrote text AND finished keeps its text (byte-
        // stable for the common case). Only reached on the opt-in agentic
        // worker path; the text-streaming default is untouched.
        const text = r.text || '';
        if (text) return text;
        const { detectControl } = await import('../mas/tools/control.mjs');
        const ctl = detectControl(r);
        if (ctl && ctl.control === 'finish' && ctl.summary) return ctl.summary;
        return '';
      };
      // Worker output as a chunk stream. agenticWorkers OFF (default) → the
      // provider's live token stream, byte-stable. ON → one buffered chunk with
      // the agent turn's final answer (tool work happened inside).
      const _workerChunks = async function* (worker, sub) {
        if (o.agenticWorkers) {
          const text = await _runAgenticWorker(worker, sub);
          if (text) yield text;
          return;
        }
        yield* worker.prov.sendMessage([{ role: 'user', content: sub.task }], {
          apiKey: keyResolver(cfg, worker.name),
          model: worker.model || undefined,
          signal: callerOpts.signal,
        });
      };

      const results = [];
      if (concurrency <= 1) {
        // Sequential streaming path — historical default, preserved.
        for (let i = 0; i < trimmed.length; i++) {
          const sub = trimmed[i];
          const worker = workers[i % workers.length];
          yield `**Subtask ${sub.id}** \`${worker.name}${worker.model ? ':' + worker.model : ''}\` — ${sub.task}\n\n`;
          let res = '';
          try {
            for await (const chunk of _workerChunks(worker, sub)) {
              const s = String(chunk);
              res += s;
              yield s;
            }
            results.push({ ...sub, worker: `${worker.name}${worker.model ? ':' + worker.model : ''}`, result: res, error: null });
          } catch (e) {
            const msg = e?.message || String(e);
            yield `\n⚠ worker error: ${msg}\n`;
            results.push({ ...sub, worker: `${worker.name}${worker.model ? ':' + worker.model : ''}`, result: '', error: msg });
          }
          yield `\n\n---\n\n`;
        }
      } else {
        // Parallel dispatch — buffer chunks per subtask, then flush in
        // plan order. We start every subtask up-front (Promise.all over
        // the slice) so wall-clock equals max-per-subtask, not sum.
        // A single subtask failure does NOT block the others — the
        // _runSubtask wrapper catches and records the error inline.
        async function _runSubtask(sub, worker) {
          const chunks = [];
          let error = null;
          try {
            for await (const chunk of _workerChunks(worker, sub)) {
              chunks.push(String(chunk));
            }
          } catch (e) {
            error = e?.message || String(e);
          }
          return { sub, worker, chunks, error };
        }
        // Bounded worker pool (E1): run at most `concurrency` subtasks at
        // once instead of firing all of them via one Promise.all. A large
        // plan would otherwise open N simultaneous provider streams —
        // over-subscribing rate limits and buffering every worker's chunks
        // at the same time. Results are stored by index so the plan-order
        // flush below is unchanged; for plans with <= concurrency subtasks
        // every subtask still starts immediately (identical to before).
        const settled = new Array(trimmed.length);
        let nextIdx = 0;
        async function _poolWorker() {
          for (let i = nextIdx++; i < trimmed.length; i = nextIdx++) {
            settled[i] = await _runSubtask(trimmed[i], workers[i % workers.length]);
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(concurrency, trimmed.length) }, () => _poolWorker()),
        );
        // Flush in plan order so the synthesis prompt + user view see
        // subtask 1, then 2, etc.
        for (const { sub, worker, chunks, error } of settled) {
          yield `**Subtask ${sub.id}** \`${worker.name}${worker.model ? ':' + worker.model : ''}\` — ${sub.task}\n\n`;
          const text = chunks.join('');
          if (text) yield text;
          if (error) yield `\n⚠ worker error: ${error}\n`;
          results.push({
            ...sub,
            worker: `${worker.name}${worker.model ? ':' + worker.model : ''}`,
            result: text,
            error,
          });
          yield `\n\n---\n\n`;
        }
      }

      // ── Phase 3: SYNTHESIS ──────────────────────────────────────────
      yield `### 3. Synthesis\n\n`;
      const synthUser = [
        `Original request:\n${userText}`,
        `\nSubtask plan and worker outputs:`,
        ...results.map(r => `\n#### Subtask ${r.id} — ${r.task}\nWorker: ${r.worker}\n${r.error ? `Error: ${r.error}` : r.result.trim()}`),
        `\nNow write the final answer for the user.`,
      ].join('\n');
      try {
        for await (const chunk of planner.prov.sendMessage([
          { role: 'system', content: SYNTHESIS_SYSTEM },
          { role: 'user', content: synthUser },
        ], {
          apiKey: keyResolver(cfg, planner.name),
          model: planner.model || undefined,
          signal: callerOpts.signal,
        })) yield String(chunk);
      } catch (e) {
        yield `⚠ synthesis error: ${e?.message || String(e)}. Worker outputs above are the final material — please review them directly.\n`;
      }

      // v5 (canonical decision C2) — fire the canonical post-task
      // learning hook in a microtask so the user's stream is not
      // blocked. Failures are silent here; mas/learning.mjs already
      // swallows each sub-routine's errors and the audit log captures
      // observability on its own. We import lazily so the orchestrator
      // module stays cheap to load when learning is unused.
      queueMicrotask(() => {
        import('../mas/orchestra.mjs')
          .then(o => o.firePostTask({
            cfg,
            agent: { name: 'orchestrator', provider: planner.name, model: planner.model, role: SYNTHESIS_SYSTEM },
            task: {
              id: `orch-${Date.now()}`,
              title: userText.slice(0, 80),
              turns: [
                { agent: 'user', text: userText },
                ...results.map(r => ({ agent: r.worker, text: r.result || r.error || '' })),
              ],
            },
          }))
          .catch(() => { /* swallow — learning is best-effort */ });
      });
    },
  };
}

// Minimal one-shot worker dispatch for the `delegate` agent tool.
//
// `delegate` hands a single subtask to ONE provider — no plan/synthesis.
// It reuses the same spec-resolution + key-resolution infra the
// orchestrator's EXECUTE phase uses (a "<provider>[:<model>]" spec routed
// through PROVIDERS/PROVIDER_INFO, key via lib/config::_resolveAuthKey),
// but as a standalone call so the `delegate` tool actually runs.
//
// Imports are lazy so this module keeps its leaf static-dep graph (it must
// NOT statically import ./registry.mjs — that re-forms the registry↔orch
// cycle; see the header note above).
//
// job = { worker: '<provider>[:<model>]', prompt, model? }
// returns { ok:true, text } | { ok:false, error }
export async function dispatchWorker(job = {}) {
  const workerSpec = String(job?.worker || '');
  const prompt = String(job?.prompt || '');
  if (!workerSpec || !prompt) return { ok: false, error: 'delegate: worker + prompt required' };

  let registry, config;
  try {
    registry = await import('./registry.mjs');
    config = await import('../lib/config.mjs');
  } catch (e) {
    return { ok: false, error: `delegate: failed to load provider infra: ${e?.message || String(e)}` };
  }

  const lookup = (p) => ({ prov: registry.PROVIDERS[p], info: registry.PROVIDER_INFO[p] });
  const worker = _lookupProvider(workerSpec, lookup);
  if (!worker) return { ok: false, error: `delegate: unknown worker provider "${_parseSpec(workerSpec).provider}"` };
  if (worker.name === 'orchestrator') return { ok: false, error: 'delegate: worker cannot be "orchestrator"' };
  // Explicit job.model overrides the model parsed from the spec.
  const model = String(job?.model || '') || worker.model || '';

  const cfg = config.readConfig() || {};
  const apiKey = config._resolveAuthKey(cfg, worker.name);

  let text = '';
  try {
    for await (const chunk of worker.prov.sendMessage([{ role: 'user', content: prompt }], {
      apiKey,
      model: model || undefined,
    })) {
      text += String(chunk);
    }
  } catch (e) {
    return { ok: false, error: `delegate: ${worker.name} error: ${e?.message || String(e)}` };
  }
  return { ok: true, text };
}
