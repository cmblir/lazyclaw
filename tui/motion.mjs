// tui/motion.mjs — shared motion primitives for the chat TUI.
//
// Split into a pure half (frame math: spinner, tween, reveal, shimmer) and a
// single React hook (useMotion) that owns one interval per animated component.
// The pure half is what every component derives its frame from, so it is the
// only part that needs a unit test — the components themselves are thin.
//
// Global gate: motionEnabled(). Animation is OFF when stdout is not a TTY
// (tests, pipes, CI), when the NO_COLOR standard applies, on dumb terminals,
// and when the user opts out with LAZYCLAW_NO_MOTION=1 (the reduced-motion
// escape hatch). Every animated component must check it.
//
// motionEnabled(env, stream) delegates its three shared checks (NO_COLOR,
// TERM==='dumb', !stream.isTTY) to tui/theme.mjs's colorEnabled(env, stream)
// and layers only LAZYCLAW_NO_MOTION on top. colorEnabled takes an injectable
// `env` (defaulting to process.env) for exactly this reason, so the two gates
// can't silently drift apart — a change to one is a change to both.

import { useState, useEffect } from 'react';
import { colorEnabled } from './theme.mjs';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_MS = 90;

export function spinnerFrame(tick) {
  const n = SPINNER_FRAMES.length;
  // Non-finite ticks (NaN, ±Infinity, non-numeric input) and negative ticks
  // (clock skew, a reset race) all clamp to frame 0 rather than wrapping
  // backward into the tail of the cycle or falling through to `undefined` —
  // a defensive floor, not a circular wrap.
  const t = Number.isFinite(tick) ? Math.trunc(tick) : 0;
  const i = Math.max(0, t) % n;
  return SPINNER_FRAMES[i];
}

export function motionEnabled(env = process.env, stream = process.stdout) {
  if (!env || env.LAZYCLAW_NO_MOTION === '1') return false;
  return colorEnabled(env, stream);
}

// Elapsed turn time. Seconds under a minute, zero-padded m/s above, so the
// status row's width stays stable as a turn runs long.
export function formatElapsed(ms) {
  const n = Number(ms);
  const safe = Number.isFinite(n) ? n : 0;
  const total = Math.max(0, Math.floor(safe / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function tween(from, to, progress) {
  const f = Number.isFinite(Number(from)) ? Number(from) : 0;
  const t = Number.isFinite(Number(to)) ? Number(to) : 0;
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return f + (t - f) * p;
}

// How many rows of a stacked banner are visible `elapsedMs` into a reveal.
export function revealRows(elapsedMs, totalRows, durationMs) {
  const total = Number.isFinite(totalRows) ? totalRows : 0;
  if (total <= 0) return 0;
  const duration = Number.isFinite(durationMs) ? durationMs : 0;
  if (duration <= 0) return total;
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const p = Math.min(1, Math.max(0, elapsed / duration));
  return Math.min(total, Math.round(p * total));
}

// Palette index for row `rowIndex` at animation `tick` — a diagonal sweep, so
// the highlight travels down the wordmark instead of flashing it uniformly.
export function shimmerIndex(rowIndex, tick, paletteLength) {
  const n = Number.isFinite(paletteLength) ? Math.max(1, Math.trunc(paletteLength)) : 1;
  const row = Number.isFinite(rowIndex) ? Math.trunc(rowIndex) : 0;
  const t = Number.isFinite(tick) ? Math.trunc(tick) : 0;
  return (((row + t) % n) + n) % n;
}

// One interval per animated component, torn down the moment it goes inactive.
// Returns a monotonically increasing tick (0 while inactive) so components stay
// pure functions of (props, tick).
export function useMotion(active, intervalMs) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setTick(0); return undefined; }
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return active ? tick : 0;
}
