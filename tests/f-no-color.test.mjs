// f-no-color: accessibility gate — the legacy readline pickers + setup
// wizard must honor the NO_COLOR standard (https://no-color.org), TERM=dumb,
// and non-TTY stdout, and _arrowMenu must NOT hard-exit the process on Ctrl+C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { theme, colorEnabled, paint } from '../tui/theme.mjs';
import { _arrowMenu, _providerFamilies } from '../tui/pickers.mjs';

const ESC = /\x1b\[/;
const TTY = { isTTY: true };
const NOT_TTY = { isTTY: false };

// Snapshot + restore the NO_COLOR / TERM env around each case so toggling one
// doesn't leak into others. Returns the previous values.
function withEnv(env, fn) {
  const saved = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Force stdout to look like a TTY for a synchronous block, then restore.
// Plain assignment (not defineProperty) keeps node:test's reporter stream
// healthy. Used to exercise the color-ON branch of paint()/picker tags, which
// call colorEnabled() against the default stream.
function asTTY(fn) {
  const saved = process.stdout.isTTY;
  try { process.stdout.isTTY = true; return fn(); }
  finally { process.stdout.isTTY = saved; }
}

test('colorEnabled true on a TTY with no NO_COLOR / dumb term', () => {
  withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
    assert.equal(colorEnabled(TTY), true);
  });
});

test('NO_COLOR (any non-empty value) disables color and paint strips escapes', () => {
  withEnv({ NO_COLOR: '1' }, () => {
    assert.equal(colorEnabled(TTY), false);
    const out = paint('38;5;245', 'hello');
    assert.equal(out, 'hello', 'paint must return bare text under NO_COLOR');
    assert.ok(!ESC.test(out));
  });
});

test('TERM=dumb disables color even on a TTY', () => {
  withEnv({ NO_COLOR: undefined, TERM: 'dumb' }, () => {
    assert.equal(colorEnabled(TTY), false);
  });
});

test('non-TTY stdout disables color', () => {
  withEnv({ NO_COLOR: undefined, TERM: 'xterm' }, () => {
    assert.equal(colorEnabled(NOT_TTY), false);
  });
});

test('paint embeds an ANSI escape when color is on (TTY, no NO_COLOR)', () => {
  withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
    asTTY(() => {
      const out = paint('38;5;245', 'hello');
      assert.ok(ESC.test(out), 'paint should embed an ANSI escape when color is on');
      assert.ok(out.includes('hello'));
    });
  });
});

test('picker family tags carry no escapes under NO_COLOR, do under color', () => {
  // _providerFamilies builds the readline-specific [needs key]/[meta]/… pills.
  const tagsOf = () => Object.values(_providerFamilies()).map((f) => f.tag).join('');
  withEnv({ NO_COLOR: '1' }, () => {
    const tags = tagsOf();
    assert.ok(!ESC.test(tags), `family tags must be escape-free under NO_COLOR, got: ${JSON.stringify(tags)}`);
  });
  withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
    asTTY(() => {
      const tags = tagsOf();
      assert.ok(ESC.test(tags), 'family tags should include escapes when color is on');
    });
  });
});

// Keep theme's existing token surface intact.
test('theme still exports its color tokens', () => {
  assert.equal(theme.amber, '#FFB347');
  assert.equal(typeof theme.dim, 'function');
});

// Defined last and isolated: _arrowMenu drives the real process.stdin/stdout
// (raw-mode + draw escapes). We deliberately do NOT stub process.stdout.write
// — node:test flushes its reporter through it asynchronously, so swallowing it
// here would eat the other tests' TAP lines. The draw escapes are harmless
// noise between TAP records. Everything is restored after the menu settles.
test('_arrowMenu Ctrl+C resolves a cancel sentinel and never calls process.exit', async () => {
  const realExit = process.exit;
  let exitCalled = false;
  process.exit = (() => { exitCalled = true; throw new Error('process.exit must not be called'); });

  const realStdinIsTTY = process.stdin.isTTY;
  const realStdoutIsTTY = process.stdout.isTTY;
  const realSetRawMode = process.stdin.setRawMode;
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.stdin.setRawMode = () => {};

  let result, caught;
  try {
    const p = _arrowMenu({ title: 'pick', items: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] });
    // Let _arrowMenu attach its keypress listener, then fire Ctrl+C. The
    // handler runs cleanup() + resolve() synchronously on emit, so the menu
    // is settled before we restore the streams below.
    await new Promise((r) => setImmediate(r));
    process.stdin.emit('keypress', '', { ctrl: true, name: 'c' });
    result = await p;
  } catch (e) {
    caught = e;
  } finally {
    process.exit = realExit;
    process.stdin.setRawMode = realSetRawMode;
    process.stdin.isTTY = realStdinIsTTY;
    process.stdout.isTTY = realStdoutIsTTY;
    // _arrowMenu resume()+ref()'d the real stdin; release it so the test
    // process can exit (otherwise node:test hangs and truncates output).
    process.stdin.pause();
    if (process.stdin.unref) process.stdin.unref();
  }

  assert.equal(caught, undefined, caught && `_arrowMenu threw: ${caught.message}`);
  assert.equal(exitCalled, false, 'process.exit must not be called on Ctrl+C');
  assert.ok(result === 'CANCEL' || result === 'BACK', `expected a cancel sentinel, got ${JSON.stringify(result)}`);
});
