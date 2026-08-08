// tests/f-splash-intro.test.mjs — the launch animation. It runs BEFORE Ink
// mounts, on a screen it owns outright, then clears and hands over — so it
// cannot desync Ink's erase bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { introFrames, playSplashIntro, REVEAL_MS, SHIMMER_MS } from '../tui/splash_intro.mjs';
import { wordmark } from '../tui/wordmark.mjs';

const splashText = ['row-a', 'row-b', 'row-c', 'row-d'].join('\n');

test('the reveal grows from empty to the full splash', () => {
  const frames = introFrames(splashText, { revealMs: 200, shimmerMs: 0, fps: 20, columns: 80 });
  assert.ok(frames.length >= 2, 'expected several reveal frames');
  assert.ok(frames[0].split('\n').filter(Boolean).length < 4, 'first frame must be partial');
  assert.equal(frames[frames.length - 1].replace(/\x1b\[[0-9;]*m/g, ''), splashText,
    'the last frame must be exactly the settled splash');
});

test('every reveal frame is a prefix of the splash', () => {
  const frames = introFrames(splashText, { revealMs: 200, shimmerMs: 0, fps: 20, columns: 80 });
  const rows = splashText.split('\n');
  for (const f of frames) {
    const got = f.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l, i) => i < rows.length);
    assert.deepEqual(got, rows.slice(0, got.length), `frame diverged from the splash:\n${f}`);
  }
});

test('below the wordmark breakpoint, shimmer adds no frames (no dead-air hold)', () => {
  // columns: 80 is below WORDMARK_BREAKPOINT (140), so the wordmark band never
  // renders and there is nothing for the shimmer phase to animate. It must
  // hand straight over after the reveal instead of holding the settled frame
  // for the shimmer beat — that hold used to cost ~800ms of frozen screen on
  // every non-wide terminal for zero visual change.
  const withShimmer = introFrames(splashText, { revealMs: 100, shimmerMs: 300, fps: 20, columns: 80 });
  const revealOnly = introFrames(splashText, { revealMs: 100, shimmerMs: 0, fps: 20, columns: 80 });
  assert.equal(withShimmer.length, revealOnly.length,
    'narrow/medium tiers must not grow frames for a shimmer they cannot show');
  assert.deepEqual(withShimmer, revealOnly,
    'the frame sequence must be identical regardless of shimmerMs below the breakpoint');
});

test('at or above the wordmark breakpoint, shimmer recolours only the wordmark band', () => {
  // A realistic wide-tier shape: rows.length > wordmark.height (13), columns
  // at the WIDE breakpoint, so introFrames must take the shimmer branch that
  // was previously reachable only through an ad-hoc probe, not a committed test.
  const bandRows = wordmark.rows.length; // 13
  const bodyRows = ['panel-1', 'panel-2', 'panel-3'];
  const wideText = [...wordmark.rows, ...bodyRows].join('\n');
  const frames = introFrames(wideText, { revealMs: 0, shimmerMs: 150, fps: 20, columns: 140 });
  const shimmerFrames = frames.slice(1); // frame 0 is the settled reveal frame
  assert.ok(shimmerFrames.length >= 2, 'expected multiple shimmer frames');

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  for (const f of shimmerFrames) {
    const rows = f.split('\n');
    assert.equal(rows.length, bandRows + bodyRows.length, 'row count must stay constant');
    // Rows below the wordmark band carry no ANSI and are byte-identical.
    for (let i = bandRows; i < rows.length; i++) {
      assert.equal(rows[i], bodyRows[i - bandRows], `row ${i} below the band must be untouched`);
    }
    // Rows inside the band are still the same text once colour is stripped.
    for (let i = 0; i < bandRows; i++) {
      assert.equal(stripAnsi(rows[i]), wordmark.rows[i], `row ${i} in the band must keep its text`);
    }
  }
  // Distinct ANSI colour across successive shimmer frames — the sweep moves.
  const firstBandRow0 = shimmerFrames[0].split('\n')[0];
  const secondBandRow0 = shimmerFrames[1].split('\n')[0];
  assert.notEqual(firstBandRow0, secondBandRow0,
    'the shimmer sweep must actually change colour between frames');
});

test('playSplashIntro writes nothing when motion is off', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: { POMPOS_NO_MOTION: '1' },
    stream: { isTTY: true },
  });
  assert.equal(played, false);
  assert.deepEqual(writes, []);
});

test('playSplashIntro writes nothing without a TTY', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: {},
    stream: { isTTY: false },
  });
  assert.equal(played, false);
  assert.deepEqual(writes, []);
});

test('playSplashIntro writes nothing under NO_COLOR', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: { NO_COLOR: '1' },
    stream: { isTTY: true },
  });
  assert.equal(played, false);
  assert.deepEqual(writes, []);
});

test('playSplashIntro writes nothing on a dumb terminal', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: { TERM: 'dumb' },
    stream: { isTTY: true },
  });
  assert.equal(played, false);
  assert.deepEqual(writes, []);
});

test('playSplashIntro leaves the screen cleared for Ink', async () => {
  const writes = [];
  await playSplashIntro({ version: '1.0.0', tools: [], skills: [], provider: 'p', model: 'm' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: {},
    stream: { isTTY: true },
    columns: 100,
  });
  assert.ok(writes.length > 0, 'expected frames to be written');
  const last = writes[writes.length - 1];
  assert.ok(last.includes('\x1b[2J') && last.endsWith('\x1b[H'),
    `the final write must hand Ink a clean screen, got: ${JSON.stringify(last)}`);
  // The intro must clear the VISIBLE screen only. \x1b[3J additionally wipes the
  // terminal's scrollback, destroying whatever the user had on screen before
  // launching chat — an unrecoverable side effect of merely starting the app.
  for (const chunk of writes) {
    assert.equal(chunk.includes('\x1b[3J'), false,
      `the intro must never erase the scrollback, got: ${JSON.stringify(chunk)}`);
  }
});

test('a write that throws mid-loop still restores the cursor', async () => {
  // Regression: SHOW_CURSOR + CLEAR must run on every exit path, not only
  // when the frame loop finishes normally. Simulates a write failing partway
  // through (e.g. a closed stdout) and asserts the terminal is still restored
  // rather than left with an invisible cursor.
  const writes = [];
  let calls = 0;
  const throwingWrite = (s) => {
    calls += 1;
    if (calls === 3) throw new Error('simulated write failure');
    writes.push(s);
  };
  await assert.rejects(
    () => playSplashIntro({ version: '1.0.0', tools: [], skills: [], provider: 'p', model: 'm' }, {
      write: throwingWrite,
      sleep: async () => {},
      env: {},
      stream: { isTTY: true },
      columns: 100,
    }),
    /simulated write failure/,
  );
  const last = writes[writes.length - 1];
  assert.ok(last && last.includes('\x1b[?25h') && last.includes('\x1b[2J') && last.endsWith('\x1b[H'),
    `cursor must be restored even though the loop threw, got: ${JSON.stringify(last)}`);
});

test('the intro budget stays short enough not to delay the prompt', () => {
  assert.ok(REVEAL_MS + SHIMMER_MS <= 1300, 'intro must stay under ~1.3s total');
});
