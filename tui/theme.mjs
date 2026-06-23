// tui/theme.mjs — single source of truth for lazyclaw v5 color tokens.
// The amber hex is also stamped into tui/banner.generated.mjs so the
// sloth gutter and the prompt accent stay visually paired.
//
// v5.5: added `border` token for the chat-input frame (Claude-CLI-style
// rounded box around the editor). Kept subtly grayer than `amber` so the
// frame doesn't compete with the accent `›` or the sloth gutter.
import chalk from 'chalk';

const AMBER_HEX = '#FFB347';
const BORDER_HEX = '#5A5A5A';
const GREEN_HEX = '#34D399'; // emerald — "live/working" (matches the dashboard ring)

// Central color gate. Color is OFF when the NO_COLOR standard applies
// (https://no-color.org — any non-empty NO_COLOR), the terminal is `dumb`,
// or the target stream isn't a TTY (piped / screen-reader / CI). Evaluated
// per call so tests and runtime env changes are honored without re-importing.
// `stream` defaults to stdout; tests pass a fake `{ isTTY }` to probe the
// gate without mutating the real process streams. chalk self-detects the same
// conditions (level 0), so its tokens degrade automatically; this gate is for
// callers that emit raw ANSI.
export function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  if (!stream || !stream.isTTY) return false;
  return true;
}

// Wrap `str` in a raw SGR escape (`\x1b[<code>m … \x1b[0m`) when color is on,
// otherwise return it unchanged. Keeps inline-ANSI call sites accessible
// without each one re-implementing the NO_COLOR check.
export function paint(code, str) {
  if (!colorEnabled()) return str;
  return `\x1b[${code}m${str}\x1b[0m`;
}

// Align chalk's own level with our gate so theme tokens (amber/dim/accent)
// and raw-ANSI emitters agree under NO_COLOR / dumb / non-TTY. chalk reads
// this at import; our gate stays the runtime source of truth for raw ANSI.
if (!colorEnabled()) chalk.level = 0;

function amber(text) {
  return chalk.hex(AMBER_HEX)(text);
}

function dim(text) {
  return chalk.dim(text);
}

function accent(text) {
  return chalk.bold.hex(AMBER_HEX)(text);
}

function success(text) {
  return chalk.bold.hex(GREEN_HEX)(text);
}

function muted(text) {
  return chalk.gray(text);
}

function plain(text) {
  return text;
}

export const theme = {
  amber: AMBER_HEX,
  fg: AMBER_HEX,
  border: BORDER_HEX,
  colorize: amber,
  dim,
  accent,
  success,
  muted,
  plain,
};

// Compatibility: some callers want the colorizer when reading `theme.amber`.
// Keep the hex on the property for builders, and expose `colorize` for runtime use.
