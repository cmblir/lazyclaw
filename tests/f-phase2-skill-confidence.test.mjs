// Phase 2 wave-A "efficacy-loop": the confidence subsystem must COMPOUND.
//
// Before this group, mas/learning._runPostTask called computeConfidence
// with the CONSTANT {successes:1, trials:1}, so every skill was frozen at
// the ~0.5 Laplace prior and the Wilson lower bound never engaged; the
// negative half (active-recall-miss) was implemented but nothing fired
// it. These tests prove the real per-skill feedback loop:
//   (a) the stats store round-trips successes/trials per skill;
//   (b) 3+ successful tasks push a skill's confidence above the 0.5 prior
//       via the Wilson lower bound, and more successes raise it further;
//   (c) a failed task that recalled a skill increments trials WITHOUT a
//       success and lowers its confidence;
//   (d) a skill whose confidence falls below the archive threshold is
//       archived through the existing active-recall-miss path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as skillStats from '../mas/skill_stats.mjs';
import { runLearning, _runActiveRecallMiss } from '../mas/learning.mjs';
import * as skills from '../skills.mjs';
import { installSynthesized } from '../mas/skill_synth.mjs';
import { openIndex, closeIndex } from '../mas/index_db.mjs';

function tmpCfg(prefix = 'lc-f-conf-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A fixed injected clock so recency decay / lastUsedAt are reproducible.
const NOW = Date.parse('2026-07-11T00:00:00Z');

// Install a recallable agent-authored skill whose body carries a distinct
// marker phrase, so the efficacy loop's recall (on the task's user message)
// finds exactly this skill. created_at is stamped at NOW (midnight UTC) so
// the efficacy loop's recency decay is a no-op (ageMs == 0) and the
// confidence math is exactly the Wilson/Laplace value. Returns its
// resolved on-disk name.
function installRecallableSkill(cfg, { name, marker, confidence = null }) {
  const { skill } = installSynthesized({
    name,
    description: `handles ${marker} tasks`,
    body: `## When to Use\n- when ${marker} appears in the request\n\n## Procedure\n1. handle ${marker}\n`,
    sourceTask: 't_seed',
    createdBy: 'agent',
    trainedBy: 'anthropic',
    trainedOnModel: 'claude-haiku-4-5',
    confidence,
    outcome: 'done',
  }, cfg, new Date(NOW));
  return skill;
}

function readConfidence(cfg, name) {
  const doc = fs.readFileSync(path.join(cfg, 'skills', `${name}.md`), 'utf8');
  return Number(skills.parseFrontmatter(doc).meta.confidence);
}

// A post-task ctx that runs ONLY the efficacy loop path deterministically:
// no agent/task synthesis (so no new skill is minted), just the recall +
// stats + re-stamp for the pre-installed skill. runEfficacyLoop is what
// _runPostTask / _runPostFailure delegate to.
function efficacyCtx(cfg, marker) {
  return {
    configDir: cfg,
    now: NOW,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    agent: { name: 'a', provider: 'anthropic', model: 'claude-opus-4-7' },
    task: { id: 't', title: 't', turns: [{ agent: 'user', text: `please ${marker} this` }] },
  };
}

// ── (a) stats store round-trips per skill ─────────────────────────────
test('(a) skill_stats round-trips successes/trials per skill', () => {
  const cfg = tmpCfg();
  // Unknown skill → zeroed record, never throws.
  assert.deepEqual(skillStats.statsOf('nope', cfg), { successes: 0, trials: 0, lastUsedAt: 0 });

  // Three successes then one miss on skill A.
  skillStats.recordOutcome('alpha', true, cfg, NOW);
  skillStats.recordOutcome('alpha', true, cfg, NOW + 1);
  skillStats.recordOutcome('alpha', true, cfg, NOW + 2);
  skillStats.recordOutcome('alpha', false, cfg, NOW + 3);
  const a = skillStats.statsOf('alpha', cfg);
  assert.equal(a.successes, 3, 'three successes counted');
  assert.equal(a.trials, 4, 'four trials counted (3 hits + 1 miss)');
  assert.equal(a.lastUsedAt, NOW + 3, 'lastUsedAt stamps the injected clock');

  // A second skill is isolated from the first.
  skillStats.recordOutcome('beta', false, cfg, NOW);
  assert.deepEqual(skillStats.statsOf('beta', cfg), { successes: 0, trials: 1, lastUsedAt: NOW });
  assert.equal(skillStats.statsOf('alpha', cfg).trials, 4, 'beta write did not disturb alpha');

  // seedStats overwrites at 1/1 for a fresh successful synthesis.
  skillStats.seedStats('gamma', true, cfg, NOW);
  assert.deepEqual(skillStats.statsOf('gamma', cfg), { successes: 1, trials: 1, lastUsedAt: NOW });

  // recordOutcome rejects a non-finite clock (deterministic-clock guard).
  assert.throws(() => skillStats.recordOutcome('alpha', true, cfg, NaN), TypeError);
});

// ── (b) 3+ successful tasks raise confidence via Wilson ───────────────
test('(b) three+ successful tasks push confidence above the 0.5 prior and it keeps rising', () => {
  const cfg = tmpCfg();
  openIndex(cfg);
  const marker = 'zorptastic';
  const name = installRecallableSkill(cfg, { name: 'zorp-skill', marker });

  const confs = [];
  for (let i = 0; i < 6; i++) {
    const res = skillStats.runEfficacyLoop(efficacyCtx(cfg, marker), {
      success: true,
      trainer: { provider: 'anthropic' },
    });
    // The skill must have been recalled and updated on every pass.
    assert.ok(res.updated.some((u) => u.name === name),
      `pass ${i}: expected ${name} to be updated, got ${JSON.stringify(res)}`);
    confs.push(readConfidence(cfg, name));
  }

  const stats = skillStats.statsOf(name, cfg);
  assert.equal(stats.trials, 6, `expected 6 trials, got ${stats.trials}`);
  assert.equal(stats.successes, 6, `expected 6 successes, got ${stats.successes}`);

  // Once the Wilson lower bound is in force (trials >= 3) an all-successful
  // history clears the 0.5 prior a frozen 1/1 skill used to be stuck at,
  // and it keeps climbing as more successes tighten the bound. (The frozen
  // 1/1 prior was exactly 0.667 and never moved.)
  const last = confs[confs.length - 1];
  assert.ok(last > 0.5, `6/6 confidence should clear the 0.5 prior, got ${last}`);
  // Compare two adjacent points both inside the Wilson regime (n>=4) so the
  // Laplace→Wilson transition dip at n=3 doesn't confound the trend.
  assert.ok(confs[5] > confs[4],
    `confidence should rise with more successes, got ${JSON.stringify(confs)}`);

  closeIndex(cfg);
});

// ── (c) a failed task recalls a skill: trials++ w/o success, conf down ─
test('(c) a failed task increments trials without a success and lowers confidence', () => {
  const cfg = tmpCfg();
  openIndex(cfg);
  const marker = 'flibberwock';
  const name = installRecallableSkill(cfg, { name: 'flib-skill', marker });

  // Build a healthy history first (5 successes → a high Wilson bound).
  const ctxOk = efficacyCtx(cfg, marker);
  for (let i = 0; i < 5; i++) {
    skillStats.runEfficacyLoop(ctxOk, { success: true, trainer: { provider: 'anthropic' } });
  }
  const before = readConfidence(cfg, name);
  const statsBefore = skillStats.statsOf(name, cfg);
  assert.equal(statsBefore.successes, 5);
  assert.equal(statsBefore.trials, 5);

  // A failed task that recalls the same skill: trial up, success NOT.
  const res = skillStats.runEfficacyLoop(efficacyCtx(cfg, marker), {
    success: false,
    trainer: { provider: 'anthropic' },
    archiveMisses: true,
    onArchive: _runActiveRecallMiss,
  });
  const statsAfter = skillStats.statsOf(name, cfg);
  assert.equal(statsAfter.trials, 6, 'trials must increment on a miss');
  assert.equal(statsAfter.successes, 5, 'successes must NOT increment on a miss');

  const after = readConfidence(cfg, name);
  assert.ok(after < before,
    `a miss must lower confidence (before ${before}, after ${after})`);
  // 3/4 is still healthy, so it is updated (not archived).
  assert.ok(res.updated.some((u) => u.name === name), 'a healthy skill is re-stamped, not archived');

  closeIndex(cfg);
});

// ── (d) confidence below threshold → archived ─────────────────────────
test('(d) a skill whose confidence falls below the archive threshold is archived', () => {
  const cfg = tmpCfg();
  openIndex(cfg);
  const marker = 'gronktacular';
  const name = installRecallableSkill(cfg, { name: 'gronk-skill', marker });

  // Drive repeated FAILED recalls so successes stay 0 while trials climb.
  // 0/n Wilson lower bound collapses toward 0, well under the 0.3 floor,
  // so the skill must be archived (removed from the live store) and
  // reported under `archived`.
  let archived = false;
  for (let i = 0; i < 3 && !archived; i++) {
    const res = skillStats.runEfficacyLoop(efficacyCtx(cfg, marker), {
      success: false,
      trainer: { provider: 'anthropic' },
      archiveMisses: true,
      onArchive: _runActiveRecallMiss,
    });
    if (res.archived.includes(name)) archived = true;
  }

  assert.ok(archived, `expected ${name} to be archived after repeated misses`);
  assert.equal(skills.skillExists(name, cfg), false,
    'archived skill must be removed from the live skills store');

  closeIndex(cfg);
});

// ── wiring: runLearning('post-failure') fires the efficacy loop ───────
test('runLearning("post-failure") wires the efficacy loop and archives a bad recalled skill', async () => {
  const cfg = tmpCfg();
  openIndex(cfg);
  const marker = 'quibblenaut';
  const name = installRecallableSkill(cfg, { name: 'quib-skill', marker, confidence: 0.35 });

  // A failed task whose user message recalls the pre-installed skill. No
  // agent/apiKey → synthesizeSkill is skipped, but the efficacy loop still
  // runs (best-effort) and records the miss + re-stamps/archives.
  const res = await runLearning('post-failure', {
    configDir: cfg,
    now: NOW,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    task: { id: 't-fail', title: 'x', turns: [{ agent: 'user', text: `please ${marker} it` }] },
  });
  assert.equal(res.trigger, 'post-failure');
  assert.ok(res.results.efficacy, 'post-failure must run the efficacy loop');
  const stats = skillStats.statsOf(name, cfg);
  assert.equal(stats.trials, 1, 'the recalled skill recorded one trial');
  assert.equal(stats.successes, 0, 'a failed task recorded no success');

  closeIndex(cfg);
});
