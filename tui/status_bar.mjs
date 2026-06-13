// tui/status_bar.mjs — the sticky single/double status row above the chat
// input. Row 1: streaming indicator · provider · model · ctx gauge. Row 2
// (only when the HUD is enabled): real-time usage, cost, trainer, orchestrator.
// Extracted from repl.mjs so the HUD can grow without pushing repl.mjs over the
// file-size ratchet.

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.mjs';
import { formatHudRow, formatGauge } from './hud.mjs';

export function StatusBar({ provider, model, streaming, ctxUsed, ctxTotal, hud }) {
  // Numbers are computed upstream (chat-history budget, not provider self-report);
  // formatGauge only changes the RENDERING — adds percent + bar + warn marker.
  const ctx = (ctxUsed != null && ctxTotal != null) ? formatGauge(ctxUsed, ctxTotal) : '--';
  const indicator = streaming ? theme.accent('● streaming') : theme.dim('○ idle');
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
