// tui/status_bar.mjs — the sticky single/double status row above the chat
// input. Row 1: streaming indicator · provider · model · ctx gauge. Row 2
// (only when the HUD is enabled): real-time usage, cost, trainer, orchestrator.
// Extracted from repl.mjs so the HUD can grow without pushing repl.mjs over the
// file-size ratchet.

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.mjs';
import { formatHudRow, formatGauge } from './hud.mjs';
import { spinnerFrame, SPINNER_MS, motionEnabled, formatElapsed, useMotion } from './motion.mjs';

// How fast the streaming dot pulses, in ms. Exported so it's not a magic number.
export const BLINK_MS = 450;

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

export function StatusBar({ provider, model, streaming, ctxUsed, ctxTotal, hud, streamStartedAt }) {
  const motion = motionEnabled();
  // One interval either way: the spinner ticks fast, the legacy pulse slow.
  const tick = useMotion(!!streaming, motion ? SPINNER_MS : BLINK_MS);
  const blinkOn = tick % 2 === 0;
  const elapsedMs = streaming && streamStartedAt ? Date.now() - streamStartedAt : 0;

  // Numbers are computed upstream (chat-history budget, not provider self-report);
  // formatGauge only changes the RENDERING — adds percent + bar + warn marker.
  const ctx = (ctxUsed != null && ctxTotal != null) ? formatGauge(ctxUsed, ctxTotal) : '--';
  const indicator = streamingIndicator(streaming, blinkOn, theme, { motion, tick, elapsedMs });
  const prov = provider || '?';
  const mdl = model || '?';
  const hudRow = hud ? formatHudRow(hud) : '';
  return React.createElement(
    Box,
    { flexShrink: 0, flexDirection: 'column', paddingX: 1 },
    React.createElement(Text, null, `${indicator}  ${prov} · ${mdl}  ctx ${ctx}`),
    hudRow ? React.createElement(Text, null, theme.dim(hudRow)) : null,
  );
}
