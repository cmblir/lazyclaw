// Phase 0 · state-locks group.
//
// DEFECT A (lost-update races): patchTask/appendTurn, patchGoal/appendCheckIn
// do read-modify-write with tmp+rename. A per-key in-process async mutex
// (lib/config_dir.mjs withKeyedLock) serializes the read-modify-write so two
// concurrent writers on the same id don't lose an update.
//
// DEFECT B (copy-paste): defaultConfigDir() was duplicated across 6+ modules.
// A single lib/config_dir.mjs defaultConfigDir() now backs them all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfigDir, withKeyedLock } from '../lib/config_dir.mjs';
import { registerTask, patchTask, getTask } from '../tasks.mjs';
import { registerGoal, patchGoal, getGoal } from '../goals.mjs';
import { registerTeam } from '../teams.mjs';
import { registerAgent } from '../agents.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-locks-'));
}

test('defaultConfigDir honors POMPOS_CONFIG_DIR override', () => {
  const prev = process.env.POMPOS_CONFIG_DIR;
  try {
    process.env.POMPOS_CONFIG_DIR = '/tmp/override-xyz';
    assert.equal(defaultConfigDir(), '/tmp/override-xyz');
  } finally {
    if (prev === undefined) delete process.env.POMPOS_CONFIG_DIR;
    else process.env.POMPOS_CONFIG_DIR = prev;
  }
});

test('defaultConfigDir falls back to ~/.pompos', () => {
  const prev = process.env.POMPOS_CONFIG_DIR;
  try {
    delete process.env.POMPOS_CONFIG_DIR;
    assert.equal(defaultConfigDir(), path.join(os.homedir(), '.pompos'));
  } finally {
    if (prev !== undefined) process.env.POMPOS_CONFIG_DIR = prev;
  }
});

test('the shared defaultConfigDir backs the per-module re-exports', async () => {
  const prev = process.env.POMPOS_CONFIG_DIR;
  try {
    process.env.POMPOS_CONFIG_DIR = '/tmp/shared-check';
    const tasks = await import('../tasks.mjs');
    const goals = await import('../goals.mjs');
    const loops = await import('../loops.mjs');
    const memory = await import('../memory.mjs');
    const agents = await import('../agents.mjs');
    const skills = await import('../skills.mjs');
    const teams = await import('../teams.mjs');
    for (const mod of [tasks, goals, loops, memory, agents, skills, teams]) {
      assert.equal(mod.defaultConfigDir(), '/tmp/shared-check');
    }
  } finally {
    if (prev === undefined) delete process.env.POMPOS_CONFIG_DIR;
    else process.env.POMPOS_CONFIG_DIR = prev;
  }
});

test('withKeyedLock serializes same-key critical sections', async () => {
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const section = (tag) => withKeyedLock('k', async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield across a macrotask so an unserialized impl would overlap.
    await new Promise((r) => setTimeout(r, 5));
    order.push(tag);
    inFlight--;
  });
  await Promise.all([section('a'), section('b'), section('c')]);
  assert.equal(maxInFlight, 1, 'same-key sections must never overlap');
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('withKeyedLock allows different keys to run concurrently', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const section = (key) => withKeyedLock(key, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  await Promise.all([section('x'), section('y')]);
  assert.equal(maxInFlight, 2, 'different keys should overlap');
});

test('concurrent patchTask on the same id does not lose an update', async () => {
  const dir = tmpDir();
  registerAgent({ name: 'alice', displayName: 'Alice' }, dir);
  registerTeam({ name: 'redteam', displayName: 'Red', agents: ['alice'], lead: 'alice' }, dir);
  const t = registerTask({ title: 'x', team: 'redteam', lead: 'alice' }, dir);

  // Two writers each read-modify-write a DIFFERENT field. Without a lock the
  // later writer's read predates the earlier writer's write, so one field is
  // lost. With the per-key mutex both survive.
  await Promise.all([
    patchTask(t.id, { title: 'from-A' }, dir),
    patchTask(t.id, { description: 'from-B' }, dir),
  ]);

  const after = getTask(t.id, dir);
  assert.equal(after.title, 'from-A');
  assert.equal(after.description, 'from-B');
});

test('concurrent patchGoal on the same name does not lose an update', async () => {
  const dir = tmpDir();
  registerGoal({ name: 'ship', description: 'seed' }, dir);

  await Promise.all([
    patchGoal('ship', { description: 'from-A' }, dir),
    patchGoal('ship', { status: 'active', schedule: 'from-B' }, dir),
  ]);

  const after = getGoal('ship', dir);
  assert.equal(after.description, 'from-A');
  assert.equal(after.schedule, 'from-B');
});
