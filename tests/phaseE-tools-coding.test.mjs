import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as coding from '../mas/tools/coding.mjs';

test('exports 5 coding tools', () => {
  const names = coding.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['http_request', 'node_exec', 'python_exec', 'regex_match', 'sql_query']);
});

test('regex_match returns matches', async () => {
  const t = coding.TOOLS.find(t => t.name === 'regex_match');
  const r = await t.exec({ pattern: '\\d+', text: 'a1 b22 c333', flags: 'g' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.matches, ['1', '22', '333']);
});

test('node_exec runs a script', async () => {
  const t = coding.TOOLS.find(t => t.name === 'node_exec');
  const r = await t.exec({ code: 'console.log(1+1)' });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /2/);
});

test('python_exec gracefully reports missing interpreter', async () => {
  const t = coding.TOOLS.find(t => t.name === 'python_exec');
  const r = await t.exec({ code: 'print(1)' }, { python: '/no/such/python' });
  assert.equal(r.ok, false);
});

test('sql_query rejects when no db engine bound', async () => {
  const t = coding.TOOLS.find(t => t.name === 'sql_query');
  const r = await t.exec({ sql: 'SELECT 1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no database/i);
});

test('http_request reuses web_fetch SSRF policy', async () => {
  const t = coding.TOOLS.find(t => t.name === 'http_request');
  const r = await t.exec({ url: 'http://127.0.0.1/x', method: 'GET' });
  assert.equal(r.ok, false);
});
