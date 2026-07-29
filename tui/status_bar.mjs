// tui/status_bar.mjs — the sticky single/double status row above the chat
// input. Row 1: streaming indicator · provider · model · ctx gauge. Row 2
// (only when the HUD is enabled): real-time usage, cost, trainer, orchestrator.
// Extracted from repl.mjs so the HUD can grow without pushing repl.mjs over the
// file-size ratchet.

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.mjs';
import { formatHudRow, formatGauge, gaugeCells } from './hud.mjs';
import { spinnerFrame, SPINNER_MS, motionEnabled, formatElapsed, useMotion, tween } from './motion.mjs';

// How fast the streaming dot pulses, in ms. Exported so it's not a magic number.
export const BLINK_MS = 450;

// How long the ctx gauge takes to walk to its new fill, and how often it steps.
export const GAUGE_TWEEN_MS = 300;
export const GAUGE_TWEEN_STEP_MS = 50;

// The leading status glyph. While streaming with motion on, a braille spinner
// turns and the turn's elapsed time counts up; with motion off it falls back to
// the pre-motion pulsing dot. Idle is a steady hollow dot either way.
// Pure (takes the current phase/tick) so it is unit-testable without a timer.
export function streamingIndicator(streaming, blinkOn, t = theme, opts = {}) {
  if (!streaming) return t.dim('○ idle');
  if (opts.motion) {
    const elapsed = formatElapsed(opts.elapsedMs || 0);
    return t.success(`${spinnerFrame(opts.tick || 0)} streaming ${elapsed}`);
  }
  // Pulse a GREEN dot while streaming (live/working), not the amber accent.
  return blinkOn ? t.success('● streaming') : t.dim('● streaming');
}

export function StatusBar({ provider, model, streaming, ctxUsed, ctxTotal, hud, streamStartedAt, liveChars }) {
  const motion = motionEnabled();
  // One interval either way: the spinner ticks fast, the legacy pulse slow.
  const tick = useMotion(!!streaming, motion ? SPINNER_MS : BLINK_MS);
  const blinkOn = tick % 2 === 0;
  const elapsedMs = streaming && streamStartedAt ? Date.now() - streamStartedAt : 0;

  // Numbers are computed upstream (chat-history budget, not provider self-report);
  // formatGauge only changes the RENDERING — adds percent + bar + warn marker.
  const targetCells = (ctxUsed != null && ctxTotal != null && ctxTotal > 0)
    ? gaugeCells((ctxUsed / ctxTotal) * 100) : 0;

  // Fill the bar stepwise toward its new level instead of snapping.
  //
  // State is adjusted DURING render (React's documented pattern for "reset
  // state when a prop changes"), not in a useEffect that resets a separate
  // "tween start" state: an effect fires one commit AFTER the render that
  // first notices the new target, so a naive two-effect version reads the
  // OLD start time in that same first render, sees an elapsed time far past
  // GAUGE_TWEEN_MS (turns are seconds apart), and clamps straight to the
  // new target with no visible animation. Doing the reset synchronously
  // here means the render that detects the change also sees the fresh
  // start time, so progress genuinely begins near 0.
  const [tweenTarget, setTweenTarget] = useState(targetCells);
  const [tweenFrom, setTweenFrom] = useState(targetCells);
  const [tweenStart, setTweenStart] = useState(0);
  const progress = tweenStart
    ? Math.min(1, Math.max(0, (Date.now() - tweenStart) / GAUGE_TWEEN_MS))
    : 1;
  const animatedNow = tween(tweenFrom, tweenTarget, progress);
  if (targetCells !== tweenTarget) {
    if (motion) {
      // Restart from wherever the bar visually sits right now, so a new
      // target arriving mid-tween doesn't jump back to the old settled value.
      setTweenFrom(animatedNow);
      setTweenStart(Date.now());
    } else {
      // Motion off: snap immediately, no animation.
      setTweenFrom(targetCells);
      setTweenStart(0);
    }
    setTweenTarget(targetCells);
  }
  // progress is a monotonic function of the real clock, so it always reaches
  // 1 and stays there — tweening flips false for good once it does, and
  // useMotion tears its interval down the moment `active` goes false.
  const tweening = motion && progress < 1;
  // Return value intentionally unused: this call is kept purely for its
  // repaint side effect (the internal setTick forces a re-render every
  // GAUGE_TWEEN_STEP_MS while tweening, which is what advances `progress`
  // above), not for a tick value we read. Do not delete it as dead code —
  // doing so silently stops the bar from ever re-rendering mid-tween.
  useMotion(tweening, GAUGE_TWEEN_STEP_MS);
  const animCells = tweening ? animatedNow : null;
  const ctx = (ctxUsed != null && ctxTotal != null)
    ? formatGauge(ctxUsed, ctxTotal, animCells) : '--';
  const indicator = streamingIndicator(streaming, blinkOn, theme, { motion, tick, elapsedMs });
  const prov = provider || '?';
  const mdl = model || '?';
  // Live rate segment only while actually streaming with a started clock —
  // an idle/finished turn has no meaningful "chars this turn" sample.
  const hudRow = hud ? formatHudRow(hud, streaming && streamStartedAt
    ? { chars: liveChars || 0, elapsedMs } : null) : '';
  return React.createElement(
    Box,
    { flexShrink: 0, flexDirection: 'column', paddingX: 1 },
    React.createElement(Text, null, `${indicator}  ${prov} · ${mdl}  ctx ${ctx}`),
    hudRow ? React.createElement(Text, null, theme.dim(hudRow)) : null,
  );
}
