// Phase 2 wave-B "verify-before-store": a deterministic, $0 quality gate in
// installSynthesized so plausible-but-empty, duplicate, or trivially-useless
// synthesized skills never reach the store (and therefore never pollute
// recall). This mirrors Voyager's "verify before store" principle but WITHOUT
// an LLM replay — the full eval-harness replay is deferred to a later phase.
//
// The gate is additive and OPT-OUT-of-nothing: a valid, non-duplicate skill
// installs byte-identically to before, returning { skill, path, version }.
// A rejected skill returns { installed:false, reason } and writes nothing.
//
// Proven here:
//   (a) an empty / near-empty-body skill is NOT installed, returns a reason;
//   (b) a near-duplicate of an existing skill is NOT installed;
//   (c) a valid new skill IS installed (unchanged { skill, path, version });
//   (d) re-versioning the agent's OWN existing skill still works (a
//       byte-identical re-version is a legitimate self-improvement update,
//       not a blocking duplicate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installSynthesized } from '../mas/skill_synth.mjs';
import * as skills from '../skills.mjs';

function tmpCfg(prefix = 'lc-vbs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('(a) empty / near-empty body is NOT installed and returns a reason', () => {
  const cfg = tmpCfg();
  // Body is only whitespace → nothing actionable to store.
  const res = installSynthesized({
    name: 'empty-skill',
    description: 'looks fine but has no body',
    body: '   \n\n',
    sourceTask: 't-empty',
  }, cfg);
  assert.equal(res.installed, false, JSON.stringify(res));
  assert.ok(res.reason, 'expected a structured reason');
  assert.match(res.reason, /empty|body|min|short|structural/i, res.reason);
  // Nothing was written (the skills/ dir may not even exist).
  assert.equal(skills.skillExists('empty-skill', cfg), false);
  const skDir = path.join(cfg, 'skills');
  assert.equal(fs.existsSync(skDir) ? fs.readdirSync(skDir).length : 0, 0);
});

test('(a2) missing name/description is NOT installed and returns a reason', () => {
  const cfg = tmpCfg();
  const res = installSynthesized({
    name: '',
    description: '',
    body: '## When to Use\n- something concrete and long enough to pass length\n',
    sourceTask: 't-noname',
  }, cfg);
  assert.equal(res.installed, false, JSON.stringify(res));
  assert.ok(res.reason, 'expected a structured reason');
});

test('(b) a near-duplicate of an existing skill is NOT installed', () => {
  const cfg = tmpCfg();
  const body =
    '## When to Use\n- when the flaky retry loop appears in CI logs\n\n' +
    '## Procedure\n1. inspect the retry counter\n2. bump the backoff window\n3. rerun the suite\n';
  const first = installSynthesized({
    name: 'fix-flaky-retry',
    description: 'handles flaky CI retry loops',
    body,
    sourceTask: 't-dup1',
  }, cfg);
  assert.ok(first.skill, 'first install should succeed');
  assert.equal(first.path && fs.existsSync(first.path), true);

  // A different slug but a body that is a near-identical restatement of the
  // one we just stored. reserveSynthName gives it a fresh name (no slug
  // clash), so ONLY the body-similarity check can catch it.
  const dup = installSynthesized({
    name: 'resolve-flaky-retry',
    description: 'handles flaky CI retry loops (reworded)',
    body:
      '## When to Use\n- when the flaky retry loop appears in CI logs\n\n' +
      '## Procedure\n1. inspect the retry counter\n2. bump the backoff window\n3. rerun the suite\n',
    sourceTask: 't-dup2',
  }, cfg);
  assert.equal(dup.installed, false, JSON.stringify(dup));
  assert.match(dup.reason, /duplicate|similar/i, dup.reason);
  // Only the first skill exists.
  assert.equal(skills.skillExists('resolve-flaky-retry', cfg), false);
  assert.equal(fs.readdirSync(path.join(cfg, 'skills')).length, 1);
});

test('(c) a valid new skill IS installed with the unchanged success shape', () => {
  const cfg = tmpCfg();
  const res = installSynthesized({
    name: 'sort-imports',
    description: 'orders import statements deterministically',
    body:
      '## When to Use\n- when a file has an unsorted import block\n\n' +
      '## Procedure\n1. group by origin\n2. sort each group alphabetically\n',
    sourceTask: 't-ok',
  }, cfg);
  assert.equal(res.installed, undefined, 'valid install keeps the legacy success shape');
  assert.equal(res.skill, 'sort-imports');
  assert.equal(res.version, 1);
  assert.ok(res.path && fs.existsSync(res.path), 'skill file should be written');
});

test("(d) re-versioning the agent's OWN existing skill still works", () => {
  const cfg = tmpCfg();
  const body =
    '## When to Use\n- when a config drift is detected between envs\n\n' +
    '## Procedure\n1. diff the two configs\n2. reconcile toward the source of truth\n';
  const v1 = installSynthesized({
    name: 'reconcile-config',
    description: 'reconciles config drift between environments',
    body,
    sourceTask: 't-v1',
    createdBy: 'agent',
  }, cfg);
  assert.equal(v1.skill, 'reconcile-config');
  assert.equal(v1.version, 1);

  // Same slug, same (own, agent-authored) skill → a version bump is a
  // legitimate self-improvement update, NOT a blocking duplicate, even
  // though the body is byte-identical.
  const v2 = installSynthesized({
    name: 'reconcile-config',
    description: 'reconciles config drift between environments',
    body,
    sourceTask: 't-v2',
    createdBy: 'agent',
  }, cfg);
  assert.equal(v2.installed, undefined, JSON.stringify(v2));
  assert.equal(v2.skill, 'reconcile-config');
  assert.equal(v2.version, 2, 'own re-version should bump to v2');
  const written = fs.readFileSync(v2.path, 'utf8');
  assert.ok(written.includes('version: 2'), written);
});
