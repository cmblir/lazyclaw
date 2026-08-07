// tests/f-clear-splash-repaint.test.mjs — /clear must repaint the splash on
// the actual modelled screen, not merely bump an internal counter.
//
// Gap this closes: tests/f-clear-splash-persist.test.mjs only asserts that
// onConversationReset increments state.generation; tests/f-new-clear.test.mjs
// only asserts that the clear-screen+scrollback escape (CLEAR_TERMINAL) was
// written. Neither test replays the byte stream through a screen model, so
// neither would catch a regression where the generation counter increments
// and the clear escape fires correctly, yet the splash never actually
// reappears on screen (Ink's <Static/> is write-once: it only emits items
// beyond however many it already printed, so if the <Static/> element is not
// remounted — i.e. not re-keyed by generation — resetting React state back
// to [splash] prints nothing, and the user is left staring at a blank frame
// with a live status bar and editor and no splash above it).
//
// This test mounts the real ReplApp over a faked TTY (tests/helpers/
// repl_harness.mjs) and replays every byte it emits through the VT100 screen
// model (tests/helpers/vt_screen.mjs), so it asserts on what a user would
// actually see, not on internal state or raw escape sequences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScreen, countLines, plainText } from './helpers/vt_screen.mjs';
import { mountRepl } from './helpers/repl_harness.mjs';
import { CLEAR_TERMINAL } from '../tui/repl_reset.mjs';

const splashProps = {
  provider: 'claude-cli', model: 'claude-opus-5', version: '6.9.3',
  cwd: '/tmp/proj', tools: [], skills: [],
};

// "Welcome to pompos." is emitted verbatim by every splash tier (wide,
// medium, narrow) that a 100-column mount renders under — confirmed by
// reading tui/splash.mjs (renderWide:168, renderMedium:252, renderNarrow:335)
// and by grepping the repo: it appears nowhere else in tui/*.mjs, so a count
// of 1 unambiguously means "the splash is on screen" and not a coincidental
// substring of conversation text.
const SPLASH_MARKER = 'Welcome to pompos.';
const PRIOR_TURN = 'PRIOR_TURN_TEXT_BEFORE_CLEAR';

// Build a screen snapshot from everything the harness has emitted so far.
// `h.bytes` only ever grows, so calling this repeatedly at different points
// in the scenario gives an honest before/after comparison.
function snapshot(h, opts = {}) {
  const screen = makeScreen({ rows: opts.rows || 40, columns: opts.columns || 100 });
  for (const chunk of h.bytes) screen.write(chunk);
  return screen;
}

test('/clear repaints the splash on the modelled screen and drops the prior turn', async () => {
  const h = mountRepl({
    splashProps,
    // Mimic cli.mjs's Ink slash handler: /clear returns the reset sentinel.
    onSlashCommand: async (line) => (line === '/clear' ? 'NEW' : 'ok\n'),
  });
  try {
    await h.settle();

    // ── Precondition: the splash is on screen right after mount. ──────────
    let screen = snapshot(h);
    assert.equal(countLines(screen, SPLASH_MARKER), 1,
      `precondition: splash marker must be on screen at startup:\n${plainText(screen)}`);

    // ── Submit a normal turn so there is a conversation to clear. ─────────
    h.type(PRIOR_TURN);
    await h.settle(40);
    h.type('\r');
    await h.settle(80);
    screen = snapshot(h);
    assert.equal(countLines(screen, PRIOR_TURN), 1,
      `precondition: the prior turn must be visible before /clear:\n${plainText(screen)}`);

    // ── Run /clear. ────────────────────────────────────────────────────────
    h.type('/clear');
    await h.settle(40);
    h.type('\r');

    // Poll for the clear-screen+scrollback escape (async: onSlashCommand
    // resolves, then clearTerminalScreen writes it) before asserting on the
    // rendered result, mirroring tests/f-new-clear.test.mjs's polling style.
    let cleared = false;
    for (let i = 0; i < 40; i++) {
      await h.settle(25);
      if (h.bytes.join('').includes(CLEAR_TERMINAL)) { cleared = true; break; }
    }
    assert.equal(cleared, true, 'precondition: /clear must emit the clear-terminal escape');
    // Let the post-reset render (Static remount under the new generation key)
    // settle before reading the screen.
    await h.settle(120);

    // ── The actual claim under test. ───────────────────────────────────────
    screen = snapshot(h);
    assert.equal(countLines(screen, SPLASH_MARKER), 1,
      `/clear must repaint the splash on screen, not leave it blank:\n${plainText(screen)}`);
    assert.equal(countLines(screen, PRIOR_TURN), 0,
      `/clear must drop the prior turn from the screen:\n${plainText(screen)}`);
  } finally {
    h.unmount();
  }
});
