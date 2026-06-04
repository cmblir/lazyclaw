// Phase B: end-to-end learning loop acceptance (spec §3.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as synth from '../mas/skill_synth.mjs';
import * as nudge from '../mas/nudge.mjs';
import { openIndex, indexSkill, closeIndex } from '../mas/index_db.mjs';
import * as recallTool from '../mas/tools/recall.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-e2e-'));
}

function anthropicReply(text) {
  return async (_url, _init) => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  });
}

test('e2e: task done → SKILL.md created with v5 frontmatter', async () => {
  const dir = tmpDir();
  const out = await synth.synthesizeSkill({
    agent: { provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't1', title: 'normalise imports', turns: [{ agent: 'user', text: 'sort imports' }, { agent: 'assistant', text: 'done' }] },
    outcome: 'done',
    trainedBy: 'claude-cli',
    trainedOnModel: 'claude-haiku-4-5',
    trajectoryRef: 'TRJ01',
    confidence: 0.81,
    apiKey: 'k',
    fetchImpl: anthropicReply(
      'name: sort-imports\n' +
      'description: Sort ESM imports deterministically.\n\n' +
      '## When to Use\n- new .mjs file\n\n' +
      '## Procedure\n1. read file\n2. sort\n3. write\n\n' +
      '## Pitfalls\n- side-effect imports first\n\n' +
      '## Verification\n- npm test\n'
    ),
  });
  assert.ok(out, 'expected non-null synth');
  const installed = synth.installSynthesized({
    name: out.name, description: out.description, body: out.body, sourceTask: 't1',
  }, dir);
  const doc = fs.readFileSync(installed.path, 'utf8');
  assert.ok(doc.includes('name: sort-imports'), doc);
});

test('e2e: failed task → anti-pattern skill tagged group: anti-pattern', async () => {
  const out = await synth.synthesizeSkill({
    agent: { provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't2', title: 'rename loop', turns: [{ agent: 'user', text: 'rename foo' }] },
    outcome: 'failed',
    trainedBy: 'codex-cli',
    trainedOnModel: 'gpt-5-codex',
    apiKey: 'k',
    fetchImpl: anthropicReply(
      'name: avoid-rename-loop\n' +
      'description: Do not retry rename without checking existence.\n\n' +
      '## What Failed\n- looped\n\n## Why\n- target existed\n\n## Avoid\n- check first\n'
    ),
  });
  assert.ok(out, 'expected non-null synth');
  assert.ok(out.doc.includes('anti_pattern: true'), out.doc);
  assert.ok(out.doc.includes('group: anti-pattern'), out.doc);
});

test('e2e: nudge cluster surfaces as SSE event', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'recent.jsonl'), [
    JSON.stringify({ ts: 1, role: 'user', content: 'check ci status' }),
    JSON.stringify({ ts: 2, role: 'user', content: 'check ci status' }),
    JSON.stringify({ ts: 3, role: 'user', content: 'check CI status' }),
  ].join('\n'));
  const events = [];
  const loop = nudge.startNudgeLoop({ configDir: dir, intervalMs: 99999, minCount: 3, emit: (e) => events.push(e) });
  loop.runOnce();
  loop.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'nudge.suggest_skill');
  assert.equal(events[0].cluster.count, 3);
});

test('e2e: cross-CLI recall — codex-cli query finds claude-cli skill', async () => {
  const dir = tmpDir();
  openIndex(dir);
  indexSkill({
    skill_name: 'sort-imports',
    trained_by: 'claude-cli',
    group_name: 'dev',
    content: 'Sort ESM imports deterministically; side-effect imports first.',
  }, dir);
  const out = await recallTool.exec({ query: 'sort imports', scope: ['skills'], k: 5 }, { configDir: dir });
  assert.equal(out.ok, true);
  assert.ok(out.hits.length > 0, `expected hits, got ${out.hits.length}`);
  const skillHit = out.hits.find((h) => h.scope === 'skills');
  assert.ok(skillHit, 'expected a skills hit');
  assert.ok(JSON.stringify(skillHit).includes('claude-cli'), `metadata must expose trained_by: ${JSON.stringify(skillHit)}`);
  closeIndex(dir);
});
