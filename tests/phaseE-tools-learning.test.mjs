import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as learning from '../mas/tools/learning.mjs';

function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-learn-'));
  fs.mkdirSync(path.join(d, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
  return d;
}

test('exports 7 learning tools', () => {
  const names = learning.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['memory_read','memory_write','skill_create','skill_edit','skill_view','user_update','user_view']);
});

test('skill_create writes to the canonical flat skill store and skill_view reads it back', async () => {
  const home = tmpHome();
  const sc = learning.TOOLS.find(t => t.name === 'skill_create');
  const r = await sc.exec({ name: 'demo-skill', body: 'Do the thing.' }, { configDir: home });
  assert.equal(r.ok, true);
  // Canonical layout is flat `skills/<name>.md` (skills.mjs / skill_synth /
  // curator all use it); the agent tools must share that store, not a
  // private `skills/<name>/SKILL.md` directory only they can see.
  assert.ok(fs.existsSync(path.join(home, 'skills', 'demo-skill.md')));
  const sv = learning.TOOLS.find(t => t.name === 'skill_view');
  const v = await sv.exec({ name: 'demo-skill' }, { configDir: home });
  assert.equal(v.ok, true);
  assert.match(v.content, /Do the thing\./);
});

test('memory_write appends recent.jsonl line', async () => {
  const home = tmpHome();
  const mw = learning.TOOLS.find(t => t.name === 'memory_write');
  const r = await mw.exec({ kind: 'recent', content: 'note one' }, { configDir: home });
  assert.equal(r.ok, true);
  const out = fs.readFileSync(path.join(home, 'memory', 'recent.jsonl'), 'utf8').trim();
  assert.match(out, /note one/);
});

test('user_view returns USER.md content (or empty)', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'memory', 'USER.md'), '# user notes');
  const uv = learning.TOOLS.find(t => t.name === 'user_view');
  const r = await uv.exec({}, { configDir: home });
  assert.equal(r.ok, true);
  assert.match(r.content, /user notes/);
});

test('user_update overwrites USER.md', async () => {
  const home = tmpHome();
  const uu = learning.TOOLS.find(t => t.name === 'user_update');
  const r = await uu.exec({ content: '# new' }, { configDir: home });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(home, 'memory', 'USER.md'), 'utf8'), '# new');
});

test('sensitivity matrix', () => {
  const want = {
    skill_view: false, skill_create: true, skill_edit: true,
    memory_write: true, memory_read: false,
    user_view: false, user_update: true,
  };
  for (const t of learning.TOOLS) assert.equal(t.sensitive, want[t.name], `${t.name}.sensitive`);
});
