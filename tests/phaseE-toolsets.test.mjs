import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as toolsets from '../mas/toolsets.mjs';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-ts-'));
}

test('built-in toolsets exist', () => {
  const all = toolsets.listToolsets();
  assert.ok(all.find(t => t.name === 'coding-min'));
  assert.ok(all.find(t => t.name === 'web-research'));
  assert.ok(all.find(t => t.name === 'devops'));
});

test('resolveToolset returns flat tool names', () => {
  const tools = toolsets.resolveToolset('coding-min');
  assert.ok(Array.isArray(tools));
  assert.ok(tools.includes('bash'));
  assert.ok(tools.includes('read'));
  assert.ok(tools.includes('write'));
  assert.ok(tools.includes('edit'));
});

test('addToolset persists to config dir', () => {
  const home = tmpHome();
  toolsets.addToolset({ name: 'my-set', tools: ['read', 'grep'] }, { configDir: home });
  const data = JSON.parse(fs.readFileSync(path.join(home, 'toolsets.json'), 'utf8'));
  assert.equal(data['my-set'].tools.length, 2);
});

test('removeToolset deletes', () => {
  const home = tmpHome();
  toolsets.addToolset({ name: 'temp', tools: ['read'] }, { configDir: home });
  toolsets.removeToolset('temp', { configDir: home });
  const data = JSON.parse(fs.readFileSync(path.join(home, 'toolsets.json'), 'utf8'));
  assert.equal(data['temp'], undefined);
});

test('resolveToolset rejects unknown names', () => {
  assert.throws(() => toolsets.resolveToolset('nope_xyz'));
});
