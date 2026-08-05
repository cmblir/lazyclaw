// tests/f-dashboard-asset-cache.test.mjs
//
// The dashboard's static assets (HTML/CSS/JS + 20 avatar PNGs) were re-read
// from disk with a synchronous fs.readFileSync on EVERY request — each GET
// blocked the event loop reading the whole file body. These pin that assets
// are served from an mtime-keyed in-memory cache: read once per unchanged
// file, and a dev edit (mtime bump) still busts it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _readAssetCached, _clearAssetCache, dashboardCss, uiModule } from '../daemon/routes/meta.mjs';

test('_readAssetCached reads a file once until its mtime changes', () => {
  _clearAssetCache();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-asset-'));
  const f = path.join(d, 'a.bin');
  fs.writeFileSync(f, 'one');
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => { if (p === f) reads++; return real(p, ...rest); };
  try {
    assert.equal(String(_readAssetCached(f)), 'one');
    assert.equal(String(_readAssetCached(f)), 'one');
    assert.equal(reads, 1, 'cached: read once across two calls');
    fs.writeFileSync(f, 'two');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(f, future, future);
    assert.equal(String(_readAssetCached(f)), 'two', 'mtime bump busts the cache');
    assert.equal(reads, 2);
  } finally {
    fs.readFileSync = real;
  }
});

test('dashboardCss serves from the asset cache (one disk read across requests)', async () => {
  _clearAssetCache();
  const real = fs.readFileSync;
  let cssReads = 0;
  fs.readFileSync = (p, ...rest) => { if (String(p).endsWith('dashboard.css')) cssReads++; return real(p, ...rest); };
  const mkRes = () => {
    const r = {};
    r.writeHead = (code, headers) => { r.code = code; r.head = headers; };
    r.end = (body) => { r.ended = body; };
    return r;
  };
  try {
    const r1 = mkRes(); await dashboardCss({ res: r1 });
    const r2 = mkRes(); await dashboardCss({ res: r2 });
    assert.equal(r1.code, 200);
    assert.equal(r2.code, 200);
    assert.ok(r1.ended && r1.ended.length > 0);
    assert.equal(cssReads, 1, 'dashboard.css must be read from disk once across two requests');
  } finally {
    fs.readFileSync = real;
  }
});

// meta.mjs does not export a cache-reset seam (only _clearAssetCache, already
// imported above), so this mirrors the dashboardCss case directly rather than
// resetting through a name that doesn't exist.
test('uiModule serves from the asset cache (one disk read across requests)', async () => {
  _clearAssetCache();
  const real = fs.readFileSync;
  let domReads = 0;
  fs.readFileSync = (p, ...rest) => { if (String(p).endsWith('dom.mjs')) domReads++; return real(p, ...rest); };
  const mkRes = () => {
    const r = {};
    r.writeHead = (code, headers) => { r.code = code; r.head = headers; };
    r.end = (body) => { r.ended = body; };
    return r;
  };
  try {
    const r1 = mkRes(); await uiModule({ req: { method: 'GET' }, res: r1, path: '/ui/dom.mjs' });
    const r2 = mkRes(); await uiModule({ req: { method: 'GET' }, res: r2, path: '/ui/dom.mjs' });
    assert.equal(r1.code, 200);
    assert.equal(r2.code, 200);
    assert.ok(r1.ended && r1.ended.length > 0);
    assert.equal(domReads, 1, 'ui/dom.mjs must be read from disk once across two requests');
  } finally {
    fs.readFileSync = real;
  }
});
