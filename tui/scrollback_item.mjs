// tui/scrollback_item.mjs — extracted from tui/repl.mjs to reclaim room under
// the file-size ratchet (scripts/lint-file-size.mjs). Re-exported from
// tui/repl.mjs so existing importers keep working unchanged.

import React from 'react';
import { Box, Text } from 'ink';
import { Splash } from './splash.mjs';
import { theme } from './theme.mjs';

// ScrollbackItem renders each scrollback child. Splash renders via the real
// <Splash/> component (preserves gradient wordmark colorization); everything
// else is plain Text.
//
// Wrapped in React.memo: scrollback item objects are stable across renders,
// so when only the editor buffer changes (every keystroke) the memo skips
// re-rendering every committed line. Without this the whole alt-buffer
// scrollback re-rendered on each keypress — the source of the typing flicker.
export const ScrollbackItem = React.memo(function ScrollbackItem({ item }) {
  if (item.kind === 'splash') {
    return React.createElement(Splash, item.splashProps);
  }
  if (item.kind === 'user') {
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, theme.accent('› ') + item.text)
    );
  }
  if (item.kind === 'error') {
    return React.createElement(Text, { color: 'red' }, item.text);
  }
  // 'assistant' (default)
  return React.createElement(Text, { color: theme.fg }, item.text);
});
