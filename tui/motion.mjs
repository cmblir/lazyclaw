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
// motionEnabled takes (env, stream) as explicit parameters rather than
// wrapping tui/theme.mjs's colorEnabled(stream), which reads process.env
// directly. That gate can't be probed with a fake env object, and this
// package's own tests need to inject LAZYCLAW_NO_MOTION / NO_COLOR / TERM
// without mutating the real process.env — so the two gates share logic by
// eye, not by delegation.

import { useState, useEffect } from 'react';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_MS = 90;

export function spinnerFrame(tick) {
  const n = SPINNER_FRAMES.length;
  // Negative ticks (clock skew, a reset race) clamp to frame 0 rather than
  // wrapping backward into the tail of the cycle — a defensive floor, not a
  // circular wrap.
  const i = Math.max(0, Math.trunc(tick)) % n;
  return SPINNER_FRAMES[i];
}

export function motionEnabled(env = process.env, stream = process.stdout) {
  if (!env || env.LAZYCLAW_NO_MOTION === '1') return false;
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  if (!stream || !stream.isTTY) return false;
  return true;
}

// Elapsed turn time. Seconds under a minute, zero-padded m/s above, so the
// status row's width stays stable as a turn runs long.
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function tween(from, to, progress) {
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return from + (to - from) * p;
}

// How many rows of a stacked banner are visible `elapsedMs` into a reveal.
export function revealRows(elapsedMs, totalRows, durationMs) {
  if (totalRows <= 0) return 0;
  if (!durationMs || durationMs <= 0) return totalRows;
  const p = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return Math.min(totalRows, Math.round(p * totalRows));
}

// Palette index for row `rowIndex` at animation `tick` — a diagonal sweep, so
// the highlight travels down the wordmark instead of flashing it uniformly.
export function shimmerIndex(rowIndex, tick, paletteLength) {
  const n = Math.max(1, paletteLength);
  return (((rowIndex + tick) % n) + n) % n;
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
