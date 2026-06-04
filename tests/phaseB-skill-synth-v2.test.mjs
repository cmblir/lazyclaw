// Phase B: skill_synth v2 — anti-pattern outcome + v5 frontmatter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSkillDoc, synthesizeSkill, installSynthesized } from '../mas/skill_synth.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-synth-v2-'));
}

test('assembleSkillDoc: emits trained_by/trained_on_model/trajectory_ref/confidence', () => {
  const doc = assembleSkillDoc({
    name: 'fix-flake', description: 'd', body: '## When to Use\n- x\n',
    createdBy: 'agent', sourceTask: 't1',
    trainedBy: 'claude-cli', trainedOnModel: 'claude-opus-4-7',
    trajectoryRef: '01HZW9KQ8N',
    confidence: 0.72,
    ts: new Date('2026-06-04T00:00:00Z'),
  });
  assert.ok(doc.includes('trained_by: claude-cli'), doc);
  assert.ok(doc.includes('trained_on_model: claude-opus-4-7'), doc);
  assert.ok(doc.includes('trajectory_ref: 01HZW9KQ8N'), doc);
  assert.ok(doc.includes('confidence: 0.72'), doc);
});

test('assembleSkillDoc: anti-pattern outcome sets anti_pattern: true and group: anti-pattern', () => {
  const doc = assembleSkillDoc({
    name: 'do-not-rename', description: 'pitfall', body: '## What Failed\n- x\n',
    outcome: 'failed', trainedBy: 'codex-cli', trainedOnModel: 'gpt-5-codex',
  });
  assert.ok(doc.includes('anti_pattern: true'), doc);
  assert.ok(doc.includes('group: anti-pattern'), doc);
});

test('synthesizeSkill: outcome="failed" uses anti-pattern prompt and tags doc', async () => {
  let observed = null;
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    observed = { system: body.system || '', userMessage: body.messages?.[0]?.content || '' };
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text:
          'name: avoid-rename-loop\n' +
          'description: A rename retry loop you must not repeat.\n\n' +
          '## What Failed\n- looped on rename\n\n' +
          '## Why\n- target existed\n\n' +
          '## Avoid\n- check existence first\n' }],
      }),
    };
  };
  const out = await synthesizeSkill({
    agent: { provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't9', title: 'rename foo', turns: [{ agent: 'user', text: 'rename' }] },
    outcome: 'failed',
    apiKey: 'k',
    fetchImpl: fakeFetch,
  });
  assert.ok(out, 'expected non-null synth result');
  assert.ok(out.doc.includes('anti_pattern: true'), out.doc);
  assert.ok(out.doc.includes('group: anti-pattern'), out.doc);
  assert.ok(observed.userMessage.includes('FAILED'), observed.userMessage);
});

test('installSynthesized: redacts secrets inside body and description at write time', () => {
  const dir = tmpDir();
  const res = installSynthesized({
    name: 'leaky',
    description: 'has sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    body: '## When to Use\nAPI key: sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n',
    sourceTask: 't0',
  }, dir);
  const written = fs.readFileSync(res.path, 'utf8');
  assert.ok(!/sk-X{20,}/.test(written), 'secret should be redacted');
  assert.ok(/REDACTED/.test(written), 'should contain REDACTED');
});
