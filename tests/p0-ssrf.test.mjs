// P0 security — SSRF guard covers literal private/loopback/metadata targets
// for both web_fetch (export) and browser_navigate. All assertions use
// literal IPs / bad schemes so they resolve without network/DNS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl, isPrivateAddr } from '../mas/tools/web.mjs';
import * as browser from '../mas/tools/browser.mjs';

test('isPrivateAddr classifies v4 and v6 private/loopback', () => {
  for (const a of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254',
                   '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddr(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddr(a), false, a);
  }
});

test('isSafeUrl blocks loopback, RFC1918, link-local metadata, bad scheme, IPv6 loopback', async () => {
  for (const u of [
    'http://127.0.0.1/secret',
    'http://localhost/',
    'http://0.0.0.0/',
    'http://169.254.169.254/latest/meta-data/',  // cloud metadata
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'file:///etc/passwd',
    'ftp://example.com/',
  ]) {
    const r = await isSafeUrl(u);
    assert.equal(r.ok, false, `must block ${u}`);
  }
});

test('browser_navigate refuses a metadata/private URL before launching Chromium', async () => {
  let navigated = null;
  browser.__setBrowserBackend({ navigate: async (u) => { navigated = u; return { url: u, title: 't' }; } });
  try {
    const nav = browser.TOOLS.find((t) => t.name === 'browser_navigate');
    const r = await nav.exec({ url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(r.ok, false);
    assert.match(r.error, /SSRF|private|loopback/i);
    assert.equal(navigated, null, 'must not navigate to a private URL');
  } finally {
    browser.__setBrowserBackend(null);
  }
});
