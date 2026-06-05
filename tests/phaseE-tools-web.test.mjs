import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as web from '../mas/tools/web.mjs';

test('exports 3 web tools', () => {
  const names = web.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['url_extract', 'web_fetch', 'web_search']);
});

test('web_fetch blocks loopback (SSRF)', async () => {
  const wf = web.TOOLS.find(t => t.name === 'web_fetch');
  const r = await wf.exec({ url: 'http://127.0.0.1:8080/secret' });
  assert.equal(r.ok, false);
  assert.match(r.error, /SSRF|private|loopback/i);
});

test('web_fetch blocks file://', async () => {
  const wf = web.TOOLS.find(t => t.name === 'web_fetch');
  const r = await wf.exec({ url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
});

test('web_search returns disabled-message when no provider key', async () => {
  const ws = web.TOOLS.find(t => t.name === 'web_search');
  const r = await ws.exec({ query: 'hello' }, { env: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /no provider configured/i);
});

test('url_extract pulls links from HTML', async () => {
  const ue = web.TOOLS.find(t => t.name === 'url_extract');
  const r = await ue.exec({ html: '<a href="https://a.com/x">a</a><a href="/rel">b</a>' });
  assert.equal(r.ok, true);
  assert.ok(r.urls.includes('https://a.com/x'));
});

test('sensitivity matrix', () => {
  const m = Object.fromEntries(web.TOOLS.map(t => [t.name, t.sensitive]));
  assert.equal(m.web_fetch, true);
  assert.equal(m.web_search, false);
  assert.equal(m.url_extract, false);
});
