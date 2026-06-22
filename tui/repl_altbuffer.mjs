// tui/repl_altbuffer.mjs — alt-buffer (DEC 1049) mount cluster for the REPL.
//
// Extracted verbatim from repl.mjs (file-size gate). Wraps the React tree
// with mount/unmount side-effects that enable the terminal alternate screen
// buffer. Three-layer cleanup so the user never gets stranded on the alt
// canvas:
//   1. React unmount → useEffect return-fn writes \x1b[?1049l
//   2. Rude shutdown (SIGINT/SIGTERM/SIGHUP/'exit') → same escape via
//      process-level listeners that we install + remove on unmount.
//   3. cursor-visible safety on unmount (\x1b[?25h) in case anything
//      below us turned it off.
//
// We deliberately do NOT install an uncaughtException handler — Ink
// already installs one and re-throws; ours would swallow the stack
// trace (violates §1 Truthfulness / no silent catch).
//
// `enabled` is false for non-TTY pipelines, CI, ink-testing-library, and
// the LAZYCLAW_NO_ALT escape hatch. When false this is a pass-through —
// no escape sequences leak into stdout.
import { useEffect } from 'react';

export const ALT_BUFFER_ENTER = '\x1b[?1049h';
export const ALT_BUFFER_LEAVE = '\x1b[?1049l';
export const CURSOR_VISIBLE   = '\x1b[?25h';

// Rendering-mode decision. Default = Static scrollback (no flicker; splash
// prints once + scrolls naturally). Alt-buffer fullscreen is opt-in via
// LAZYCLAW_ALT=1; LAZYCLAW_NO_ALT=1 forces it off. TTY-only either way.
export function computeAltEnabled(env, hasTTY) {
  const e = env || {};
  return !!hasTTY && !!e.LAZYCLAW_ALT && !e.LAZYCLAW_NO_ALT;
}

export function FullScreen({ enabled, children }) {
  useEffect(() => {
    if (!enabled) return undefined;
    // Mount: enter alternate screen buffer.
    try { process.stdout.write(ALT_BUFFER_ENTER); } catch { /* swallow — stdout closed */ }

    // Rude-shutdown listeners. Each writes 1049l + cursor-visible so the
    // terminal is restored even if React never gets a chance to unmount
    // (e.g. parent process kills us with SIGTERM).
    const restore = () => {
      try { process.stdout.write(ALT_BUFFER_LEAVE + CURSOR_VISIBLE); } catch {}
    };
    const onExit = () => { restore(); };
    const onSignal = () => { restore(); };
    process.once('exit', onExit);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);

    return () => {
      // React unmount: restore primary buffer.
      restore();
      process.removeListener('exit', onExit);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGHUP', onSignal);
    };
  }, [enabled]);
  return children;
}
