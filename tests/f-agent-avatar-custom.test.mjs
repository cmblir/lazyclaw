import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerAgent, patchAgent, getAgent, setAgentAvatarImage, AgentError } from '../agents.mjs';
import * as meta from '../daemon/routes/meta.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-cavatar-')); }
const CLI = new URL('../cli.mjs', import.meta.url).pathname;

// A 1x1 PNG (valid signature) written to disk to stand in for "a photo the user
// gave us".
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636060600000000400015a2bff0000000049454e44ae426082', 'hex');

function writePng(dir, name = 'photo.png') { const p = path.join(dir, name); fs.writeFileSync(p, PNG_1x1); return p; }

test('avatarImage defaults to null for a fresh agent', () => {
  const d = tmp();
  const a = registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  assert.equal(a.avatarImage, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('setAgentAvatarImage with a URL stores it verbatim as the img src', () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  const a = setAgentAvatarImage('backend', 'https://example.com/muzi.png', d);
  assert.equal(a.avatarImage, 'https://example.com/muzi.png');
  assert.equal(getAgent('backend', d).avatarImage, 'https://example.com/muzi.png');
  fs.rmSync(d, { recursive: true, force: true });
});

test('setAgentAvatarImage with a local file copies it into the config dir and stores a served path', () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  const src = writePng(d);
  const a = setAgentAvatarImage('backend', src, d);
  assert.equal(a.avatarImage, '/agent-avatars/backend.png');
  // the file was copied into <configDir>/agent-avatars/
  const copied = path.join(d, 'agent-avatars', 'backend.png');
  assert.ok(fs.existsSync(copied), 'image copied into config dir');
  assert.deepEqual(fs.readFileSync(copied), PNG_1x1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('setAgentAvatarImage rejects a missing file or unsupported type', () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  assert.throws(() => setAgentAvatarImage('backend', '/nope/missing.png', d), (e) => e instanceof AgentError && e.code === 'AGENT_BAD_AVATAR_IMAGE');
  const bad = path.join(d, 'notes.txt'); fs.writeFileSync(bad, 'x');
  assert.throws(() => setAgentAvatarImage('backend', bad, d), /unsupported|image/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('patchAgent clears avatarImage with null', () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  setAgentAvatarImage('backend', 'https://x/y.png', d);
  assert.equal(patchAgent('backend', { avatarImage: null }, d).avatarImage, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI: agent set-avatar <name> <url> sets a custom image; <N> switches back to a sprite', () => {
  const d = tmp();
  const run = (args) => spawnSync('node', [CLI, ...args], { env: { ...process.env, LAZYCLAW_CONFIG_DIR: d }, encoding: 'utf8' });
  run(['agent', 'add', 'backend', '--provider', 'claude-cli']);
  assert.equal(run(['agent', 'set-avatar', 'backend', 'https://example.com/muzi.png']).status, 0);
  assert.equal(getAgent('backend', d).avatarImage, 'https://example.com/muzi.png');
  // picking a numeric sprite clears the custom image
  assert.equal(run(['agent', 'set-avatar', 'backend', '5']).status, 0);
  assert.equal(getAgent('backend', d).avatar, 5);
  assert.equal(getAgent('backend', d).avatarImage, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('daemon agentAvatar serves a stored custom image (200 + content-type) and 404s missing / traversal', async () => {
  const d = tmp();
  registerAgent({ name: 'backend', provider: 'claude-cli' }, d);
  setAgentAvatarImage('backend', writePng(d), d);
  meta._clearAssetCache?.();
  const call = async (p) => {
    const res = { code: 0, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
    await meta.agentAvatar({ path: p, gwConfigDir: d, res, req: { method: 'GET' } });
    return res;
  };
  const ok = await call('/agent-avatars/backend.png');
  assert.equal(ok.code, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.deepEqual(ok.body, PNG_1x1);
  assert.equal((await call('/agent-avatars/ghost.png')).code, 404);
  assert.equal((await call('/agent-avatars/..%2fconfig.json')).code, 404);
  fs.rmSync(d, { recursive: true, force: true });
});
