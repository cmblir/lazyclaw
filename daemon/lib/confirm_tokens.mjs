// daemon/lib/confirm_tokens.mjs — one-shot confirmations for destructive
// slash commands issued over HTTP.
//
// The REPL asks "are you sure?" with a picker and blocks on the answer. HTTP
// has no such turn, so the two halves become two requests: the first is
// refused with a token, the second carries it back. The token is what makes
// the second request an *answer* rather than an independent command — so it
// is single-use (a replay cannot re-run the delete), bound to the exact line
// (a token for a harmless command cannot authorise a dangerous one), and
// short-lived (a stale browser tab cannot confirm something the operator has
// forgotten about).
//
// In-process memory on purpose: a daemon restart clears pending confirmations,
// which is the safe direction — the UI simply asks again.
import crypto from 'node:crypto';

export function makeConfirmStore({ ttlMs = 60000, now = Date.now } = {}) {
  const pending = new Map();   // token -> { line, expiresAt }

  function sweep(at) {
    for (const [tok, rec] of pending) if (rec.expiresAt <= at) pending.delete(tok);
  }

  return {
    issue(line) {
      const at = now();
      sweep(at);
      const token = `c_${crypto.randomBytes(16).toString('hex')}`;
      pending.set(token, { line: String(line), expiresAt: at + ttlMs });
      return token;
    },
    redeem(token, line) {
      if (typeof token !== 'string' || !token) return false;
      const rec = pending.get(token);
      if (!rec) return false;
      const at = now();
      if (rec.expiresAt <= at) {
        // Expired tokens are spent on first use, matching or not — an expired
        // token can never authorise anything, so there is nothing to preserve.
        pending.delete(token);
        return false;
      }
      if (rec.line !== String(line)) return false; // wrong line: leave the token live for its real line
      pending.delete(token); // single-use: consumed on a correct match
      return true;
    },
    size() { return pending.size; },
  };
}
