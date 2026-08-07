// tui/splash_intro.mjs — the launch animation: the splash reveals top-to-
// bottom, then the POMPOS wordmark's gradient sweeps once, then the screen
// is cleared and Ink mounts and draws the settled splash.
//
// Why before Ink and not inside it: on the primary buffer the splash is
// rendered through Ink's <Static>, which is write-once — a component there
// paints one frame and never repaints. Animating it would mean rendering a
// live splash and swapping it for a static copy mid-flight, i.e. exactly the
// erase/cursor desync class that produced the stale-row bug. Owning the screen
// outright for ~1.15s and then handing Ink a cleared screen is strictly
// simpler and has no interaction with Ink's bookkeeping at all.

import { renderSplashToString, WORDMARK_BREAKPOINT } from './splash.mjs';
import { wordmark } from './wordmark.mjs';
import { motionEnabled, revealRows, shimmerIndex } from './motion.mjs';

export const REVEAL_MS = 350;
export const SHIMMER_MS = 800;
export const FPS = 30;
// Visible screen only — deliberately NOT \x1b[3J. That extra final would wipe
// the terminal's SCROLLBACK buffer, i.e. everything the user was doing in this
// terminal before they typed `pompos`, on every single chat launch. Nobody
// asked the intro to do that. Overpainting the visible screen is enough to hand
// Ink a clean canvas, and prior output stays recoverable by scrolling up.
// (`/clear` keeps its own 3J — see tui/repl_reset.mjs — because there the user
// explicitly asked for the scrollback to go.)
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function _paintWordmarkRow(row, paletteIdx) {
  return `\x1b[38;2;${_hexToRgb(wordmark.palette[paletteIdx]).join(';')}m${row}\x1b[0m`;
}

function _hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// The whole animation as a list of screen bodies. Pure, so the frame sequence
// is testable without a terminal or a clock.
export function introFrames(splashText, { revealMs = REVEAL_MS, shimmerMs = SHIMMER_MS, fps = FPS, columns = 100 } = {}) {
  const rows = String(splashText).split('\n');
  const step = Math.max(1, Math.round(1000 / fps));
  const frames = [];

  // Phase 1 — reveal. Each frame is a strict prefix of the settled splash.
  for (let t = step; t <= revealMs; t += step) {
    const n = revealRows(t, rows.length, revealMs);
    if (n <= 0) continue;
    frames.push(rows.slice(0, n).join('\n'));
  }
  if (frames.length === 0 || frames[frames.length - 1].split('\n').length < rows.length) {
    frames.push(rows.join('\n'));
  }

  // Phase 2 — shimmer. Only the wordmark band (the first wordmark.height rows,
  // and only when the WIDE tier actually drew it) is recoloured per frame. On
  // narrower tiers the wordmark never renders, so there is nothing to animate
  // — hand straight over after the reveal instead of holding the settled
  // frame for the shimmer beat (that hold used to burn ~800ms of dead air on
  // every non-wide terminal for zero visual change).
  const hasWordmark = columns >= WORDMARK_BREAKPOINT && rows.length > wordmark.height;
  if (shimmerMs > 0 && hasWordmark) {
    const steps = Math.max(1, Math.round(shimmerMs / step));
    for (let i = 0; i < steps; i++) {
      const painted = rows.map((row, r) =>
        r < wordmark.height ? _paintWordmarkRow(row, shimmerIndex(r, i, wordmark.palette.length)) : row);
      frames.push(painted.join('\n'));
    }
  }
  return frames;
}

export async function playSplashIntro(splashProps, deps = {}) {
  const env = deps.env || process.env;
  const stream = deps.stream || process.stdout;
  if (!motionEnabled(env, stream)) return false;
  const write = deps.write || ((s) => { try { stream.write(s); } catch { /* stdout closed */ } });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const columns = deps.columns || stream.columns || 100;

  const splashText = renderSplashToString(splashProps, { columns });
  const frames = introFrames(splashText, { columns });
  const step = Math.max(1, Math.round(1000 / FPS));

  write(HIDE_CURSOR + CLEAR);
  try {
    for (const frame of frames) {
      write(HOME + frame);
      await sleep(step);
    }
  } finally {
    // Hand Ink a clean screen — it re-draws the settled splash via <Static>.
    // Runs on every exit path (including a throw mid-loop) so a failure never
    // leaves the user with an invisible cursor on a half-painted screen.
    write(SHOW_CURSOR + CLEAR);
  }
  return true;
}
