// tui/splash.mjs — Hermes-style hero splash with gradient wordmark,
// subcommand catalog, tool registry, skill index, and a bottom status bar.
//
// Layout (terminal-width responsive):
//
//   LAZYCLAW wordmark (top, per-row gradient orange)
//
//   ╭─ lazyclaw vX.Y.Z · trainer-split · FTS5 recall · 6-backend sandbox ─╮
//   │  [sloth braille]   Subcommands                                       │
//   │                    core / workflow / config / state / ...            │
//   │                    Available Tools                                   │
//   │                    fs / exec / git / ...                             │
//   │                    Available Skills                                  │
//   │                    N subcommands · M tool groups · K skills · /help  │
//   ╰──────────────────────────────────────────────────────────────────────╯
//
//   provider · X · Y  ·  trainer · A · B
//   /cwd
//   Session: ...
//
//   Welcome to lazyclaw. Type your message or /help for commands.
//   + Tip: ...
//
//   ───────────────────────────────────────────────────────────────────────
//    provider · model | ctx -- | [progress] | 0s
//   ───────────────────────────────────────────────────────────────────────
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';
import { banner } from './banner.generated.mjs';
import { wordmark } from './wordmark.mjs';

const LMARGIN = '  ';
const TITLE = ' trainer-split · FTS5 recall · 6-backend sandbox ';

// Subcommand catalog — grouped for the splash so a new user sees the
// surface area at a glance. Mirrors SUBCOMMANDS in cli.mjs.
export const SUBCOMMAND_GROUPS = [
  ['core',     ['chat', 'agent', 'orchestrator', 'dashboard', 'menu']],
  ['workflow', ['run', 'resume', 'inspect', 'clear', 'validate', 'graph']],
  ['config',   ['config', 'auth', 'rates', 'providers', 'setup', 'onboard']],
  ['state',    ['sessions', 'skills', 'workspace', 'memory', 'status', 'doctor']],
  ['runtime',  ['daemon', 'cron', 'loop', 'loops', 'goal']],
  ['channels', ['slack', 'telegram', 'matrix', 'channels', 'message', 'pairing']],
  ['v5',       ['sandbox', 'personality', 'migrate', 'hermes', 'openclaw', 'trajectories']],
  ['utility',  ['browse', 'version', 'completion', 'help', 'export', 'import', 'nodes']],
];

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

function subcommandRow([label, verbs]) {
  return `${label.padEnd(12)} ${verbs.join(' · ')}`;
}

export function renderSplashToString(props, opts = {}) {
  const cols = opts.columns || process.stdout.columns || 100;
  const TERM = Math.max(80, cols);
  const PANEL_W = TERM - LMARGIN.length * 2;
  const INNER = PANEL_W - 4;
  const SLOTH_W = banner.width;
  const RIGHT_W = Math.max(40, INNER - SLOTH_W - 2);

  const lines = [];

  // 1) wordmark
  for (const r of wordmark.rows) lines.push(LMARGIN + r);
  lines.push('');

  // 2) panel top with inset title
  const versionLabel = ` lazyclaw ${props.version || ''} ·${TITLE} `;
  const dashLeft = '─'.repeat(8);
  const dashRight = '─'.repeat(Math.max(2, PANEL_W - 2 - dashLeft.length - stringWidth(versionLabel)));
  lines.push(`${LMARGIN}╭${dashLeft}${versionLabel}${dashRight}╮`);

  // 3) right column content (subcommands + tools + skills)
  const { tools = [], skills = [] } = props;
  const right = [];
  right.push('Subcommands');
  for (const g of SUBCOMMAND_GROUPS) right.push(subcommandRow(g));
  right.push('');
  right.push('Available Tools');
  for (const t of tools.slice(0, 14)) right.push(toolRow(t));
  if (tools.length > 14) right.push(`(and ${tools.length - 14} more...)`);
  right.push('');
  right.push('Available Skills');
  if (skills.length === 0) right.push('(none installed)');
  else {
    for (const s of skills.slice(0, 8)) right.push(skillRow(s));
    if (skills.length > 8) right.push(`(and ${skills.length - 8} more skill groups...)`);
  }
  right.push('');
  const subcmdCount = SUBCOMMAND_GROUPS.reduce((n, [, v]) => n + v.length, 0);
  right.push(`${subcmdCount} subcommands · ${tools.length} tool groups · ${skills.length} skills · /help for commands`);

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

  // 4) provider / session info
  const { provider, model, trainer = {}, sessionId, cwd } = props;
  const tProv = trainer.provider || provider;
  const tModel = trainer.model || model;
  lines.push(`${LMARGIN}${provider} · ${model}  ·  trainer ${tProv} · ${tModel}`);
  lines.push(`${LMARGIN}${shortCwd(cwd || process.cwd())}`);
  if (sessionId) lines.push(`${LMARGIN}Session: ${sessionId}`);
  lines.push('');
  lines.push(`${LMARGIN}Welcome to lazyclaw. Type your message or /help for commands.`);
  lines.push(`${LMARGIN}+ Tip: trainer learns from your Claude Pro subscription at $0.`);
  lines.push('');

  // 5) bottom border + status bar + border (Hermes-style separator)
  const sep = '─'.repeat(PANEL_W);
  lines.push(LMARGIN + sep);
  const ctx = props.ctxUsed != null && props.ctxTotal != null
    ? `[${'░'.repeat(20)}] ${props.ctxUsed}/${props.ctxTotal}`
    : `[${'░'.repeat(20)}] --`;
  lines.push(`${LMARGIN} ${provider} · ${model} | ctx -- | ${ctx} | 0s`);
  lines.push(LMARGIN + sep);

  return lines.join('\n');
}

export function Splash(props) {
  const cols = process.stdout.columns || 100;
  const TERM = Math.max(80, cols);
  const PANEL_W = TERM - LMARGIN.length * 2;
  const out = renderSplashToString(props, { columns: cols });
  const lines = out.split('\n');
  const palette = wordmark.palette;
  const gradient = wordmark.gradient;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    lines.map((line, i) => {
      let color;
      if (i < wordmark.height) color = palette[gradient[i] ?? 1];
      else if (i < wordmark.height + 1 + 1 + banner.height) color = theme.fg;  // panel + sloth tinted
      return React.createElement(Text, { key: i, color }, line);
    })
  );
}
