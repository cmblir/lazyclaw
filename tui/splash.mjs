// tui/splash.mjs — hero-banner launch splash.
//
// Public surface:
//   - <Splash {...props} />            ink component for live REPL mount
//   - renderSplashToString(props)      pure string builder used by tests
//                                       and by the non-TTY path.
//
// Layout: 47-cell-wide hero banner centered in 80-col terminal,
// followed by a two-column tools|skills section (36 cells each)
// and a 4-line footer.
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';
import { banner } from './banner.generated.mjs';

const TERM_WIDTH = 80;
const COL_WIDTH = 36; // 2 (lpad) + 36 + 2 (mid) + 36 + 2 (rpad) = 78 ≈ 80 with slack

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

function buildBanner() {
  // Center the hero banner inside TERM_WIDTH. banner.width may be < TERM_WIDTH;
  // pad each side equally so it floats over the centerline.
  const pad = Math.max(0, Math.floor((TERM_WIDTH - banner.width) / 2));
  return banner.rows.map(row => ' '.repeat(pad) + row);
}

function buildToolsAndSkills(props) {
  const { tools = [], skills = [] } = props;
  const SECT_WIDTH = TERM_WIDTH - 4;
  const lines = [];
  lines.push(`  ${fit('Available Tools', SECT_WIDTH)}`);
  lines.push(`  ${'─'.repeat(SECT_WIDTH)}`);
  for (const t of tools.slice(0, 8)) lines.push(`  ${fit(toolRow(t), SECT_WIDTH)}`);
  if (tools.length > 8) lines.push(`  ${fit(`... and ${tools.length - 8} more tool groups`, SECT_WIDTH)}`);
  lines.push('');
  lines.push(`  ${fit('Available Skills', SECT_WIDTH)}`);
  lines.push(`  ${'─'.repeat(SECT_WIDTH)}`);
  for (const s of skills.slice(0, 8)) lines.push(`  ${fit(skillRow(s), SECT_WIDTH)}`);
  if (skills.length > 8) lines.push(`  ${fit(`... and ${skills.length - 8} more skill groups`, SECT_WIDTH)}`);
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
  void columns; // splash is fixed-width 80
  return [
    ...buildBanner(),
    '',
    ...buildToolsAndSkills(props),
    '',
    ...buildFooter(props),
  ].join('\n');
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
