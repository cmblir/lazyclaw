// tests/helpers/vt_screen.mjs — a minimal VT100 screen model.
//
// Ink draws by moving the cursor and erasing lines, so asserting on the raw
// byte stream tells you nothing about what the user sees. This replays a byte
// stream into a grid of lines so a test can assert "the status row appears
// exactly once on screen".
//
// Deliberately partial: it implements only the sequences lazyclaw + Ink emit.
// Anything else is consumed and ignored rather than printed as literal text.
//
// Known simplification: the grid grows without bound instead of scrolling when
// it passes `rows`. Ink's own tall-frame branch (outputHeight >= stdout.rows)
// emits clearTerminal, which this model does handle, but a repro that depends
// on the terminal's scroll region moving content upward would NOT be modelled
// faithfully here. `rows` is carried so callers can size the mount to match.

export function makeScreen({ rows = 40, columns = 100 } = {}) {
  let grid = [''];
  let row = 0;
  let col = 0;

  const ensureRow = (r) => { while (grid.length <= r) grid.push(''); };
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

  function put(text) {
    ensureRow(row);
    const line = pad(grid[row], col);
    grid[row] = line.slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  }

  function newline() { row += 1; col = 0; ensureRow(row); }

  function write(chunk) {
    const s = String(chunk);
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i));
        if (!m) { i += 1; continue; }           // lone ESC / unsupported: drop
        const [seq, rawArgs, fin] = m;
        const n = parseInt(rawArgs, 10);
        const count = Number.isFinite(n) ? n : 1;
        if (fin === 'A') row = Math.max(0, row - count);
        else if (fin === 'B') { row += count; ensureRow(row); }
        else if (fin === 'G') col = Math.max(0, count - 1);
        else if (fin === 'C') col += count;
        else if (fin === 'D') col = Math.max(0, col - count);
        else if (fin === 'H') { row = 0; col = 0; }
        else if (fin === 'K') { ensureRow(row); grid[row] = rawArgs === '2' ? '' : grid[row].slice(0, col); }
        else if (fin === 'J') {
          if (rawArgs === '2' || rawArgs === '3') { grid = ['']; row = 0; col = 0; }
          else { grid = grid.slice(0, row + 1); }   // erase from cursor down
        }
        // every other final byte (m, h, l, …) is a no-op for the screen model
        i += seq.length;
        continue;
      }
      if (ch === '\n') { newline(); i += 1; continue; }
      if (ch === '\r') { col = 0; i += 1; continue; }
      // Run of printable characters up to the next control byte.
      let j = i;
      while (j < s.length && s[j] !== '\x1b' && s[j] !== '\n' && s[j] !== '\r') j += 1;
      put(s.slice(i, j));
      i = j;
    }
  }

  function lines() {
    const out = grid.map((l) => l.replace(/\s+$/, ''));
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  return {
    write,
    lines,
    text: () => lines().join('\n'),
    get rows() { return rows; },
    get columns() { return columns; },
  };
}

// Count how many rendered lines contain `needle` (after stripping SGR codes).
export function countLines(screen, needle) {
  return plainLines(screen).filter((l) => l.includes(needle)).length;
}

// The screen as plain text lines, with SGR colour codes stripped — what the
// user actually reads. Used by the assertions and by the failure dumps.
export function plainLines(screen) {
  // eslint-disable-next-line no-control-regex
  return screen.lines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, ''));
}

export function plainText(screen) {
  return plainLines(screen).join('\n');
}
