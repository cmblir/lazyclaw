import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerAgent, patchAgent, getAgent, AgentError } from '../agents.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-avatar-')); }
const CLI = new URL('../cli.mjs', import.meta.url).pathname;

// A user wants to CHOOSE which of the 20 built-in pixel-banner sprites an agent
// shows in the Team Live dashboard, instead of relying on the keyword-inferred
// default. dashboard.js already renders rec.avatar (1..20) first — but nothing
// ever wrote it. These tests pin the missing registry side.

test('avatar defaults to null (keyword inference) for a fresh agent', () => {
  const d = tmp();
  const a = registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  assert.equal(a.avatar, null);
  assert.equal(getAgent('backend', d).avatar, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('registerAgent stores an explicit avatar sprite index (1..20)', () => {
  const d = tmp();
  const a = registerAgent({ name: 'backend', provider: 'claude-cli', avatar: 7 }, d);
  assert.equal(a.avatar, 7);
  assert.equal(getAgent('backend', d).avatar, 7);
  fs.rmSync(d, { recursive: true, force: true });
});

test('registerAgent coerces a numeric-string avatar and rejects out-of-range / non-numeric', () => {
  const d = tmp();
  assert.equal(registerAgent({ name: 'ok', avatar: '12' }, d).avatar, 12);
  assert.throws(() => registerAgent({ name: 'lo', avatar: 0 }, d), (e) => e instanceof AgentError && e.code === 'AGENT_BAD_AVATAR');
  assert.throws(() => registerAgent({ name: 'hi', avatar: 21 }, d), /avatar/i);
  assert.throws(() => registerAgent({ name: 'nan', avatar: 'nope' }, d), /avatar/i);
  assert.throws(() => registerAgent({ name: 'frac', avatar: 3.5 }, d), /avatar/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('patchAgent sets the avatar and clears it back to inference with null', () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  assert.equal(patchAgent('backend', { avatar: 12 }, d).avatar, 12);
  assert.equal(getAgent('backend', d).avatar, 12);
  assert.equal(patchAgent('backend', { avatar: null }, d).avatar, null);
  assert.equal(getAgent('backend', d).avatar, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('patchAgent rejects an out-of-range avatar', () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  assert.throws(() => patchAgent('backend', { avatar: 99 }, d), /avatar/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI: agent set-avatar <name> <N> persists the chosen sprite', () => {
  const d = tmp();
  const run = (args) => spawnSync('node', [CLI, ...args], { env: { ...process.env, POMPOS_CONFIG_DIR: d }, encoding: 'utf8' });
  assert.equal(run(['agent', 'add', 'backend', '--provider', 'claude-cli']).status, 0);
  const r = run(['agent', 'set-avatar', 'backend', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(getAgent('backend', d).avatar, 5);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI: agent set-avatar <name> none clears back to inference', () => {
  const d = tmp();
  const run = (args) => spawnSync('node', [CLI, ...args], { env: { ...process.env, POMPOS_CONFIG_DIR: d }, encoding: 'utf8' });
  run(['agent', 'add', 'backend', '--provider', 'claude-cli']);
  run(['agent', 'set-avatar', 'backend', '9']);
  assert.equal(getAgent('backend', d).avatar, 9);
  const r = run(['agent', 'set-avatar', 'backend', 'none']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(getAgent('backend', d).avatar, null);
  fs.rmSync(d, { recursive: true, force: true });
});
