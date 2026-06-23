// tui/status_bar.mjs — the sticky single/double status row above the chat
// input. Row 1: streaming indicator · provider · model · ctx gauge. Row 2
// (only when the HUD is enabled): real-time usage, cost, trainer, orchestrator.
// Extracted from repl.mjs so the HUD can grow without pushing repl.mjs over the
// file-size ratchet.

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.mjs';
import { formatHudRow, formatGauge } from './hud.mjs';

// How fast the streaming dot pulses, in ms. Exported so it's not a magic number.
export const BLINK_MS = 450;

// The leading status glyph. While streaming, the dot pulses (bright ↔ dim) so
// there's a live "something is happening" signal; idle is a steady hollow dot.
// Pure (takes the current blink phase) so it's unit-testable without a timer.
export function streamingIndicator(streaming, blinkOn, t = theme) {
  if (!streaming) return t.dim('○ idle');
  // Pulse a GREEN dot while streaming (live/working), not the amber accent.
  return blinkOn ? t.success('● streaming') : t.dim('● streaming');
}

export function StatusBar({ provider, model, streaming, ctxUsed, ctxTotal, hud }) {
  // Pulse the streaming dot. The interval only runs while streaming and is torn
  // down as soon as the turn ends (or the bar unmounts).
  const [blinkOn, setBlinkOn] = useState(true);
  useEffect(() => {
    if (!streaming) { setBlinkOn(true); return undefined; }
    const id = setInterval(() => setBlinkOn((b) => !b), BLINK_MS);
    return () => clearInterval(id);
  }, [streaming]);

  // Numbers are computed upstream (chat-history budget, not provider self-report);
  // formatGauge only changes the RENDERING — adds percent + bar + warn marker.
  const ctx = (ctxUsed != null && ctxTotal != null) ? formatGauge(ctxUsed, ctxTotal) : '--';
  const indicator = streamingIndicator(streaming, blinkOn);
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
