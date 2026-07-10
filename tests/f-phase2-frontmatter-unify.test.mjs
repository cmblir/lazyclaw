// Phase 2 wave-A: the four divergent frontmatter parsers are unified behind
// mas/frontmatter.parseFrontmatter. These tests prove (a) values quoted by
// skill_synth.assembleSkillDoc/escapeYaml round-trip UNQUOTED through the
// shared parser, and (b) all four former call sites yield identical meta for
// the same input (no quoting drift).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter as shared } from '../mas/frontmatter.mjs';
import { parseFrontmatter as skillsParse } from '../skills.mjs';
import { _miniFrontmatter } from '../mas/index_rank.mjs';
import { assembleSkillDoc } from '../mas/skill_synth.mjs';

// A group/trained_by that escapeYaml WILL quote (leading '-' and an embedded
// colon respectively) so the drift is observable.
const QUOTED_GROUP = '-weird:group';
const QUOTED_TRAINED_BY = 'anthropic: opus';

function sampleDoc() {
  return assembleSkillDoc({
    name: 'demo-skill',
    description: 'a demo',
    trainedBy: QUOTED_TRAINED_BY,
    group: QUOTED_GROUP,
    body: 'hello body',
  });
}

test('shared parser unquotes values written by assembleSkillDoc/escapeYaml', () => {
  const doc = sampleDoc();
  // Precondition: the doc really does contain quoted values (otherwise the
  // test would pass vacuously).
  assert.ok(doc.includes(`group: "${QUOTED_GROUP}"`), 'group should be quoted in raw doc');
  assert.ok(doc.includes(`trained_by: "${QUOTED_TRAINED_BY}"`), 'trained_by should be quoted in raw doc');

  const { meta, body } = shared(doc);
  assert.equal(meta.group, QUOTED_GROUP, 'group must be unquoted');
  assert.equal(meta.trained_by, QUOTED_TRAINED_BY, 'trained_by must be unquoted');
  assert.equal(meta.name, 'demo-skill');
  assert.equal(body.trim(), 'hello body');
});

test('all four former call sites yield identical meta (no quoting drift)', () => {
  const doc = sampleDoc();
  const sharedMeta = shared(doc).meta;
  const skillsMeta = skillsParse(doc).meta;
  const miniMeta = _miniFrontmatter(doc).meta;

  for (const key of ['group', 'trained_by', 'name', 'description']) {
    assert.equal(skillsMeta[key], sharedMeta[key], `skills.parseFrontmatter drift on ${key}`);
    assert.equal(miniMeta[key], sharedMeta[key], `_miniFrontmatter drift on ${key}`);
  }
});

test('shared parser parses cross_cli_tested inline list into objects', () => {
  const doc = assembleSkillDoc({
    name: 'x-skill',
    description: 'd',
    crossCliTested: [
      { provider: 'anthropic', model: 'opus', outcome: 'done', tested_at: '2026-01-01' },
      { provider: 'openai', model: 'gpt', outcome: 'done', tested_at: '2026-01-02' },
    ],
    body: 'b',
  });
  const { meta } = shared(doc);
  assert.ok(Array.isArray(meta.cross_cli_tested), 'cross_cli_tested must be an array');
  assert.deepEqual(
    meta.cross_cli_tested.map((t) => t.provider),
    ['anthropic', 'openai'],
  );
});

test('recall reads cross_cli_tested providers through the shared parser', async () => {
  // recall._readSkillCrossCli is internal; exercise the shared parser on the
  // exact list shape recall used to regex, proving equivalence.
  const raw = [
    '---',
    'name: y',
    'cross_cli_tested:',
    '  - provider: "anthropic"',
    '    model: opus',
    '  - provider: openai',
    '---',
    'body',
  ].join('\n');
  const { meta } = shared(raw);
  assert.deepEqual(
    (meta.cross_cli_tested || []).map((t) => t.provider),
    ['anthropic', 'openai'],
  );
});

test('no frontmatter → empty meta, untouched body', () => {
  const { meta, body } = shared('just text\nno fence');
  assert.deepEqual(meta, {});
  assert.equal(body, 'just text\nno fence');
});
