// commands/chat_hardening.mjs — chat-path reliability helpers, extracted from
// commands/chat.mjs to keep that file under its file-size ceiling.
//
// 1. wrapInteractiveProv: wrap the active chat provider with the same
//    transient-retry the daemon composes, so a 429/529/5xx before the first
//    chunk is retried instead of surfacing as a chat "error: ..." line. The
//    wrapper never retries a mid-stream error (would duplicate output).
// 2. makeLegacyApprove: the readline approval hook for the legacy / non-TTY
//    chat path, so agentic sensitive tools have a fail-closed human gate.

import { withRateLimitRetry } from '../providers/retry.mjs';
import { makeReadlineApprove } from '../tui/terminal_approve.mjs';

// Guard-safe: returns the falsy input unchanged so the caller's
// unknown-provider check still fires (withRateLimitRetry(undefined) would
// otherwise produce a truthy "undefined+retry" wrapper).
export function wrapInteractiveProv(prov) {
  return prov ? withRateLimitRetry(prov) : prov;
}

export function makeLegacyApprove() {
  return makeReadlineApprove();
}
