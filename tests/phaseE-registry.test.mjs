import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../mas/tools/registry.mjs';

test('registry exposes built-in groups', () => {
  const all = registry.listAll();
  assert.ok(Array.isArray(all));
  const names = all.map(t => t.name);
  assert.ok(names.includes('bash'));
  assert.ok(names.includes('read'));
  assert.ok(names.includes('write'));
  assert.ok(names.includes('grep'));
  assert.ok(names.includes('skill_view'));
});

test('registry.lookup returns shape {name,category,sensitive,description,parameters,exec}', () => {
  const t = registry.lookup('bash');
  assert.equal(t.name, 'bash');
  assert.equal(typeof t.exec, 'function');
  assert.equal(typeof t.description, 'string');
  assert.equal(typeof t.parameters, 'object');
  assert.equal(typeof t.sensitive, 'boolean');
  assert.equal(typeof t.category, 'string');
});

test('registry.lookup unknown -> null', () => {
  assert.equal(registry.lookup('nope_xyz'), null);
});

test('registry.byCategory groups tools', () => {
  const cats = registry.byCategory();
  assert.ok(cats.exec || cats.fs);
});
