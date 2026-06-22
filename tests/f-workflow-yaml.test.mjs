// tests/f-workflow-yaml.test.mjs
//
// Roadmap B-4 — author a declarative workflow in YAML without adding a YAML
// dependency. workflow/yaml_min.mjs parses the subset a workflow def needs
// (block maps, sequences of maps, scalars, inline JSON, block scalars) and
// errors clearly on anything unsupported (never silently wrong).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlMin } from '../workflow/yaml_min.mjs';
import { parseWorkflowYaml, runWorkflow } from '../workflow/declarative.mjs';

test('parses a nested workflow def (sequence of mappings + nested config)', () => {
  const def = parseYamlMin(`name: weekly
nodes:
  - id: topic
    type: set
    config:
      value: the report
  - id: draft
    type: llm
    config:
      prompt: write {{topic}}
  - id: reply
    type: template
    config:
      text: "DONE: {{draft}}"
`);
  assert.equal(def.name, 'weekly');
  assert.equal(def.nodes.length, 3);
  assert.equal(def.nodes[0].id, 'topic');
  assert.equal(def.nodes[0].config.value, 'the report');
  assert.equal(def.nodes[1].type, 'llm');
  assert.equal(def.nodes[2].config.text, 'DONE: {{draft}}');
});

test('scalars: numbers, booleans, null, inline JSON, and a block scalar', () => {
  const def = parseYamlMin(`n: 42
b: true
z: null
arr: [1, 2, 3]
obj: {"k": "v"}
text: |
  line one
  line two
`);
  assert.equal(def.n, 42);
  assert.equal(def.b, true);
  assert.equal(def.z, null);
  assert.deepEqual(def.arr, [1, 2, 3]);
  assert.deepEqual(def.obj, { k: 'v' });
  assert.equal(def.text, 'line one\nline two');
});

test('parseWorkflowYaml validates + runs identically to JSON', async () => {
  const def = await parseWorkflowYaml(`nodes:
  - id: who
    type: set
    config:
      value: world
  - id: msg
    type: template
    config:
      text: hi {{who}}
`);
  const r = await runWorkflow(def);
  assert.equal(r.success, true);
  assert.equal(r.session.msg, 'hi world');
});

test('tabs are rejected and invalid inline JSON errors clearly (no silent guess)', () => {
  assert.throws(() => parseYamlMin('a:\n\t- x'), /tabs/);
  assert.throws(() => parseYamlMin('a: [1, 2'), /invalid inline JSON/);
});

test('parseWorkflowYaml maps a malformed def to a WF_ error', async () => {
  await assert.rejects(() => parseWorkflowYaml('foo: bar'), (e) => String(e.code).startsWith('WF_'));
});
