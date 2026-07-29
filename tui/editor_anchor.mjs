// tui/editor_anchor.mjs — extracted IME cursor-anchor stdout shim (v5.4.4).
// Pure leaf module: only touches process.stdout, imports nothing from
// editor.mjs, so there is no circular import. The shared anchorState object
// is a singleton — editor.mjs imports the same instance via this export.
//
// ─── IME cursor anchor (v5.4.4) ─────────────────────────────────────
//
// v5.4.3 shipped an anchor that moved the cursor inside the editor
// after every render so IME pre-edit composition appeared in the
// editor box. It also caused visible flicker because Ink's log-update
// (node_modules/ink/build/log-update.js) emits an eraseLines sequence
// (`\x1b[2K\x1b[1A...`) on every redraw — and that sequence walks UP
// from the CURRENT cursor position. With our anchor up inside the
// editor, eraseLines erased rows ABOVE the frame, then wrote the new
// frame starting one editor-height higher than the previous one.
//
// v5.4.4 fix — monkey-patch process.stdout.write the first time the
// anchor fires. When the patched writer sees one of Ink's own frame
// chunks AND the anchor offset is non-zero, it prepends
// `\x1b[<offset>B\r` to move the cursor BACK DOWN to the row
// log-update expects (one below the previous frame's last line). The
// user sees no flicker; IME still reads the editor cursor position
// because the anchor lives across the gap between renders.
//
// ─── Stray writes (v6.9.x) ──────────────────────────────────────────
//
// That compensation is not enough on its own. A write that reaches the
// terminal WITHOUT Ink's knowledge and ends a line moves the cursor to
// another row, and no cursor arithmetic here can repair Ink's line
// accounting afterwards — the next eraseLines starts N rows too low
// and leaves N stale rows on screen. Such chunks are handed to Ink
// instead (see ./stray_writes.mjs), which erases the live frame, lets
// the text land in the scrollback above it, and repaints below.
//
// process.stderr is patched the same way: in a real terminal it lands
// on the same screen, and background loop/cron code logs there.
import { hasInkWriter, isInkWriting, redirectThroughInk, shouldRedirect } from './stray_writes.mjs';

export const anchorState = { offset: 0, shimmed: false, writing: false };

// Consume the parked offset and return the escape that moves the cursor back
// down to the row log-update expects, or '' when nothing is parked.
function takeUndo() {
  const off = anchorState.offset;
  if (!(off > 0)) return '';
  anchorState.offset = 0;
  return `\x1b[${off}B\r`;
}

function patchStream(name) {
  const stream = process[name];
  if (!(stream && typeof stream.write === 'function')) return false;
  const orig = stream.write.bind(stream);
  stream.write = function patchedWrite(chunk, ...rest) {
    try {
      // 1. The anchor's own cursor move IS the displacement — never undo it.
      if (anchorState.writing) return orig.call(this, chunk, ...rest);
      // 2. Ink's own frame traffic: restore the baseline the anchor moved away
      //    from, then let the frame through untouched.
      if (isInkWriting()) {
        if (typeof chunk === 'string') {
          const undo = takeUndo();
          if (undo) return orig.call(this, undo + chunk, ...rest);
        }
        return orig.call(this, chunk, ...rest);
      }
      // 3. A foreign write while the REPL is mounted. Classify BEFORE touching
      //    the anchor offset: a chunk Ink will not take must leave the offset
      //    pending, or the cursor sits outside the frame for a render cycle.
      if (hasInkWriter() && shouldRedirect(chunk)) {
        // Ink's writeToStdout erases from the cursor's CURRENT row, so restore
        // the baseline first. If the redirect is refused after all (Ink already
        // unmounted), the chunk falls through to `orig` and lands on that same
        // baseline, so the undo is still the right thing to have written.
        const undo = takeUndo();
        if (undo) orig.call(this, undo);
        if (redirectThroughInk(chunk)) {
          // The chunk never reached `orig`, so honour a write callback here or a
          // caller awaiting drain would hang. Node's writable.write(chunk, cb)
          // contract is that cb fires asynchronously — calling it inline would
          // hand a caller that writes again from cb surprise reentrancy.
          const done = rest.find((arg) => typeof arg === 'function');
          if (done) process.nextTick(done);
          return true;
        }
      }
    } catch { /* fall through to unmodified write */ }
    return orig.call(this, chunk, ...rest);
  };
  return true;
}

export function installAnchorShim() {
  if (anchorState.shimmed) return;
  if (!patchStream('stdout')) return;
  patchStream('stderr');
  anchorState.shimmed = true;
}
