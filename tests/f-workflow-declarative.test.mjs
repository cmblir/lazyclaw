// tests/f-workflow-declarative.test.mjs
//
// Declarative workflows (roadmap #5): author a workflow as DATA (nodes + types
// + config) instead of hand-written .mjs, compiled onto the existing executor.
// Data flows between nodes by {{ref}}; side-effecting node types are injected
// via caps so the runner decides what a workflow may do (capability injection).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, compileWorkflow, runWorkflow, WorkflowError } from '../workflow/declarative.mjs';

test('a linear workflow runs and threads outputs by {{ref}}', async () => {
  const def = {
    name: 'greet',
    nodes: [
      { id: 'who', type: 'set', config: { value: 'world' } },
      { id: 'msg', type: 'template', config: { text: 'hello {{who}}!' } },
    ],
  };
  const r = await runWorkflow(def);
  assert.equal(r.success, true);
  assert.equal(r.session.who, 'world');
  assert.equal(r.session.msg, 'hello world!');
});

test('{{ref}} resolves nested fields and whole-value (non-string) refs', async () => {
  const def = {
    nodes: [
      { id: 'user', type: 'set', config: { value: { name: 'Ada', age: 36 } } },
      { id: 'name', type: 'template', config: { text: 'name is {{user.name}}' } },
      { id: 'copy', type: 'set', config: { value: '{{user}}' } }, // whole-value → raw object
    ],
  };
  const r = await runWorkflow(def);
  assert.equal(r.session.name, 'name is Ada');
  assert.deepEqual(r.session.copy, { name: 'Ada', age: 36 });
});

test('an injected (caps) node type can do real work and is referenced like any node', async () => {
  const calls = [];
  const caps = {
    nodeTypes: {
      upper: (cfg) => { calls.push(cfg.text); return String(cfg.text).toUpperCase(); },
    },
  };
  const def = {
    nodes: [
      { id: 'a', type: 'set', config: { value: 'hi' } },
      { id: 'b', type: 'upper', config: { text: '{{a}}' } },
    ],
  };
  const r = await runWorkflow(def, { caps });
  assert.equal(r.session.b, 'HI');
  assert.deepEqual(calls, ['hi']);
});

test('parseWorkflow rejects invalid JSON, missing nodes, dup ids, and missing type', () => {
  assert.throws(() => parseWorkflow('{not json'), /invalid workflow JSON/);
  assert.throws(() => parseWorkflow('{}'), /non-empty nodes/);
  assert.throws(() => parseWorkflow(JSON.stringify({ nodes: [{ id: 'x', type: 'set' }, { id: 'x', type: 'set' }] })), /duplicate node id/);
  assert.throws(() => parseWorkflow(JSON.stringify({ nodes: [{ id: 'x' }] })), /needs a type/);
});

test('compileWorkflow rejects an unknown node type', () => {
  const def = { nodes: [{ id: 'x', type: 'doesNotExist', config: {} }] };
  assert.throws(() => compileWorkflow(def), (e) => e instanceof WorkflowError && e.code === 'WF_UNKNOWN_TYPE');
});

test('a failing node stops the workflow and reports failedAt', async () => {
  const caps = { nodeTypes: { boom: () => { throw new Error('kaboom'); } } };
  const def = {
    nodes: [
      { id: 'ok', type: 'set', config: { value: 1 } },
      { id: 'bad', type: 'boom', config: {} },
      { id: 'never', type: 'set', config: { value: 2 } },
    ],
  };
  const r = await runWorkflow(def, { caps });
  assert.equal(r.success, false);
  assert.equal(r.failedAt, 'bad');
  assert.match(r.error.message, /kaboom/);
});
