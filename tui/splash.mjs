// tui/splash.mjs — Hermes-style hero splash with gradient wordmark,
// subcommand catalog, tool registry, skill index, and a bottom status bar.
//
// Layout (terminal-width responsive across four tiers):
//
//   WIDE     (cols >= 140) — full wordmark + panel + sloth + 2-col right side
//   MEDIUM   ( 90 <= cols < 140) — compact headline, panel + sloth + wrapped right column
//   NARROW   ( 60 <= cols <  90) — single column, no sloth/panel, truncated verb lists
//   MINIMAL  (cols <  60)  — headline + provider + cwd + /help line only
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';
import { banner } from './banner.generated.mjs';
import { wordmark } from './wordmark.mjs';

const LMARGIN = '  ';
const TITLE = ' trainer-split · FTS5 recall · 6-backend sandbox ';

// Tier breakpoints. Wordmark is 120 cols wide + LMARGIN(2)*2 = 124 minimum;
// the user constraint pins WIDE at >=140 to give comfortable slack. Below
// 90 the sloth (48 cols) leaves <40 cols for the right column, so we drop
// it and go single-column. Below 60 we emit only a minimal headline.
const WORDMARK_BREAKPOINT = 140;  // drop wordmark below this
const PANEL_BREAKPOINT    = 90;   // drop sloth+panel below this
const MINIMAL_BREAKPOINT  = 60;   // drop everything but headline below this

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

// Wrap a labeled verb list onto multiple rows when it would overflow maxWidth.
// First row: '<label.padEnd(12)> verb · verb'; continuations: '             verb · verb'.
function wrapVerbs(label, verbs, maxWidth) {
  const pad = ' '.repeat(13); // label.padEnd(12) + ' ' = 13 cells
  const rows = [];
  let current = label.padEnd(12) + ' ';
  let firstOnRow = true;
  for (const v of verbs) {
    const candidate = firstOnRow ? current + v : current + ' · ' + v;
    if (stringWidth(candidate) > maxWidth) {
      if (firstOnRow) {
        // even a single verb overflows — emit it anyway (truncated) to make progress.
        rows.push(fit(candidate, maxWidth).trimEnd());
        current = pad;
        firstOnRow = true;
      } else {
        rows.push(current.trimEnd());
        current = pad + v;
        firstOnRow = false;
      }
    } else {
      current = candidate;
      firstOnRow = false;
    }
  }
  if (current.trim()) rows.push(current.trimEnd());
  return rows;
}

// Crush-style truncation for NARROW tier — take first N verbs, append '…' if more.
function truncateRow(label, verbs, maxWidth, take = 3) {
  const head = label.padEnd(12) + ' ';
  const tail = verbs.slice(0, take).join(' · ');
  let line = head + tail;
  if (verbs.length > take) line += ' …';
  if (stringWidth(line) <= maxWidth) return line;
  return fit(line, maxWidth).trimEnd();
}

// Wide tier — original v5.0.9 layout, kept verbatim.
function renderWide(props, cols) {
  const PANEL_W = cols - LMARGIN.length * 2;
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

  // 3) right column content
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

  // 5) status bar (Hermes-style separator)
  const sep = '─'.repeat(PANEL_W);
  lines.push(LMARGIN + sep);
  const ctx = props.ctxUsed != null && props.ctxTotal != null
    ? `[${'░'.repeat(20)}] ${props.ctxUsed}/${props.ctxTotal}`
    : `[${'░'.repeat(20)}] --`;
  lines.push(`${LMARGIN} ${provider} · ${model} | ctx -- | ${ctx} | 0s`);
  lines.push(LMARGIN + sep);

  return lines;
}

// Medium tier — no wordmark, compact panel title, sloth + wrapped right column.
function renderMedium(props, cols) {
  const PANEL_W = cols - LMARGIN.length * 2;
  const INNER = PANEL_W - 4;
  const SLOTH_W = banner.width;
  const RIGHT_W = Math.max(20, INNER - SLOTH_W - 2);

  const lines = [];

  // 1) compact headline (no wordmark)
  lines.push(`${LMARGIN}lazyclaw ${props.version || ''}`.trimEnd());
  lines.push('');

  // 2) compact panel top — drop the TITLE chain, just version
  const versionLabel = ` lazyclaw ${props.version || ''} `;
  const dashLeft = '─'.repeat(4);
  const dashRight = '─'.repeat(Math.max(2, PANEL_W - 2 - dashLeft.length - stringWidth(versionLabel)));
  lines.push(`${LMARGIN}╭${dashLeft}${versionLabel}${dashRight}╮`);

  // 3) build right column with wrapping
  const { tools = [], skills = [] } = props;
  const right = [];
  right.push('Subcommands');
  for (const [label, verbs] of SUBCOMMAND_GROUPS) {
    for (const r of wrapVerbs(label, verbs, RIGHT_W)) right.push(r);
  }
  right.push('');
  right.push('Available Tools');
  for (const t of tools.slice(0, 14)) {
    const label = t.sensitive ? `${t.category}*` : t.category;
    for (const r of wrapVerbs(label, t.verbs.slice(0, 6), RIGHT_W)) right.push(r);
  }
  if (tools.length > 14) right.push(`(and ${tools.length - 14} more...)`);
  right.push('');
  right.push('Available Skills');
  if (skills.length === 0) right.push('(none installed)');
  else {
    for (const s of skills.slice(0, 8)) {
      for (const r of wrapVerbs(s.group, s.names.slice(0, 6), RIGHT_W)) right.push(r);
    }
    if (skills.length > 8) right.push(`(and ${skills.length - 8} more skill groups...)`);
  }
  right.push('');
  const subcmdCount = SUBCOMMAND_GROUPS.reduce((n, [, v]) => n + v.length, 0);
  const summary = `${subcmdCount} subcommands · ${tools.length} tool groups · ${skills.length} skills · /help`;
  if (stringWidth(summary) > RIGHT_W) {
    right.push(`${subcmdCount} subcmds · ${tools.length} tools · ${skills.length} skills`);
    right.push('/help for commands');
  } else {
    right.push(summary);
  }

  const sloth = banner.rows.slice();
  while (sloth.length < right.length) sloth.push(' '.repeat(SLOTH_W));
  while (right.length < sloth.length) right.push('');

  for (let i = 0; i < sloth.length; i++) {
    const l = sloth[i] || ' '.repeat(SLOTH_W);
    // pad (no ellipsis) — wrapVerbs already guarantees width <= RIGHT_W
    const raw = right[i] || '';
    const r = raw + ' '.repeat(Math.max(0, RIGHT_W - stringWidth(raw)));
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

  // 5) status bar
  const sep = '─'.repeat(PANEL_W);
  lines.push(LMARGIN + sep);
  const ctx = props.ctxUsed != null && props.ctxTotal != null
    ? `[${'░'.repeat(20)}] ${props.ctxUsed}/${props.ctxTotal}`
    : `[${'░'.repeat(20)}] --`;
  lines.push(`${LMARGIN} ${provider} · ${model} | ctx -- | ${ctx} | 0s`);
  lines.push(LMARGIN + sep);

  return lines;
}

// Narrow tier — single column, no sloth, no panel, truncated verb lists.
function renderNarrow(props, cols) {
  const W = cols - LMARGIN.length * 2;
  const lines = [];

  // 1) headline
  lines.push(`${LMARGIN}lazyclaw ${props.version || ''}`.trimEnd());
  lines.push('');

  const { tools = [], skills = [], provider, model, trainer = {}, sessionId, cwd } = props;

  // 2) subcommands
  lines.push(`${LMARGIN}Subcommands`);
  for (const [label, verbs] of SUBCOMMAND_GROUPS) {
    lines.push(LMARGIN + truncateRow(label, verbs, W));
  }
  lines.push('');

  // 3) tools
  lines.push(`${LMARGIN}Available Tools`);
  for (const t of tools.slice(0, 14)) {
    const label = t.sensitive ? `${t.category}*` : t.category;
    lines.push(LMARGIN + truncateRow(label, t.verbs, W));
  }
  if (tools.length > 14) lines.push(`${LMARGIN}(and ${tools.length - 14} more...)`);
  lines.push('');

  // 4) skills
  lines.push(`${LMARGIN}Available Skills`);
  if (skills.length === 0) lines.push(`${LMARGIN}(none installed)`);
  else {
    for (const s of skills.slice(0, 8)) {
      lines.push(LMARGIN + truncateRow(s.group, s.names, W));
    }
    if (skills.length > 8) lines.push(`${LMARGIN}(and ${skills.length - 8} more skill groups...)`);
  }
  lines.push('');

  // 5) provider / session info
  const tProv = trainer.provider || provider;
  const tModel = trainer.model || model;
  lines.push(fit(`${LMARGIN}${provider} · ${model}  ·  trainer ${tProv} · ${tModel}`, cols).trimEnd());
  lines.push(fit(`${LMARGIN}${shortCwd(cwd || process.cwd())}`, cols).trimEnd());
  if (sessionId) lines.push(fit(`${LMARGIN}Session: ${sessionId}`, cols).trimEnd());
  lines.push('');
  lines.push(fit(`${LMARGIN}Welcome to lazyclaw. /help for commands.`, cols).trimEnd());
  lines.push('');

  // 6) compact status — single line, no separator dashes
  const ctx = props.ctxUsed != null && props.ctxTotal != null
    ? `${props.ctxUsed}/${props.ctxTotal}`
    : '--';
  lines.push(fit(`${LMARGIN}${provider} · ${model} · ctx ${ctx}`, cols).trimEnd());

  return lines;
}

// Minimal tier — bare-bones fallback for cols < 60.
function renderMinimal(props) {
  const { version, provider, model, sessionId, cwd } = props;
  const lines = [];
  lines.push(`lazyclaw ${version || ''}`.trimEnd());
  lines.push(`${provider} · ${model}`);
  lines.push(shortCwd(cwd || process.cwd()));
  if (sessionId) lines.push(`Session: ${sessionId}`);
  lines.push('/help for commands');
  return lines;
}

export function renderSplashToString(props, opts = {}) {
  const cols = opts.columns || process.stdout.columns || 100;
  let lines;
  if (cols < MINIMAL_BREAKPOINT) lines = renderMinimal(props);
  else if (cols < PANEL_BREAKPOINT) lines = renderNarrow(props, cols);
  else if (cols < WORDMARK_BREAKPOINT) lines = renderMedium(props, cols);
  else lines = renderWide(props, cols);
  return lines.join('\n');
}

export function Splash(props) {
  const cols = process.stdout.columns || 100;
  const out = renderSplashToString(props, { columns: cols });
  const lines = out.split('\n');
  const palette = wordmark.palette;
  const gradient = wordmark.gradient;
  const showWordmark = cols >= WORDMARK_BREAKPOINT;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    lines.map((line, i) => {
      let color;
      if (showWordmark && i < wordmark.height) color = palette[gradient[i] ?? 1];
      else if (showWordmark && i < wordmark.height + 1 + 1 + banner.height) color = theme.fg;
      return React.createElement(Text, { key: i, color }, line);
    })
  );
}
