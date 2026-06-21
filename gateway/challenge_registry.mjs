// gateway/challenge_registry.mjs — single-use anti-replay challenge ledger.
//
// Extracted from device_auth.mjs (which sat at its size ceiling) with ZERO
// behaviour change. verifyConnect is intentionally pure (it cannot mutate
// state), so the anti-replay guarantee lives here: every minted challenge can
// be redeemed AT MOST ONCE and only inside its freshness window. createChallenge
// + DEFAULT_MAX_SKEW_MS stay in device_auth.mjs (verifyConnect uses them too)
// and are imported here, so there is one source of truth and no import cycle.
//
// Lifecycle per connect:
//   const c = registry.create();          // hand `c` to the client
//   ...client signs payload carrying c.nonce...
//   if (!verifyConnect({ ..., challenge: c, nowMs })) reject;
//   if (!registry.consume(c.nonce, nowMs)) reject;   // replay / expiry guard

import { createChallenge, DEFAULT_MAX_SKEW_MS } from './device_auth.mjs';

export class ChallengeRegistry {
  /**
   * @param {{ maxSkewMs?: number, maxPending?: number, sweepEvery?: number }} [opts]
   */
  constructor({ maxSkewMs = DEFAULT_MAX_SKEW_MS, maxPending = 10000, sweepEvery = 256 } = {}) {
    this.maxSkewMs = maxSkewMs;
    this.maxPending = maxPending;
    this.sweepEvery = sweepEvery;
    this._sinceSweep = 0;
    /** @type {Map<string, number>} nonce -> mint ts (epoch ms) */
    this._pending = new Map();
  }

  /**
   * Mint and register a fresh challenge. Identical shape to createChallenge().
   * The ledger is self-healing: stale nonces (older than ±maxSkewMs, which can
   * never be consumed anyway) are swept opportunistically, and a hard cap
   * evicts the oldest so an unauthenticated flood of un-redeemed challenges can
   * never grow memory without bound.
   * @returns {{ nonce: string, ts: number }}
   */
  create() {
    const challenge = createChallenge();
    this._pending.set(challenge.nonce, challenge.ts);
    if (++this._sinceSweep >= this.sweepEvery) {
      this._sinceSweep = 0;
      this._sweep(challenge.ts);
    }
    // Hard cap — evict oldest (Map preserves insertion order) until within
    // bound. O(1) amortized per create under a sustained flood.
    while (this._pending.size > this.maxPending) {
      const oldest = this._pending.keys().next().value;
      if (oldest === undefined) break;
      this._pending.delete(oldest);
    }
    return challenge;
  }

  // Drop entries that can no longer verify (outside ±maxSkewMs of nowMs).
  _sweep(nowMs) {
    for (const [nonce, ts] of this._pending) {
      if (Math.abs(nowMs - ts) > this.maxSkewMs) this._pending.delete(nonce);
    }
  }

  /**
   * Redeem a challenge exactly once. Returns true only when the nonce is known,
   * has NOT been consumed before, and is still within ±maxSkewMs of `nowMs`.
   * Any successful or expired redemption removes the nonce so it can never be
   * replayed.
   *
   * @param {string} nonce
   * @param {number} nowMs
   * @returns {boolean}
   */
  consume(nonce, nowMs) {
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
    const ts = this._pending.get(nonce);
    if (ts === undefined) {
      // Unknown OR already consumed — either way, reject as replay.
      return false;
    }
    // Single-use: drop it now, before any further decision, so a concurrent or
    // repeated call can never redeem the same nonce twice.
    this._pending.delete(nonce);
    const skew = Math.abs(nowMs - ts);
    if (skew > this.maxSkewMs) {
      return false; // expired (stale or implausibly future)
    }
    return true;
  }
}
