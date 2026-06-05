// mas/orchestra.mjs — v5.0 spec §3 / canonical decision C2.
//
// "Orchestra" hub — the eventual home of the multi-agent dispatcher
// (planner + workers + synthesis). For v5.0.10 it acts as a thin
// coordinator layer:
//
//   1. Re-exports `makeOrchestratorProvider` from providers/orchestrator.mjs
//      so cli.mjs / providers/registry.mjs can migrate the import path
//      without breaking ~20 call sites in one commit.
//   2. Owns `POST_HOC_HOOK_NAMES` — the canonical list of triggers the
//      orchestrator may fan into mas/learning.mjs. Mirrors the
//      learning module's TRIGGERS so callers can `import { POST_HOC_HOOK_NAMES }
//      from 'mas/orchestra.mjs'` without pulling the whole learning
//      surface.
//   3. Provides `firePostTask({ ... })` — a microtask-safe wrapper around
//      `learning.runLearning('post-task', …)` so the SYNTHESIS phase of
//      providers/orchestrator.mjs can hook in via a single import line.
//
// Future (Phase 2): the dispatcher itself moves in here and
// providers/orchestrator.mjs becomes a thin shim that re-exports from
// mas/orchestra.mjs. Until then the boundary is one-way — orchestra
// imports from providers/orchestrator.mjs, never the other way around.

import { makeOrchestratorProvider as _make } from '../providers/orchestrator.mjs';
import { TRIGGERS, runLearning } from './learning.mjs';

// Re-export so callers can migrate gradually.
export const makeOrchestratorProvider = _make;

// Public alias mirroring the spec language ("post-hoc hooks"). Frozen
// so a typo on the consumer side surfaces at import time.
export const POST_HOC_HOOK_NAMES = TRIGGERS;

/**
 * Fire a learning trigger without blocking the caller's stream. Wraps
 * runLearning in queueMicrotask + a swallow-everything catch so a
 * misconfigured trainer key (or a transient FS error) can never poison
 * the user-facing orchestrator output.
 *
 * @param {(typeof TRIGGERS)[number]} trigger
 * @param {Record<string, unknown>} ctx
 */
export function fireLearning(trigger, ctx) {
  queueMicrotask(() => {
    runLearning(trigger, ctx).catch(() => { /* swallow */ });
  });
}

/**
 * Convenience for the common case — the orchestrator's SYNTHESIS phase
 * just finished, fire the post-task hook. Equivalent to
 * fireLearning('post-task', ctx).
 */
export function firePostTask(ctx) {
  fireLearning('post-task', ctx);
}
