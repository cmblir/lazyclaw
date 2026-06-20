// tests/f-memory-skill-index-writethrough.test.mjs
//
// README advertises "durable recall over sessions, skills, trajectories, and
// memory", but several writers bypassed the FTS index:
//   - memory.setCore() wrote core.md with no indexMemory → recall missed it.
//   - memory.dream() wrote episodic/*.md with no indexMemory → recall missed it.
//   - skills.removeSkill() / skills_curator archival unlinked the .md but left
//     a stale, still-recallable FTS row.
// These pin the write-through so the durable-recall claim holds.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCore, dream } from '../memory.mjs';
import { installSkill, removeSkill } from '../skills.mjs';
import * as idx from '../mas/index_db.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-midx-'));
// Fire-and-forget write-throughs resolve on a microtask after the (cached)
// dynamic import settles; flush a few ticks before asserting.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test('setCore write-throughs into the durable recall memories index', async () => {
  const dir = tmp();
  setCore('zonkberry is the curated core fact', dir);
  await settle();
  const hits = idx.recall('zonkberry', { configDir: dir, scope: ['memories'] }).hits;
  assert.ok(hits.length > 0, 'core memory must be recallable after setCore');
});

test('dream write-throughs each episodic topic into the index', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'recent.jsonl'),
    JSON.stringify({ sessionId: 's1', role: 'user', content: 'talk about quibblefax', ts: 1 }) + '\n');
  const provider = { async *sendMessage() { yield '{"topics":[{"topic":"quibblefax-notes","summary":"quibblefax is a topic summary"}]}'; } };
  const r = await dream('s1', { provider }, dir);
  assert.deepEqual(r.topics, ['quibblefax-notes']);
  const hits = idx.recall('quibblefax', { configDir: dir, scope: ['memories'] }).hits;
  assert.ok(hits.length > 0, 'episodic topic must be recallable after dream');
});

test('removeSkill deletes the skill FTS row so it stops surfacing in recall', async () => {
  const dir = tmp();
  idx.indexSkill({ skill_name: 'wobblegear', content: 'wobblegear body text' }, dir);
  assert.ok(idx.recall('wobblegear', { configDir: dir, scope: ['skills'] }).hits.length > 0, 'precondition: indexed');
  installSkill('wobblegear', '---\nname: wobblegear\n---\nwobblegear body text', dir);
  removeSkill('wobblegear', dir);
  await settle();
  assert.equal(idx.recall('wobblegear', { configDir: dir, scope: ['skills'] }).hits.length, 0, 'removed skill must not be recallable');
});
