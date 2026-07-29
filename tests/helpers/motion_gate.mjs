// tests/helpers/motion_gate.mjs — force the motion/colour gate open for a
// mounted animation test, and guarantee every patched global is restored.
//
// Why this exists: tui/motion.mjs's motionEnabled() reads process.stdout.isTTY
// via its default parameter — the REAL global stream, not whatever private
// fake stream ink-testing-library hands a mounted instance — and process.stdout
// is not a TTY under `node --test` (piped output), so any mounted animation
// (StatusBar's elapsed clock / gauge tween, the Editor's error-border flash,
// and future motion-gated components) sees the no-motion path by default.
// Every test that mounts a real animated component and needs it actually
// animating has to force this gate open for the duration of the mount.
//
// It also forces chalk.level: chalk's own supports-color detection runs once,
// at the first import of any module that touches it (tui/theme.mjs sets
// `chalk.level = 0` at import time whenever colorEnabled() is false then,
// which is the case in this process under `node --test`), and that level
// then applies to every later chalk.hex(...)(...) call regardless of any
// process.stdout.isTTY patch made afterward. Ink's own border/text colouring
// (node_modules/ink's colorize.js) calls chalk.hex on the SAME chalk
// singleton, so a mounted test that asserts on rendered ANSI colour needs
// chalk.level forced too, or the colour never reaches the frame at all.
//
// And LAZYCLAW_NO_CURSOR_ANCHOR: forcing process.stdout.isTTY also opens the
// gate on the unrelated IME cursor-anchor effect in tui/editor.mjs, which —
// unlike motionEnabled() — installs a PERMANENT monkey-patch on the real
// process.stdout.write the first time it fires (tui/editor_anchor.mjs's
// anchorState.shimmed never resets itself outside of tests/helpers/
// repl_harness.mjs's own mount/restore cycle). Any test that mounts a
// component containing <Editor/> under a forced TTY must keep this off, or
// the shim leaks into every later test in the same process.
//
// LEAK WARNING: every one of these is a mutation of a process-wide global
// (process.stdout, process.env, the chalk singleton). If a test body throws
// and the caller does not go through withMotionForced's `finally`, or if a
// caller hand-rolls a partial copy of this instead of reusing it, a patched
// value can silently corrupt every later test in the same `node --test`
// process. Always call through withMotionForced; never patch these directly.
import chalk from 'chalk';

export async function withMotionForced(fn) {
  const saved = {
    isTTY: process.stdout.isTTY,
    noColor: process.env.NO_COLOR,
    term: process.env.TERM,
    noMotion: process.env.LAZYCLAW_NO_MOTION,
    noAnchor: process.env.LAZYCLAW_NO_CURSOR_ANCHOR,
    chalkLevel: chalk.level,
  };
  try {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    delete process.env.LAZYCLAW_NO_MOTION;
    process.env.LAZYCLAW_NO_CURSOR_ANCHOR = '1';
    chalk.level = 3;
    return await fn();
  } finally {
    process.stdout.isTTY = saved.isTTY;
    if (saved.noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.noColor;
    if (saved.term === undefined) delete process.env.TERM; else process.env.TERM = saved.term;
    if (saved.noMotion === undefined) delete process.env.LAZYCLAW_NO_MOTION; else process.env.LAZYCLAW_NO_MOTION = saved.noMotion;
    if (saved.noAnchor === undefined) delete process.env.LAZYCLAW_NO_CURSOR_ANCHOR; else process.env.LAZYCLAW_NO_CURSOR_ANCHOR = saved.noAnchor;
    chalk.level = saved.chalkLevel;
  }
}
