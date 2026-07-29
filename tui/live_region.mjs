// tui/live_region.mjs — the REPL's live region: the partial assistant stream
// that grows between chunks and is committed to scrollback on turn completion.
// Extracted from tui/repl.mjs (file-size gate); both layout arms render it.
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.mjs';

/**
 * @param {{text: string}} props partial assistant output; renders nothing when empty
 */
export function LiveRegion({ text }) {
  if (!text) return null;
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { color: theme.fg }, text),
  );
}
