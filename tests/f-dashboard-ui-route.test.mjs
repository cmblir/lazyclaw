// tests/f-dashboard-ui-route.test.mjs — GET /ui/**.mjs serves the dashboard's
// ES modules through the same asset cache as dashboard.css, and refuses
// anything the auth allowlist would also refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsMod from 'node:fs';
import nodePath from 'node:path';
import * as meta from '../daemon/routes/meta.mjs';

function mockRes() {
  return {
    code: 0, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; },
    end(b) { this.body = b; },
  };
}

test('GET /ui/dom.mjs serves javascript', async () => {
  const res = mockRes();
  await meta.uiModule({ req: { method: 'GET' }, res, path: '/ui/dom.mjs' });
  assert.equal(res.code, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  assert.match(String(res.body), /export function el\(/);
});

test('GET /ui/panels/chat.mjs serves a nested module', async () => {
  // web/ui/panels/chat.mjs is Task 4's file and does not exist yet. Fake the
  // disk read (same monkey-patch pattern as f-dashboard-asset-cache.test.mjs)
  // so this case proves the route's nested-path handling — one optional
  // subdirectory — rather than depending on a file a later task owns.
  const nestedRel = nodePath.join('panels', 'chat.mjs');
  const realStat = fsMod.statSync;
  const realRead = fsMod.readFileSync;
  fsMod.statSync = (p, ...rest) => (String(p).endsWith(nestedRel) ? { mtimeMs: 1 } : realStat(p, ...rest));
  fsMod.readFileSync = (p, ...rest) => (String(p).endsWith(nestedRel) ? Buffer.from('export const nested = true;\n') : realRead(p, ...rest));
  try {
    const res = mockRes();
    await meta.uiModule({ req: { method: 'GET' }, res, path: '/ui/panels/chat.mjs' });
    assert.equal(res.code, 200);
  } finally {
    fsMod.statSync = realStat;
    fsMod.readFileSync = realRead;
  }
});

test('a traversal or bad shape is 404, never a file read', async () => {
  for (const p of ['/ui/../../package.json', '/ui/a/b/c.mjs', '/ui/Dom.mjs', '/ui/dom.js']) {
    const res = mockRes();
    await meta.uiModule({ req: { method: 'GET' }, res, path: p });
    assert.equal(res.code, 404, `${p} must be 404`);
  }
});

test('a missing but well-shaped module is 404', async () => {
  const res = mockRes();
  await meta.uiModule({ req: { method: 'GET' }, res, path: '/ui/does-not-exist.mjs' });
  assert.equal(res.code, 404);
});
