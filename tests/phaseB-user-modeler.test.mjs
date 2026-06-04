// Phase B: user_modeler — dialectic USER.md updater (spec §4.10, §0.1 C6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userModelPath, updateUserModel } from '../mas/user_modeler.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-um-'));
}

test('userModelPath: resolves under <configDir>/memory/USER.md', () => {
  const d = tmpDir();
  assert.equal(userModelPath(d), path.join(d, 'memory', 'USER.md'));
});

test('updateUserModel: writes USER.md with thesis/antithesis/synthesis sections', async () => {
  const dir = tmpDir();
  const fakeFetch = async (_url, _init) => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text:
        '## Thesis\n- user prefers atomic commits\n\n' +
        '## Antithesis\n- but they also pushed a 12-file commit Tuesday\n\n' +
        '## Synthesis\n- atomic for code, batched for docs\n' }],
    }),
  });
  const res = await updateUserModel({
    sessionTurns: [
      { role: 'user', content: 'split that into atomic commits' },
      { role: 'assistant', content: 'ok' },
    ],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'k',
    fetchImpl: fakeFetch,
    configDir: dir,
  });
  assert.equal(res.path, path.join(dir, 'memory', 'USER.md'));
  const body = fs.readFileSync(res.path, 'utf8');
  assert.ok(body.includes('## Thesis'), body);
  assert.ok(body.includes('## Antithesis'), body);
  assert.ok(body.includes('## Synthesis'), body);
});

test('updateUserModel: no-ops when transcript is empty', async () => {
  const dir = tmpDir();
  const res = await updateUserModel({
    sessionTurns: [],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'k',
    fetchImpl: (async () => { throw new Error('should not be called'); }),
    configDir: dir,
  });
  assert.equal(res, null);
});
