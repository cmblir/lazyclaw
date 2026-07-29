// tests/f-repl-no-stale-rows.test.mjs — the primary-buffer REPL must never
// leave orphaned status rows or editor borders on screen.
//
// Symptom: two or three copies of `○ idle  <provider> · <model>  ctx --`, plus
// an orphaned editor top border, pile up ABOVE the live frame.
//
// Mechanism (proved by the byte log this harness captures, see the repro
// tests below): Ink erases by walking the cursor UP previousLineCount rows
// from wherever the cursor currently is (node_modules/ink/build/log-update.js),
// and tui/editor.mjs deliberately parks the cursor up inside the editor box
// after every commit so a Hangul/CJK IME draws its pre-edit overlay at the
// caret. tui/editor_anchor.mjs compensates for that parked offset ONLY for
// chunks that begin with `\x1b[2K` (Ink's eraseLines). Any other write reaching
// the terminal while the offset is pending is passed through un-compensated: it
// lands at the parked cursor and, if it ends in a newline, leaves the cursor one
// row below where the anchor left it. The next Ink redraw then moves down by the
// recorded offset from the WRONG row, so eraseLines starts one row too low and
// the top row of the previous frame — the status row — is never erased.
//
// Asserting on Ink's raw byte stream says nothing about what the user sees, so
// every assertion here replays the captured stream through tests/helpers/
// vt_screen.mjs and counts rows on the modelled screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScreen, countLines, plainLines, plainText } from './helpers/vt_screen.mjs';
import { mountRepl } from './helpers/repl_harness.mjs';

const splashProps = {
  provider: 'claude-cli', model: 'claude-opus-5', version: '6.9.3',
  cwd: '/tmp/proj', tools: [], skills: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The editor box is the only border drawn at column 0; the splash panel's box
// is indented, so a bare '╭' count would always be 2.
const editorTopBorders = (screen) => plainLines(screen).filter((l) => l.startsWith('╭')).length;

// ─── 1. The screen simulator itself ────────────────────────────────────────
// These run first so a broken simulator can never be mistaken for a broken REPL.

// Verbatim `ansiEscapes.eraseLines(n)` — one `\x1b[2K` per line with a
// `\x1b[1A` between them and a trailing `\x1b[G`. Ink's previousLineCount is
// `(frame + '\n').split('\n').length`, i.e. one MORE than the frame's row
// count, because the trailing newline parks the cursor on the row below.
const ERASE_LINES = (n) => (n === 0 ? '' : Array.from({ length: n }, () => '\x1b[2K').join('\x1b[1A') + '\x1b[G');

test('vt_screen models cursor-up + erase-line the way Ink draws', () => {
  assert.equal(ERASE_LINES(0), '', 'eraseLines(0) is the empty string');
  assert.equal(ERASE_LINES(3), '\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G');

  const s = makeScreen();
  s.write('alpha\nbravo\n');
  assert.deepEqual(s.lines(), ['alpha', 'bravo']);
  // Ink redrawing a 2-row frame: previousLineCount is 3, so the erase walks up
  // over the blank row the trailing newline left AND both content rows.
  s.write(ERASE_LINES(3) + 'charlie\ndelta\n');
  assert.deepEqual(s.lines(), ['charlie', 'delta']);
});

test('vt_screen models the /clear sequence', () => {
  const s = makeScreen();
  s.write('old content\n');
  s.write('\x1b[2J\x1b[3J\x1b[H');
  assert.deepEqual(s.lines(), []);
  s.write('fresh\n');
  assert.deepEqual(s.lines(), ['fresh']);
});

test('vt_screen reproduces the artifact under test from first principles', () => {
  // A hand-built replay of the exact byte order the REPL produces, so the
  // simulator is shown to model the duplication before it is used to detect it.
  const s = makeScreen();
  s.write('STATUS\nEDITOR\n');              // Ink frame A; cursor parks on row 2
  s.write('\x1b[1A');                        // editor anchor parks 1 row up (offset=1)
  s.write('noise\n');                        // foreign write: no \x1b[2K prefix, so
                                             // editor_anchor's shim passes it through
                                             // un-compensated. Cursor: row 1 → row 2.
  s.write('\x1b[1B\r');                      // shim compensates on the NEXT Ink chunk,
                                             // but from row 2 → row 3, one too low.
  s.write(ERASE_LINES(3) + 'STATUS\nEDITOR\n');
  assert.deepEqual(
    s.lines(), ['STATUS', 'STATUS', 'EDITOR'],
    'the off-by-one erase must leave the previous frame’s top row on screen',
  );
});

// ─── 2. The REPL over a fake TTY ───────────────────────────────────────────

async function screenAfter(scenario, opts = {}) {
  const h = mountRepl(
    { splashProps, statusInfo: { provider: 'claude-cli', model: 'claude-opus-5' } },
    opts,
  );
  try {
    await h.settle();
    await scenario(h);
    await h.settle(120);
    const screen = makeScreen({ rows: opts.rows || 40, columns: opts.columns || 100 });
    for (const chunk of h.bytes) screen.write(chunk);
    return screen;
  } finally {
    h.unmount();
  }
}

// Only the last dozen rows matter for these assertions; the splash panel above
// them would bury the signal in a failure dump.
const tail = (screen) => plainText(screen).split('\n').slice(-12).join('\n');

test('typing leaves exactly one status row and one input box', async () => {
  const screen = await screenAfter(async (h) => {
    for (const ch of 'hello') { h.type(ch); await sleep(8); }
    await h.settle();
    for (const ch of ' world') { h.type(ch); await sleep(8); }
  });
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${tail(screen)}`);
  assert.equal(editorTopBorders(screen), 1, `editor border duplicated:\n${tail(screen)}`);
});

test('a bypass write that does not end a line leaves the screen intact', async () => {
  // The control that isolates the cause: the same un-shimmed write, minus the
  // newline. It still lands in the wrong place, but it does not move the cursor
  // to another ROW, so Ink's next erase starts where it expects and nothing
  // leaks. Whatever Task 6 does, this must stay green — the defect is the row
  // displacement, not the foreign write itself.
  const screen = await screenAfter(async (h) => {
    h.type('hi');
    await h.settle();
    process.stdout.write('no trailing newline');
    await h.settle();
    h.type('!');
  });
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${tail(screen)}`);
  assert.equal(editorTopBorders(screen), 1, `editor border duplicated:\n${tail(screen)}`);
});

test('a write that bypasses Ink leaves exactly one status row and one input box', async () => {
  const screen = await screenAfter(async (h) => {
    h.type('hi');
    await h.settle();
    // Precondition: the editor's IME anchor has parked the cursor up inside the
    // box and no Ink redraw has consumed that offset yet. This is the resting
    // state of the REPL between keystrokes — if it ever stops being true the
    // scenario below is no longer exercising the bug, so fail loudly.
    assert.ok(h.anchorOffset() > 0, 'precondition: a cursor-anchor offset must be pending');
    // commands/chat.mjs:279 hands the slash dispatcher exactly this callback,
    // and /dream, /loop, /task and /menu stream multi-line progress through it
    // while Ink owns the screen.
    process.stdout.write('gateway: running\n  pid: 1234\n');
    await h.settle();
    h.type('!');
  });
  // Two rows leak (one per newline), which is the user's screenshot verbatim:
  // a stale status row and an orphaned editor top border above the real ones.
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${tail(screen)}`);
  assert.equal(editorTopBorders(screen), 1, `editor border duplicated:\n${tail(screen)}`);
  // The row counts alone are also satisfied by an implementation that DROPS the
  // bypassing write, so pin that the text survives. Pre-fix it did not: the
  // handler's output printed at the parked cursor inside the editor box and the
  // next frame overwrote it, so the user never saw it either.
  assert.equal(countLines(screen, 'gateway: running'), 1,
    `the redirected write must be visible, not swallowed:\n${tail(screen)}`);
});

test('a redirected write reaches the screen, from stdout and from stderr', async () => {
  // Guards the failure mode the row counts cannot see. Ink's writeToStdout
  // returns having written nothing once isUnmounted is true, and the REPL's
  // deregistration runs in a React effect cleanup a macrotask later — so a
  // redirect that reports success without checking is a silent data loss bug.
  const screen = await screenAfter(async (h) => {
    h.type('hi');
    await h.settle();
    process.stdout.write('STRAY_ON_STDOUT\n');
    await h.settle();
    process.stderr.write('STRAY_ON_STDERR\n');
    await h.settle();
    h.type('!');
  });
  assert.equal(countLines(screen, 'STRAY_ON_STDOUT'), 1,
    `stdout write swallowed or duplicated:\n${tail(screen)}`);
  assert.equal(countLines(screen, 'STRAY_ON_STDERR'), 1,
    `stderr write swallowed or duplicated:\n${tail(screen)}`);
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${tail(screen)}`);
  assert.equal(editorTopBorders(screen), 1, `editor border duplicated:\n${tail(screen)}`);
});

test('every bypassing write adds another stale status row', async () => {
  // Why this exists: it pins the mechanism, not just the symptom. The user
  // reported "two or three copies"; N un-compensated line-ending writes leak
  // exactly N rows, which is what an off-by-N eraseLines start row predicts.
  const screen = await screenAfter(async (h) => {
    h.type('hi');
    await h.settle();
    for (const n of [1, 2, 3]) {
      process.stdout.write(`  ↻ loop iteration ${n}/3\n`);
      await h.settle();
      h.type('.');
      await h.settle();
    }
  });
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${tail(screen)}`);
});

test('a background write to stderr leaves exactly one status row', async () => {
  // Second writer, same root cause: process.stderr is not shimmed at all, so a
  // background loop/cron log line is never compensated. Kept separate from the
  // stdout case because a fix confined to process.stdout.write would leave it red.
  const screen = await screenAfter(async (h) => {
    h.type('hi');
    await h.settle();
    assert.ok(h.anchorOffset() > 0, 'precondition: a cursor-anchor offset must be pending');
    process.stderr.write('[loop] tick\n');
    await h.settle();
    h.type('!');
  });
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${tail(screen)}`);
  assert.equal(editorTopBorders(screen), 1, `editor border duplicated:\n${tail(screen)}`);
});
