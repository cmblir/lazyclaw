// tui/theme.mjs — single source of truth for lazyclaw v5 color tokens.
// The amber hex is also stamped into tui/banner.generated.mjs so the
// sloth gutter and the prompt accent stay visually paired.
import chalk from 'chalk';

const AMBER_HEX = '#FFB347';

function amber(text) {
  return chalk.hex(AMBER_HEX)(text);
}

function dim(text) {
  return chalk.dim(text);
}

function accent(text) {
  return chalk.bold.hex(AMBER_HEX)(text);
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
  colorize: amber,
  dim,
  accent,
  muted,
  plain,
};

// Compatibility: some callers want the colorizer when reading `theme.amber`.
// Keep the hex on the property for builders, and expose `colorize` for runtime use.
