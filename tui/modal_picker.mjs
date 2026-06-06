// tui/modal_picker.mjs — v5.4.3 in-Ink modal picker.
//
// Used by /provider, /model, /personality (and any future overlay slash
// that needs a single-shot selection from a fixed list). Mounted as a
// flex sibling above <StatusBar/> when ReplApp's `modal` state is set;
// Editor intercepts keys (Up/Down/Enter/Esc/printable filter) and
// forwards them as host callbacks. The component itself is purely
// presentational + a pure scoring helper so it stays snapshot-testable.
//
// Picker resolves via Promise (ReplApp's openPicker(opts) returns one).
// Confirm → resolve(itemId). Cancel/Esc → resolve(null). Unmount during
// active picker → also resolve(null) so dispatcher promises never hang.

import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';
// Pure (react-free) primitives live in modal_filter.mjs so they can be unit
// tested without the Ink runtime. Re-exported here for back-compat with
// existing importers (tui/repl.mjs).
import { filterModalItems, _computeWindow, resolveModalPick } from './modal_filter.mjs';

export { filterModalItems, _computeWindow, resolveModalPick };

const DEFAULT_MAX_ROWS = 12;

// Presentational component.
//
// Props:
//   title:string         — top label (bold)
//   subtitle?:string     — second row (dim)
//   items:Array          — [{id, label, desc?, tag?}]
//   selectedIndex:number — host-owned selection cursor (in filtered list)
//   query:string         — host-owned filter buffer
//   searchable?:boolean  — show the filter row (default true)
//   maxRows?:number      — viewport height (default 12)
//   toast?:string        — transient one-line message below the list
//   columns?:number      — terminal width override (tests)
export function ModalPicker({
  title,
  subtitle,
  items,
  selectedIndex,
  query,
  searchable = true,
  maxRows = DEFAULT_MAX_ROWS,
  toast,
  columns,
}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const idx = Math.max(0, Math.min(total - 1, Number.isFinite(selectedIndex) ? selectedIndex : 0));
  const { start, end } = _computeWindow(idx, total, maxRows);
  const visible = list.slice(start, end);
  const cols = Number.isFinite(columns) ? columns : (process.stdout.columns || 80);

  // Label column width = longest visible label, capped at 36.
  const labelW = Math.min(36, Math.max(
    8,
    ...visible.map((it) => stringWidth(String(it.label || it.id || '')))
  ));

  const rows = [];

  // Title.
  rows.push(React.createElement(
    Text, { key: 'title', bold: true }, String(title || 'select')
  ));
  if (subtitle) {
    rows.push(React.createElement(
      Text, { key: 'sub', dimColor: true },
      String(subtitle)
    ));
  }
  // Filter row.
  if (searchable) {
    const q = String(query || '');
    const tail = total > 0 ? `${total} match${total === 1 ? '' : 'es'}` : 'no matches';
    rows.push(React.createElement(
      Text, { key: 'filter' },
      `${theme.accent ? theme.accent('› ') : '› '}${q}${q.length ? '' : ' '}  `,
      React.createElement(Text, { key: 'count', dimColor: true }, tail),
    ));
  }

  // Items.
  if (total === 0) {
    rows.push(React.createElement(
      Text, { key: 'empty', dimColor: true }, '  (no items)'
    ));
  } else {
    for (let i = 0; i < visible.length; i++) {
      const it = visible[i];
      const absoluteIdx = start + i;
      const selected = absoluteIdx === idx;
      const marker = selected ? '❯ ' : '  ';
      const label = String(it.label || it.id || '').padEnd(labelW);
      const desc = it.desc ? `  ${it.desc}` : '';
      // Render selected row inverse-bold for contrast. A row `tag` (e.g.
      // "api key" / "no key" / "custom") renders as a dim trailing pill so
      // the picker signals at a glance which providers need a key.
      rows.push(React.createElement(
        Text,
        { key: `it-${absoluteIdx}`, bold: selected, inverse: selected },
        `${marker}${label}${desc}`,
        it.tag
          ? React.createElement(Text, { key: 'tag', dimColor: true }, `  [${it.tag}]`)
          : null,
      ));
    }
    if (end < total) {
      rows.push(React.createElement(
        Text, { key: 'more', dimColor: true },
        `  … ${total - end} more (Down to scroll)`,
      ));
    }
  }
  if (toast) {
    rows.push(React.createElement(
      Text, { key: 'toast', color: 'yellow' }, toast,
    ));
  }
  // Footer.
  rows.push(React.createElement(
    Text, { key: 'help', dimColor: true },
    '  ↑/↓ move · Enter pick · Esc cancel · type to filter · Ctrl+U clear',
  ));

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.amber || theme.border || 'yellow',
      paddingX: 1,
      width: Math.min(cols, 100),
      flexShrink: 0,
    },
    rows,
  );
}
