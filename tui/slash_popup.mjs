// tui/slash_popup.mjs — Ink popup chooser for slash commands.
//
// Renders a bordered, vertically-stacked list of slash-command suggestions
// just above the input row. Selection state lives in the parent (ReplApp),
// because the Editor owns the keyboard. This component is purely
// presentational so it can be snapshotted and rendered without an Ink
// runtime.
//
// Ink has no absolute positioning, so "popup" here means "flex sibling
// rendered between the live region and the StatusBar". When the popup is
// visible the live region naturally shrinks by its row count, which is the
// same trick Claude CLI uses.
//
// Two exports:
//   - filterSlashCommands(buffer, commands)  → pure, unit-testable
//   - <SlashPopup buffer commands selectedIndex maxRows />  → presentational

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.mjs';
import { SLASH_COMMANDS as DEFAULT_SLASH_COMMANDS } from './slash_commands.mjs';

export { DEFAULT_SLASH_COMMANDS };

// ─── Pure filter ─────────────────────────────────────────────────────────
//
// Returns the subset of `commands` to show in the popup for the current
// `buffer`. Empty array means "dismiss popup". See the inline cases for
// the precedence — prefix first, then substring fallback, then space-arg
// degeneration into a single-row inline hint.
export function filterSlashCommands(buffer, commands) {
  if (!buffer || !buffer.startsWith('/')) return [];
  const space = buffer.indexOf(' ');
  if (space > 0) {
    // User has typed args. Popup degenerates into a one-row inline hint
    // showing only the matched command's help text.
    const head = buffer.slice(0, space);
    return commands.filter((c) => c.cmd === head);
  }
  if (buffer === '/') return commands.slice();
  const q = buffer.toLowerCase();
  const prefix = commands.filter((c) => c.cmd.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix;
  // Substring fallback: '/em' → /memory. Strip the leading '/' on both
  // sides so the substring search isn't dominated by the trigger char.
  const sub = commands.filter((c) =>
    c.cmd.slice(1).toLowerCase().includes(q.slice(1))
  );
  return sub;
}

// Truncate help text to a column budget, preserving the leading space.
// Never wraps — the popup is a single row per command.
function _truncate(s, max) {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

// Window a long match list around the selected row so the popup doesn't
// grow taller than `maxRows`. Returns `{ visible, windowStart }`.
export function _computeWindow(matches, selectedIndex, maxRows) {
  if (matches.length <= maxRows) return { visible: matches, windowStart: 0 };
  const half = Math.floor(maxRows / 2);
  let start = Math.max(0, selectedIndex - half);
  const end = Math.min(matches.length, start + maxRows);
  // Re-anchor if we overflowed past the end.
  start = Math.max(0, end - maxRows);
  return { visible: matches.slice(start, start + maxRows), windowStart: start };
}

// ─── Component ───────────────────────────────────────────────────────────
//
// Props:
//   buffer        — string, current editor buffer (used for the inline hint)
//   commands      — Array<{cmd,help}>, already filtered by caller
//   selectedIndex — number, index into `commands`
//   maxRows       — number, max visible rows (defaults to 8)
//   columns       — number, terminal width (defaults to process.stdout.columns)
//
// When `columns < 50` the popup collapses to a single column (cmd only).
export function SlashPopup({
  buffer = '',
  commands = [],
  selectedIndex = 0,
  maxRows = 8,
  columns,
  // When true, always render the selectable chooser (used by the arg popup,
  // whose buffer has a space — which would otherwise collapse a single
  // candidate into the non-selectable inline hint).
  forceChooser = false,
}) {
  if (!commands || commands.length === 0) return null;
  const cols = columns
    || (process.stdout && process.stdout.columns)
    || 80;
  const compact = cols < 50;
  const safeSelected = Math.max(0, Math.min(commands.length - 1, selectedIndex));
  const { visible, windowStart } = _computeWindow(commands, safeSelected, maxRows);

  // Inline-hint mode: buffer already has args + a single match. Render
  // the help text on one dimmed line. No border, no chooser.
  const isInlineHint = !forceChooser && buffer.includes(' ') && commands.length === 1;
  if (isInlineHint) {
    const c = commands[0];
    return React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { dimColor: true },
        `${c.cmd} — ${_truncate(c.help, Math.max(10, cols - c.cmd.length - 5))}`
      )
    );
  }

  // Reserve 2 chars border + 2 padding + cmd column (14) + 1 gap.
  const cmdCol = 14;
  const helpBudget = Math.max(0, cols - cmdCol - 6);

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
    },
    visible.map((c, i) => {
      const absIdx = i + windowStart;
      const isSel = absIdx === safeSelected;
      const cmdText = c.cmd.padEnd(cmdCol);
      return React.createElement(
        Box,
        { key: c.cmd },
        React.createElement(
          Text,
          {
            inverse: isSel,
            color: isSel ? theme.amber : undefined,
            bold: isSel,
          },
          cmdText
        ),
        !compact
          ? React.createElement(
              Text,
              { dimColor: true },
              ' ' + _truncate(c.help, helpBudget)
            )
          : null
      );
    }),
    commands.length > maxRows
      ? React.createElement(
          Text,
          { dimColor: true },
          `  ${safeSelected + 1}/${commands.length}`
        )
      : null
  );
}
