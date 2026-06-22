// LazyClaw banner renderers — extracted from tui/pickers.mjs as a leaf
// module (no cross-deps). Holds the legacy figlet box (_renderBanner), the
// orange colour helper (_orange / _ORANGE_RGB), the mascot stubs, and the
// lazy-loaded v5 banner assets (_loadBannerAssets). The v5 splash composer
// (_renderV5Banner) and the chat header (_printChatBanner) stay in pickers
// and import _orange / _ORANGE_RGB / _loadBannerAssets / _renderBanner back.

// LazyClaw banner — single source of truth (chat REPL header, no-arg
// launcher, first-run welcome). Printed once so users see the active
// provider/model; plain ANSI, auto-skipped when stdout isn't a TTY.
// Returns an array of pre-formatted lines the caller can splice rows into.
//
// Layout invariants: every inner row is forced through `.padEnd(INNER_W)`
// and is exactly INNER_W single-cell glyphs, so the right border `│` always
// lands in the same column. _renderMascot / _renderMascotTiny are stubs kept
// so any leftover caller doesn't crash.

export const _ORANGE_RGB = '241;130;70';  // #F18246
export function _orange(s) { return `\x1b[38;2;${_ORANGE_RGB}m${s}\x1b[0m`; }

export function _renderMascot() {
  return ['lazyclaw'];
}

export function _renderMascotTiny() {
  return 'lazyclaw';
}

// figlet "standard" "lazy", trimmed of leading blank line. Each row
// is left-padded by two spaces inside the box, and every row is then
// padded to INNER_W cells.
const _LAZY_STANDARD = [
  ' _                  ',
  '| | __ _ _____   _  ',
  '| |/ _` |_  / | | | ',
  '| | (_| |/ /| |_| | ',
  '|_|\\__,_/___|\\__, | ',
  '             |___/  ',
];

const _INNER_W = 32;  // 2 left pad + 20 letter art + caption headroom

export function _renderBanner(version) {
  const v = String(version || '?.?.?');
  const cap = `  LazyClaw  v${v}`;
  const padInner = (s) => '  ' + s.padEnd(_INNER_W - 2, ' ');
  const wrap = (inner) => _orange('│') + _orange(inner) + _orange('│');
  const top = _orange('╭' + '─'.repeat(_INNER_W) + '╮');
  const bot = _orange('╰' + '─'.repeat(_INNER_W) + '╯');
  return [
    top,
    ..._LAZY_STANDARD.map((row) => wrap(padInner(row))),
    wrap(padInner(cap)),
    bot,
  ];
}

// v5 hero banner assets — ANSI Shadow LAZYCLAW wordmark stacked on top of the
// braille sloth (tui/banner.generated.mjs + tui/wordmark.mjs). Lazy-loaded and
// cached so the missing-asset fallback only probes the dynamic import once.
let _bannerAssetsCache = null;
export async function _loadBannerAssets() {
  if (_bannerAssetsCache !== null) return _bannerAssetsCache;
  try {
    const { banner } = await import('./banner.generated.mjs');
    const { wordmark } = await import('./wordmark.mjs');
    _bannerAssetsCache = { banner, wordmark };
  } catch {
    _bannerAssetsCache = null;
  }
  return _bannerAssetsCache;
}
