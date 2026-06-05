// tui/splash.mjs — Hermes-style hero splash.
//
// Layout (terminal-width responsive):
//
//   ██╗      █████╗ ...   ← wordmark (top, single-tone orange)
//   ...
//
//   ╭───── lazyclaw vX.Y.Z · trainer-split + FTS5 recall ─────────────╮
//   │  [sloth braille]      Available Tools                            │
//   │                        fs   read · write · ...                   │
//   │                       Available Skills                           │
//   │                       N tools · M skills · /help for commands    │
//   ╰──────────────────────────────────────────────────────────────────╯
//
//   provider · X · Y    trainer · A · B
//   /Users/o/cwd
//   Session: 20260605_180543_2e0351
//
//   Welcome to lazyclaw. Type your message or /help for commands.
//   + Tip: ...
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';
import { banner } from './banner.generated.mjs';
import { wordmark } from './wordmark.mjs';

const LMARGIN = '  ';
const TITLE = ' trainer-split · FTS5 recall · 6-backend sandbox ';

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
  const label = sensitive ? `${category}*` : category;
  const tail = verbs.slice(0, 6).join(' · ');
  return `${label.padEnd(12)} ${tail}`;
}

function skillRow({ group, names }) {
  const tail = names.slice(0, 6).join(' · ');
  return `${group.padEnd(12)} ${tail}`;
}

export function renderSplashToString(props, opts = {}) {
  const cols = opts.columns || process.stdout.columns || 100;
  const TERM = Math.max(80, cols);
  const PANEL_W = TERM - LMARGIN.length * 2;
  const INNER = PANEL_W - 4;             // 2 border + 2 padding
  const SLOTH_W = banner.width;
  const RIGHT_W = Math.max(40, INNER - SLOTH_W - 2);

  const lines = [];

  // Wordmark
  for (const r of wordmark.rows) lines.push(LMARGIN + r);
  lines.push('');

  // Panel top with title
  const versionLabel = ` lazyclaw ${props.version || ''} ·${TITLE} `;
  const dashLeft = '─'.repeat(8);
  const dashRight = '─'.repeat(Math.max(2, PANEL_W - 2 - dashLeft.length - stringWidth(versionLabel)));
  lines.push(`${LMARGIN}╭${dashLeft}${versionLabel}${dashRight}╮`);

  // Right column content
  const { tools = [], skills = [] } = props;
  const right = [];
  right.push('Available Tools');
  for (const t of tools.slice(0, 8)) right.push(toolRow(t));
  if (tools.length > 8) right.push(`(and ${tools.length - 8} more tool groups...)`);
  right.push('');
  right.push('Available Skills');
  for (const s of skills.slice(0, 8)) right.push(skillRow(s));
  if (skills.length > 8) right.push(`(and ${skills.length - 8} more skill groups...)`);
  right.push('');
  right.push(`${tools.length} tools · ${skills.length} skills · /help for commands`);

  const sloth = banner.rows.slice();
  while (sloth.length < right.length) sloth.push(' '.repeat(SLOTH_W));
  while (right.length < sloth.length) right.push('');

  for (let i = 0; i < sloth.length; i++) {
    const l = sloth[i] || ' '.repeat(SLOTH_W);
    const r = fit(right[i] || '', RIGHT_W);
    lines.push(`${LMARGIN}│ ${l}  ${r} │`);
  }
  lines.push(`${LMARGIN}╰${'─'.repeat(PANEL_W - 2)}╯`);
  lines.push('');

  // Provider / session info
  const { provider, model, trainer = {}, sessionId, cwd } = props;
  const tProv = trainer.provider || provider;
  const tModel = trainer.model || model;
  lines.push(`${LMARGIN}${provider} · ${model}  ·  trainer ${tProv} · ${tModel}`);
  lines.push(`${LMARGIN}${shortCwd(cwd || process.cwd())}`);
  if (sessionId) lines.push(`${LMARGIN}Session: ${sessionId}`);
  lines.push('');
  lines.push(`${LMARGIN}Welcome to lazyclaw. Type your message or /help for commands.`);
  lines.push(`${LMARGIN}+ Tip: trainer learns from your Claude Pro subscription at $0.`);

  return lines.join('\n');
}

export function Splash(props) {
  const lines = renderSplashToString(props).split('\n');
  // Color the wordmark and sloth rows; everything else stays default.
  const heroRowCount = wordmark.height + 1 + 1 + banner.height + 1; // word + blank + top + sloth + bottom
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    lines.map((line, i) =>
      React.createElement(Text, { key: i, color: i < heroRowCount ? theme.fg : undefined }, line)
    )
  );
}
