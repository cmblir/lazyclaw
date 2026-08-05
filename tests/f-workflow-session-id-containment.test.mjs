// tests/f-workflow-session-id-containment.test.mjs — statePath() is the single
// choke point every workflow-state read and write goes through, and it must
// refuse a sessionId that would land outside the state dir.
//
// Why this matters: `POST /workflows/run` reads `body.sessionId` straight out of
// a JSON request body. The `/workflows/:id` routes get their id from a URL
// matcher that already rejects `..` and `/`, but the run route has no such
// matcher, so before this guard a sessionId of `../../../../tmp/pwned` made
// saveState write attacker-influenced JSON anywhere the daemon user could write.
// It needs the daemon token, but a token holder should not thereby gain an
// arbitrary-file-write primitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statePath, saveState } from '../workflow/persistent.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wf-contain-'));
}

test('a plain sessionId resolves inside the state dir', () => {
  const dir = tmpDir();
  const p = statePath('sess_abc123', dir);
  assert.equal(p, path.join(dir, 'sess_abc123.json'));
  assert.ok(path.resolve(p).startsWith(path.resolve(dir) + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('traversal out of the state dir is refused, however it is spelled', () => {
  const dir = tmpDir();
  const escapes = [
    '../pwned',
    '../../pwned',
    '../../../../tmp/pwned',
    'sub/../../pwned',
    './../pwned',
  ];
  for (const id of escapes) {
    assert.throws(() => statePath(id, dir), (e) => {
      assert.equal(e.code, 'WF_BAD_SESSION_ID', `${id} must be refused with a WF_ code`);
      // daemon/routes/workflows.mjs maps WF_-prefixed codes to 400, so the code
      // prefix is what makes this a client error rather than a 500.
      assert.ok(String(e.code).startsWith('WF_'));
      return true;
    }, `sessionId ${JSON.stringify(id)} escaped the state dir`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a sibling directory sharing the prefix is not "inside" the state dir', () => {
  // /state-evil must not pass as being under /state — this is why the check
  // appends the separator before comparing.
  const base = tmpDir();
  const dir = path.join(base, 'state');
  fs.mkdirSync(dir);
  assert.throws(() => statePath('../state-evil/pwned', dir), (e) => e.code === 'WF_BAD_SESSION_ID');
  fs.rmSync(base, { recursive: true, force: true });
});

test('an empty or NUL-bearing sessionId is refused', () => {
  const dir = tmpDir();
  for (const id of ['', 'a\0b']) {
    assert.throws(() => statePath(id, dir), (e) => e.code === 'WF_BAD_SESSION_ID',
      `sessionId ${JSON.stringify(id)} must be refused`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an absolute-looking sessionId stays inside rather than escaping', () => {
  // path.join does not let a leading slash override the base (that is resolve),
  // so this lands inside and is allowed — asserted so the behaviour is pinned
  // rather than assumed.
  const dir = tmpDir();
  const p = statePath('/etc/passwd', dir);
  assert.ok(path.resolve(p).startsWith(path.resolve(dir) + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState cannot write outside the state dir — the end-to-end property', () => {
  const base = tmpDir();
  const dir = path.join(base, 'state');
  fs.mkdirSync(dir);
  const outside = path.join(base, 'pwned.json');

  assert.throws(
    () => saveState({ sessionId: '../pwned', nodes: {}, status: 'running' }, dir),
    (e) => e.code === 'WF_BAD_SESSION_ID',
  );
  assert.equal(fs.existsSync(outside), false, 'nothing may be written outside the state dir');

  fs.rmSync(base, { recursive: true, force: true });
});
