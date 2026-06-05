// tui/splash.mjs — two-column launch splash (spec §5.1).
//
// Public surface:
//   - <Splash {...props} />            ink component for live REPL mount
//   - renderSplashToString(props)      pure string builder used by tests
//                                       and by the non-TTY path.
//
// Layout: 24-cell sloth gutter (cols 0-23) | 2-cell separator (24-25)
//   | 52-cell right column (cols 26-77) | 2-cell right padding.
// Footer: exactly 4 lines, blank row separates body from footer.
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';
import { banner } from './banner.generated.mjs';

const RIGHT_COL_WIDTH = 52;
const GUTTER_WIDTH = 24;

function fit(text, max) {
  if (stringWidth(text) <= max) return text.padEnd(max);
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stringWidth(text.slice(0, mid) + '…') <= max) lo = mid;
    else hi = mid - 1;
  }
  return (text.slice(0, lo) + '…').padEnd(max);
}

function shortCwd(cwd) {
  const home = process.env.HOME || '';
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

function toolRow({ category, sensitive, verbs }) {
  const label = sensitive ? `(sensitive) ${category}` : category;
  const labelWidth = sensitive ? 20 : 9;
  const tail = verbs.slice(0, 6).join(' · ');
  const more = verbs.length > 6 ? ` (${verbs.length - 6} more)` : '';
  return `${fit(label, labelWidth)}${tail}${more}`;
}

function skillRow({ group, names }) {
  const tail = names.slice(0, 6).join(' · ');
  const more = names.length > 6 ? ` (${names.length - 6} more)` : '';
  return `${fit(group, 9)}${tail}${more}`;
}

function buildBody(props) {
  const { tools = [], skills = [] } = props;
  const right = [];
  right.push('Available Tools');
  right.push('─'.repeat(45));
  for (const t of tools.slice(0, 8)) right.push(toolRow(t));
  if (tools.length > 8) right.push(`... and ${tools.length - 8} more tool groups`);
  right.push('');
  right.push('Available Skills');
  right.push('─'.repeat(45));
  for (const s of skills.slice(0, 8)) right.push(skillRow(s));
  if (skills.length > 8) right.push(`... and ${skills.length - 8} more skill groups`);

  const left = banner.rows.slice();
  while (left.length < right.length) left.push('');
  while (right.length < left.length) right.push('');

  const lines = [];
  for (let i = 0; i < left.length; i++) {
    const lhs = fit(left[i], GUTTER_WIDTH);
    const rhs = fit(right[i], RIGHT_COL_WIDTH);
    lines.push(`  ${lhs}  ${rhs}`);
  }
  return lines;
}

function buildFooter(props) {
  const { provider, model, trainer = {}, sessionId, cwd } = props;
  const tProv = trainer.provider || provider;
  const tModel = trainer.model || model;
  const sid = (sessionId || '').slice(0, 8);
  const cwdShort = shortCwd(cwd || process.cwd());
  return [
    fit(`  provider · ${provider} · ${model}`, 56) + fit(`cwd · ${cwdShort}`, 22),
    fit(`  trainer  · ${tProv} · ${tModel}  session ${sid}`, 78),
    fit('  slash    · /help · /model · /trainer · /skills · /tools · /exit', 78),
    fit('  hint     · Shift+Enter newline · Ctrl-R recall · Esc interrupt', 78),
  ];
}

export function renderSplashToString(props, { columns = 80 } = {}) {
  void columns; // currently fixed-width at 80; <72 fallback is in cli.mjs
  const body = buildBody(props);
  const footer = buildFooter(props);
  return [...body, '', ...footer].join('\n');
}

export function Splash(props) {
  const lines = renderSplashToString(props).split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    lines.map((line, i) =>
      React.createElement(Text, { key: i, color: i < banner.height ? theme.fg : undefined }, line)
    )
  );
}
