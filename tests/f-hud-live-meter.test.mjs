// tests/f-hud-live-meter.test.mjs — while a turn streams, the HUD row shows
// throughput next to the existing token/cost fields. The unit is spelled out
// ("ch/s") because this segment sits right next to the token counts and a
// bare "/s" reads as tokens/sec — it is characters, not tokens.
//
// Also covers the wiring end to end (mounted ReplApp -> real reducer ->
// StatusBar -> rendered HUD row), not just the pure formatters: tui/repl.mjs
// feeds `liveChars` from a per-turn accumulator (`state.liveCharCount`), NOT
// `state.liveAssistant.length` — that buffer is truncated back to the
// trailing partial line on every newline, so reading it directly would
// silently regress the meter to near-zero every time a line break lands
// mid-turn (see tests/f-stream-started-at.test.mjs for the reducer-level
// lifecycle tests of that field).
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHudRow, formatRate } from '../tui/hud.mjs';
import { mountRepl } from './helpers/repl_harness.mjs';
import { makeScreen, plainText } from './helpers/vt_screen.mjs';

const fields = { inTok: 1200, outTok: 340, costUsd: 0.0123, trainer: 'claude-cli', orch: '' };

test('formatRate reports characters per second', () => {
  assert.equal(formatRate(1000, 1000), '1000 ch/s');
  assert.equal(formatRate(500, 2000), '250 ch/s');
  assert.equal(formatRate(12_500, 1000), '12.5k ch/s');
});

test('formatRate returns empty for a meaningless sample', () => {
  assert.equal(formatRate(0, 1000), '');
  assert.equal(formatRate(100, 0), '');
  assert.equal(formatRate(100, 150), '', 'samples under 250ms are too noisy to show');
});

test('formatHudRow is unchanged without a live sample', () => {
  const out = formatHudRow(fields);
  assert.match(out, /↑1.2k ↓340 tok/);
  assert.match(out, /\$0.0123/);
  assert.doesNotMatch(out, /⇅/);
});

test('formatHudRow appends the rate segment during a stream', () => {
  const out = formatHudRow(fields, { chars: 5000, elapsedMs: 2000 });
  assert.match(out, /⇅ 2500 ch\/s/);
  assert.match(out, /↑1.2k ↓340 tok/, 'existing segments must survive');
});

test('formatHudRow drops the rate segment when the sample is meaningless', () => {
  assert.doesNotMatch(formatHudRow(fields, { chars: 0, elapsedMs: 5000 }), /⇅/);
  assert.doesNotMatch(formatHudRow(fields, {}), /⇅/);
});

test('formatHudRow still returns empty for no fields', () => {
  assert.equal(formatHudRow(null), '');
  assert.equal(formatHudRow(null, { chars: 100, elapsedMs: 1000 }), '');
});

// ─── Mounted regression: repl.mjs must feed the ACCUMULATED per-turn char
// count, not liveAssistant.length ─────────────────────────────────────────
//
// Harness: mountRepl (tests/helpers/repl_harness.mjs) + the vt_screen model
// (tests/helpers/vt_screen.mjs), the same combo tests/f-clear-splash-repaint
// .test.mjs uses — reused here instead of tests/p3-statusbar-live.test.mjs's
// inline mkStdio+regex approach because vt_screen replays the byte stream
// into an actual screen grid (handling cursor moves / erase-line codes), so
// a snapshot reflects exactly what is CURRENTLY on screen. p3's approach
// (regex over the raw concatenated byte log) only proves a string appeared
// SOMEWHERE in history, which is not precise enough for reading a number
// that changes on every render tick.
//
// Scenario: the turn writes ONE chunk containing a completed line (5000
// chars) followed by a newline and a short trailing partial ("BB", 2 chars).
// onStreamChunk flushes the completed line to scrollback, leaving
// state.liveAssistant === 'BB' (length 2) — exactly the value the buggy
// `state.liveAssistant.length` wiring would report, versus the correct
// per-turn total of 5003 characters. The two produce rates far enough apart
// (thousands vs. single digits per second) that the assertion holds
// regardless of exact scheduling jitter — see the >400 threshold below.
const BIG_CHUNK = `${'A'.repeat(5000)}\nBB`; // 5000 + 1 + 2 = 5003 chars total

function snapshotText(bytes) {
  const screen = makeScreen({ rows: 40, columns: 100 });
  for (const chunk of bytes) screen.write(chunk);
  return plainText(screen);
}

// Parses "2500 ch/s" or "12.5k ch/s" back into a plain characters/sec number.
function parseRateChPerSec(text) {
  const m = /⇅ ([\d.]+)(k?) ch\/s/.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'k' ? n * 1000 : n;
}

test('mounted ReplApp: the HUD rate reflects the TOTAL turn characters, not the post-flush trailing partial', async () => {
  const runTurnFactory = (writeFn) => async (text, signal) => {
    writeFn(BIG_CHUNK);
    // Hold the turn open (never resolves on its own) so the HUD keeps
    // reporting a live sample while the test polls. Esc (sent below) aborts
    // the controller, which resolves this via the signal listener — no
    // dangling timers to clean up.
    await new Promise((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', resolve, { once: true });
    });
  };

  const h = mountRepl({
    statusInfo: {
      provider: 'anthropic', model: 'opus',
      hud: { inTok: 0, outTok: 0, costUsd: 0, trainer: '', orch: '' },
    },
    runTurnFactory,
  });
  try {
    await h.settle();
    h.type('hello');
    await h.settle(40);
    h.type('\r'); // submit -> onUserInput sets streamStartedAt, runTurn writes BIG_CHUNK

    // Deadline-based poll (not a fixed sleep): the streaming indicator's
    // useMotion interval re-renders every BLINK_MS (450ms) under node --test
    // (motion off), so the first render with elapsedMs >= RATE_MIN_SAMPLE_MS
    // typically lands around there; poll generously beyond that to absorb
    // scheduler jitter without ever sleeping a fixed amount up front.
    const deadline = Date.now() + 4000;
    let text = '';
    let rate = null;
    while (Date.now() < deadline) {
      await h.settle(30);
      text = snapshotText(h.bytes);
      rate = parseRateChPerSec(text);
      if (rate != null) break;
    }

    assert.ok(rate != null, `expected a live rate segment to appear before the deadline, screen:\n${text}`);
    assert.ok(rate > 400,
      `expected a rate reflecting ~5003 total chars this turn (hundreds to tens of ` +
      `thousands ch/s), not the 2-char trailing partial ("BB", which would read ` +
      `under 10 ch/s here); got ${rate} ch/s, screen:\n${text}`);
  } finally {
    // Abort the in-flight turn cleanly (resolves the pending promise above)
    // before unmounting, so nothing is left dangling.
    h.type('\x1b');
    await h.settle(60);
    h.unmount();
  }
});
