// tui/splash.mjs — Hermes-style hero splash with gradient wordmark,
// subcommand catalog, tool registry, skill index, and a bottom status bar.
//
// Layout (terminal-width responsive across four tiers):
//
//   WIDE     (cols >= 140) — full wordmark + panel + sloth side-by-side
//   MEDIUM   ( 90 <= cols < 140) — compact headline, sloth side-by-side, wrapped right column
//   NARROW   ( 45 <= cols <  90) — sloth STACKED above full-width panel, wrapped verbs
//   MINIMAL  (cols <  45)  — headline + provider + cwd + /help line only
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
// 90 the sloth (48 cols) cannot share a row with a usable right column,
// so NARROW stacks the sloth ABOVE a full-width wrapped panel. Below 45
// even a stacked sloth overflows, so MINIMAL absorbs that range.
export const WORDMARK_BREAKPOINT = 140;  // drop wordmark below this
const MEDIUM_BREAKPOINT   = 90;   // side-by-side sloth+panel above this; stacked below
const NARROW_BREAKPOINT   = 45;   // headline-only fallback below this

// Subcommand catalog — grouped for the splash so a new user sees the surface
// area at a glance. Single source of truth lives in the react-free
// tui/subcommands.mjs so the in-chat /menu palette can share it.
export { SUBCOMMAND_GROUPS } from './subcommands.mjs';
import { SUBCOMMAND_GROUPS } from './subcommands.mjs';

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

// Provider-aware splash tip. The $0 "learning loop" pitch only applies when
// the trainer runs on claude-cli (Claude Pro/Max subscription is keyless and
// free); for any other provider the loop costs API tokens, so showing the
// Claude pitch is misleading. The trainer provider wins because the pitch is
// about the learning loop, not the chat provider (see splash info line).
export function pickSplashTip({ provider, trainer = {} } = {}) {
  const trainerProvider = trainer.provider || provider;
  if (trainerProvider === 'claude-cli') {
    return 'Tip: trainer learns from your Claude Pro subscription at $0.';
  }
  return 'Tip: /help lists every command, tool, and skill.';
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
  lines.push(`${LMARGIN}+ ${pickSplashTip({ provider, trainer })}`);
  // v5.4.3 — the baked-in status row that used to live here duplicated
  // ReplApp's real <StatusBar/> (tui/repl.mjs:476). Removing it cuts 4
  // rows from the splash AND eliminates the visible overlap the user
  // saw on /help in alt-buffer mode.

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
  lines.push(`${LMARGIN}+ ${pickSplashTip({ provider, trainer })}`);
  // v5.4.3 — baked-in status row removed; ReplApp renders the real one.

  return lines;
}

// Narrow tier — sloth STACKED above a full-width panel; verb lists wrap
// onto multiple rows instead of being truncated. Used for 45 <= cols < 90.
function renderNarrow(props, cols) {
  const PANEL_W = cols - LMARGIN.length * 2;
  const INNER = PANEL_W - 4;
  const SLOTH_W = banner.width;
  const lines = [];

  // 1) sloth banner CENTERED above panel (stacked layout).
  //    Only emit if the sloth itself fits within the terminal; otherwise
  //    skip it (MINIMAL absorbs the truly tiny case below NARROW_BREAKPOINT).
  if (cols >= SLOTH_W + LMARGIN.length * 2) {
    const leftPad = ' '.repeat(Math.max(0, Math.floor((cols - SLOTH_W) / 2)));
    for (const r of banner.rows) lines.push(leftPad + r);
    lines.push('');
  }

  // 2) compact headline (no wordmark — too wide).
  lines.push(`${LMARGIN}lazyclaw ${props.version || ''}`.trimEnd());
  lines.push('');

  // 3) panel top — version label only, dashes fill remainder.
  const versionLabel = ` lazyclaw ${props.version || ''} `;
  const dashLeft = '─'.repeat(2);
  const dashRight = '─'.repeat(Math.max(2, PANEL_W - 2 - dashLeft.length - stringWidth(versionLabel)));
  lines.push(`${LMARGIN}╭${dashLeft}${versionLabel}${dashRight}╮`);

  // 4) panel body — full-width single column, wrapped via wrapVerbs.
  const { tools = [], skills = [] } = props;
  const body = [];
  body.push('Subcommands');
  for (const [label, verbs] of SUBCOMMAND_GROUPS) {
    for (const r of wrapVerbs(label, verbs, INNER)) body.push(r);
  }
  body.push('');
  body.push('Available Tools');
  for (const t of tools.slice(0, 14)) {
    const label = t.sensitive ? `${t.category}*` : t.category;
    for (const r of wrapVerbs(label, t.verbs.slice(0, 6), INNER)) body.push(r);
  }
  if (tools.length > 14) body.push(`(and ${tools.length - 14} more...)`);
  body.push('');
  body.push('Available Skills');
  if (skills.length === 0) body.push('(none installed)');
  else {
    for (const s of skills.slice(0, 8)) {
      for (const r of wrapVerbs(s.group, s.names.slice(0, 6), INNER)) body.push(r);
    }
    if (skills.length > 8) body.push(`(and ${skills.length - 8} more skill groups...)`);
  }
  body.push('');
  const subcmdCount = SUBCOMMAND_GROUPS.reduce((n, [, v]) => n + v.length, 0);
  const summary = `${subcmdCount} subcmds · ${tools.length} tools · ${skills.length} skills · /help`;
  if (stringWidth(summary) > INNER) {
    body.push(`${subcmdCount} subcmds · ${tools.length} tools · ${skills.length} skills`);
    body.push('/help for commands');
  } else {
    body.push(summary);
  }

  // 5) emit panel rows (single column, full INNER width, pad with spaces).
  for (const row of body) {
    const padded = row + ' '.repeat(Math.max(0, INNER - stringWidth(row)));
    lines.push(`${LMARGIN}│ ${padded} │`);
  }
  lines.push(`${LMARGIN}╰${'─'.repeat(PANEL_W - 2)}╯`);
  lines.push('');

  // 6) provider / session info (single line each, fit-truncated for safety).
  const { provider, model, trainer = {}, sessionId, cwd } = props;
  const tProv = trainer.provider || provider;
  const tModel = trainer.model || model;
  lines.push(fit(`${LMARGIN}${provider} · ${model}  ·  trainer ${tProv} · ${tModel}`, cols).trimEnd());
  lines.push(fit(`${LMARGIN}${shortCwd(cwd || process.cwd())}`, cols).trimEnd());
  if (sessionId) lines.push(fit(`${LMARGIN}Session: ${sessionId}`, cols).trimEnd());
  lines.push('');
  lines.push(fit(`${LMARGIN}Welcome to lazyclaw. /help for commands.`, cols).trimEnd());
  // v5.4.3 — baked-in status row removed; ReplApp renders the real one.

  return lines;
}

// Minimal tier — bare-bones fallback for cols < 45.
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
  if (cols < NARROW_BREAKPOINT) lines = renderMinimal(props);
  else if (cols < MEDIUM_BREAKPOINT) lines = renderNarrow(props, cols);
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
  // Sloth banner is emitted at the TOP of NARROW output (45..89) only when
  // it fits inside the terminal width — see renderNarrow() guard.
  const showSlothNarrow =
    cols >= NARROW_BREAKPOINT && cols < MEDIUM_BREAKPOINT &&
    cols >= banner.width + LMARGIN.length * 2;

  // Per-tier sloth row range [start, end). MEDIUM interleaves the sloth
  // inside panel rows, so it gets colored via the border regex below — no
  // dedicated band is needed for that tier.
  let slothStart = -1, slothEnd = -1;
  if (showWordmark) {
    slothStart = wordmark.height + 1 + 1; // wordmark + blank + panel-top
    slothEnd   = slothStart + banner.height;
  } else if (showSlothNarrow) {
    slothStart = 0; // sloth is the first thing emitted
    slothEnd   = banner.height;
  }

  // Section headers / summary / compact headline on NARROW that should be
  // amber to match the WIDE wordmark accent. Matched by exact content.
  const ACCENT_HEADERS = new Set(['Subcommands', 'Available Tools', 'Available Skills']);
  // Panel border / status separator glyphs (leading box-drawing after
  // optional whitespace). Catches ╭ ╰ │ as well as ─ separators.
  const BORDER_RE = /^\s*[╭╰│├┤┬┴┼─╮╯]/;
  // NARROW compact headline (e.g. "  lazyclaw 5.3.0").
  const HEADLINE_RE = /^\s*lazyclaw\s+\S/;
  // NARROW summary line ("N subcmds · M tools · K skills · /help" or its
  // wrapped variant). Also catches "/help for commands".
  const SUMMARY_RE = /(subcmds\s+·|tools\s+·\s+\d+\s+skills|\/help\s+for\s+commands)/;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    lines.map((line, i) => {
      let color;
      const trimmed = line.trim();
      if (showWordmark && i < wordmark.height) {
        color = palette[gradient[i] ?? 1]; // wordmark gradient
      } else if (i >= slothStart && i < slothEnd) {
        color = theme.fg; // sloth band — any tier that stacks the sloth
      } else if (BORDER_RE.test(line)) {
        color = theme.fg; // panel borders + status separators
      } else if (ACCENT_HEADERS.has(trimmed)) {
        color = theme.fg; // section headers
      } else if (!showWordmark && HEADLINE_RE.test(line) && /\d/.test(line)) {
        color = theme.fg; // narrow/medium compact headline ("lazyclaw 5.x.y")
      } else if (!showWordmark && SUMMARY_RE.test(line)) {
        color = theme.fg; // narrow/medium summary line
      }
      return React.createElement(Text, { key: i, color }, line);
    })
  );
}
