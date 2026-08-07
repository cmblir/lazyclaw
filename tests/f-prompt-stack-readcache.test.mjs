// tests/f-prompt-stack-readcache.test.mjs
//
// composePromptStack runs once per iteration of the per-message agent loop
// (mention_router), and it re-read four static config files from disk every
// call (global SOUL.md, workspace SOUL.md, personality, USER.md) through an
// unmemoized readOpt. Those layers are byte-identical across a loop, so the
// reads are pure waste. These pin that readOpt is mtime-memoized: an unchanged
// file is read once, and editing it (mtime bumps) busts the cache.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composePromptStack } from '../mas/prompt_stack.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-pstack-'));

test('a static layer file is read from disk once across repeated calls', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'SOUL.md'), 'be excellent to each other');
  const realRead = fs.readFileSync;
  let soulReads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p).endsWith('SOUL.md')) soulReads++;
    return realRead(p, ...rest);
  };
  try {
    const out1 = composePromptStack({ cfgDir: dir, agent: { role: 'x' } });
    const out2 = composePromptStack({ cfgDir: dir, agent: { role: 'x' } });
    assert.match(out1, /be excellent/);
    assert.equal(out1, out2);
    assert.equal(soulReads, 1, 'SOUL.md must be read from disk once, not per call');
  } finally {
    fs.readFileSync = realRead;
  }
});

test('editing a static layer file busts the mtime cache', () => {
  const dir = tmp();
  const soul = path.join(dir, 'SOUL.md');
  fs.writeFileSync(soul, 'first version');
  const a = composePromptStack({ cfgDir: dir, agent: {} });
  assert.match(a, /first version/);
  fs.writeFileSync(soul, 'second version');
  // Force a strictly-greater mtime in case both writes land in one ms tick.
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(soul, future, future);
  const b = composePromptStack({ cfgDir: dir, agent: {} });
  assert.match(b, /second version/);
  assert.doesNotMatch(b, /first version/);
});
