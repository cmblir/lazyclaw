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
// anchor fires. When the patched writer sees a chunk that BEGINS with
// `\x1b[2K` (the start of log-update's eraseLines) AND the anchor
// offset is non-zero, it prepends `\x1b[<offset>B\r` to move the
// cursor BACK DOWN to the row log-update expects (one below the
// previous frame's last line). The user sees no flicker; IME still
// reads the editor cursor position because the anchor lives across
// the gap between renders.
export const anchorState = { offset: 0, shimmed: false };

export function installAnchorShim() {
  if (anchorState.shimmed) return;
  if (!(process.stdout && typeof process.stdout.write === 'function')) return;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = function patchedWrite(chunk, ...rest) {
    try {
      if (
        anchorState.offset > 0 &&
        typeof chunk === 'string' &&
        chunk.startsWith('\x1b[2K')
      ) {
        const off = anchorState.offset;
        anchorState.offset = 0;
        return orig.call(this, `\x1b[${off}B\r` + chunk, ...rest);
      }
    } catch { /* fall through to unmodified write */ }
    return orig.call(this, chunk, ...rest);
  };
  anchorState.shimmed = true;
}
