import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as edit from '../mas/tools/edit.mjs';
import * as patch from '../mas/tools/patch.mjs';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-edit-'));
  return d;
}

test('edit replaces exact occurrence', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello world\nfoo bar\n');
  const out = await edit.TOOL.exec({ path: 'a.txt', old: 'world', new: 'mars' }, { cwd: dir });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello mars\nfoo bar\n');
});

test('edit refuses when old not unique', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'b.txt');
  fs.writeFileSync(f, 'x\nx\n');
  const out = await edit.TOOL.exec({ path: 'b.txt', old: 'x', new: 'y' }, { cwd: dir });
  assert.equal(out.ok, false);
  assert.match(out.error, /not unique/);
});

test('edit refuses when old not found', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'c.txt'), 'abc');
  const out = await edit.TOOL.exec({ path: 'c.txt', old: 'zzz', new: 'q' }, { cwd: dir });
  assert.equal(out.ok, false);
  assert.match(out.error, /not found/);
});

test('patch applies a unified-diff hunk', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'd.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  const diff = [
    '--- a/d.txt',
    '+++ b/d.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '',
  ].join('\n');
  const out = await patch.TOOL.exec({ diff }, { cwd: dir });
  assert.equal(out.ok, true, out.error);
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\nTWO\nthree\n');
});

test('patch rejects mismatched context', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'e.txt'), 'aa\nbb\n');
  const diff = '--- a/e.txt\n+++ b/e.txt\n@@ -1,2 +1,2 @@\n-XX\n+YY\n bb\n';
  const out = await patch.TOOL.exec({ diff }, { cwd: dir });
  assert.equal(out.ok, false);
});

test('TOOL records expose v5 shape', () => {
  for (const T of [edit.TOOL, patch.TOOL]) {
    assert.equal(typeof T.name, 'string');
    assert.equal(typeof T.exec, 'function');
    assert.equal(T.category, 'fs');
    assert.equal(T.sensitive, true);
  }
});
