// tests/f-skill-body-cache.test.mjs
//
// composeSystemPrompt loops over the requested skill names and calls loadSkill
// for each, which did fs.readFileSync(p) every time. That runs on the reply
// path of every POST /agent turn carrying body.skills, so each turn re-read
// every selected skill .md from disk. The skills *index* was already cached,
// but the per-skill body was not. These pin that loadSkill is mtime-memoized
// (read once per unchanged file) and that rewriting a skill busts the cache.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill, loadSkill } from '../skills.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-skb-'));

test('loadSkill reads a skill body from disk once across repeated calls', () => {
  const d = tmp();
  installSkill('alpha', '---\nname: alpha\n---\nbody one', d);
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => { if (String(p).endsWith('alpha.md')) reads++; return real(p, ...rest); };
  try {
    const a = loadSkill('alpha', d);
    const b = loadSkill('alpha', d);
    assert.match(a, /body one/);
    assert.equal(a, b);
    assert.equal(reads, 1, 'alpha.md must be read once across two loadSkill calls');
  } finally {
    fs.readFileSync = real;
  }
});

test('rewriting a skill busts the body cache', () => {
  const d = tmp();
  installSkill('beta', 'first body', d);
  assert.match(loadSkill('beta', d), /first body/);
  installSkill('beta', 'second body', d);  // rewrite bumps mtime + invalidates
  const out = loadSkill('beta', d);
  assert.match(out, /second body/);
  assert.doesNotMatch(out, /first body/);
});

test('loadSkill still throws for a missing skill', () => {
  const d = tmp();
  assert.throws(() => loadSkill('ghost', d), /skill not found/);
});
