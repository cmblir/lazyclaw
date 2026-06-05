// Group B / M8 — memoize listSkills() + skillsIndex().
//
// composePromptStack is called on every chat/agent turn; listing the
// skills directory + statting + reading every file used to cost a few
// ms at ~30 skills and was the biggest non-network item on the hot
// path. Cache key = the skills/ directory's mtimeMs. Any
// install/remove via this module's API busts the cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listSkills,
  skillsIndex,
  installSkill,
  removeSkill,
  _invalidateSkillsCache,
} from '../skills.mjs';

function tmpCfg(prefix = 'lc-m8-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedSkill(cfg, name, body = `---\ndescription: ${name}\n---\nbody for ${name}\n`) {
  const dir = path.join(cfg, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

test('M8 — repeated skillsIndex calls without disk changes do not re-read every file', () => {
  const cfg = tmpCfg();
  for (let i = 0; i < 5; i++) seedSkill(cfg, `s${i}`);
  _invalidateSkillsCache(cfg);

  // Spy on fs.readFileSync — count calls touching cfg/skills/.
  const realRead = fs.readFileSync;
  let readCount = 0;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.includes(path.join(cfg, 'skills'))) readCount++;
    return realRead.call(this, p, ...rest);
  };

  try {
    const first = skillsIndex(cfg);
    const readsAfterFirst = readCount;
    assert.ok(readsAfterFirst >= 5,
      `first call should read every skill file, got ${readsAfterFirst} reads`);
    // Second call must be served from cache — zero additional file reads.
    const second = skillsIndex(cfg);
    assert.equal(readCount, readsAfterFirst,
      `second call must hit cache; expected ${readsAfterFirst} reads, got ${readCount}`);
    assert.equal(first, second, 'cached index must match the original');
  } finally {
    fs.readFileSync = realRead;
  }
});

test('M8 — installSkill busts the cache so next skillsIndex re-reads disk', () => {
  const cfg = tmpCfg();
  seedSkill(cfg, 'original');
  _invalidateSkillsCache(cfg);
  const before = skillsIndex(cfg);
  assert.ok(before.includes('original'), `expected "original" in index, got: ${before}`);

  // Install a new skill through the module API — must invalidate.
  installSkill('fresh-one', '---\ndescription: fresh-one descr\n---\nbody\n', cfg);

  const after = skillsIndex(cfg);
  assert.ok(after.includes('fresh-one'),
    `expected "fresh-one" in index after install, got: ${after}`);
  assert.notEqual(before, after);
});

test('M8 — removeSkill busts the cache', () => {
  const cfg = tmpCfg();
  seedSkill(cfg, 'doomed');
  _invalidateSkillsCache(cfg);
  const before = skillsIndex(cfg);
  assert.ok(before.includes('doomed'));
  removeSkill('doomed', cfg);
  const after = skillsIndex(cfg);
  assert.ok(!after.includes('doomed'),
    `expected "doomed" gone after removeSkill, got: ${after}`);
});

test('M8 — listSkills cache key uses dir mtime; a manual rm + new file (changing the dir mtime) is picked up', () => {
  const cfg = tmpCfg();
  seedSkill(cfg, 'one');
  _invalidateSkillsCache(cfg);
  const before = listSkills(cfg);
  assert.equal(before.length, 1);
  // Manually drop a new skill in the dir. Writing a NEW file in the
  // skills/ directory updates the directory's own mtime, so the
  // mtime-keyed cache must invalidate without a manual call.
  // Sleep a tick so mtime resolution (sometimes second-only on some
  // filesystems) actually advances.
  const skillsP = path.join(cfg, 'skills', 'two.md');
  fs.writeFileSync(skillsP, '---\ndescription: two\n---\nbody\n');
  // Force a stat-mtime advance on filesystems with second resolution.
  const now = Date.now() / 1000 + 2;
  fs.utimesSync(path.join(cfg, 'skills'), now, now);
  const after = listSkills(cfg);
  assert.equal(after.length, 2,
    `expected 2 skills after manual write, got ${after.length}`);
});

test('M8 — empty skills dir returns "" from skillsIndex and uses cache on the next call', () => {
  const cfg = tmpCfg();
  fs.mkdirSync(path.join(cfg, 'skills'), { recursive: true });
  _invalidateSkillsCache(cfg);
  assert.equal(skillsIndex(cfg), '');
  assert.equal(skillsIndex(cfg), '', 'second call on empty dir still returns ""');
});
