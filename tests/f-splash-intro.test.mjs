// tests/f-splash-intro.test.mjs — the launch animation. It runs BEFORE Ink
// mounts, on a screen it owns outright, then clears and hands over — so it
// cannot desync Ink's erase bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { introFrames, playSplashIntro, REVEAL_MS, SHIMMER_MS } from '../tui/splash_intro.mjs';

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

test('the shimmer phase adds frames that all render the full splash', () => {
  const withShimmer = introFrames(splashText, { revealMs: 100, shimmerMs: 300, fps: 20, columns: 80 });
  const revealOnly = introFrames(splashText, { revealMs: 100, shimmerMs: 0, fps: 20, columns: 80 });
  assert.ok(withShimmer.length > revealOnly.length, 'shimmer must add frames');
  for (const f of withShimmer.slice(revealOnly.length)) {
    assert.equal(f.replace(/\x1b\[[0-9;]*m/g, '').split('\n').length, 4);
  }
});

test('playSplashIntro writes nothing when motion is off', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: { LAZYCLAW_NO_MOTION: '1' },
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
  assert.ok(last.includes('\x1b[2J') && last.includes('\x1b[3J') && last.endsWith('\x1b[H'),
    `the final write must hand Ink a clean screen, got: ${JSON.stringify(last)}`);
});

test('the intro budget stays short enough not to delay the prompt', () => {
  assert.ok(REVEAL_MS + SHIMMER_MS <= 1300, 'intro must stay under ~1.3s total');
});
