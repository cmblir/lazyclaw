// workflow/error_policy.mjs — code-based error taxonomy + per-node onError
// policy for the persistent workflow engines. Extracted from persistent.mjs so
// the engine file stays under the size gate and the classification is unit-
// testable in isolation.

// Classify by the tagged `code` that runWithTimeout (TIMEOUT) and the abort
// path (ABORT) set — NOT by sniffing the message string. Returns a stable code
// so the per-node onError policy + retry logic branch consistently across both
// engines. TIMEOUT is the retryable transient; ABORT is cancellation; anything
// else is an ERROR (a node failure).
export function classifyError(err) {
  if (!err) return 'ERROR';
  if (err.code === 'ABORT') return 'ABORT';
  // The canonical timeout shape from runWithTimeout carries code:'TIMEOUT'.
  // We keep the exact-message fallback for the legacy `new Error('TIMEOUT')`
  // throw shape, but drop the fragile substring sniff (a node throwing
  // "connection timeout" is a node failure, not an engine timeout).
  if (err.code === 'TIMEOUT' || err.message === 'TIMEOUT') return 'TIMEOUT';
  return 'ERROR';
}

export function isTimeout(err) {
  return classifyError(err) === 'TIMEOUT';
}

// Per-node onError policy. Default (undefined) = current fail-fast behavior.
// Returns one of 'retry' | 'fallback' | 'continue' | 'fail' — normalized so an
// unknown/typo value degrades to the safe 'fail' default rather than silently
// swallowing an error.
export function errorPolicy(node) {
  const p = node && node.onError;
  return p === 'retry' || p === 'fallback' || p === 'continue' ? p : 'fail';
}
