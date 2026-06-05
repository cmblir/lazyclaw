import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as browser from '../mas/tools/browser.mjs';

test('exports 4 browser tools', () => {
  const names = browser.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['browser_back', 'browser_click', 'browser_navigate', 'browser_screenshot']);
});

test('all browser tools sensitive=true', () => {
  for (const t of browser.TOOLS) assert.equal(t.sensitive, true);
});

test('browser_navigate refuses non-http(s)', async () => {
  const t = browser.TOOLS.find(t => t.name === 'browser_navigate');
  const r = await t.exec({ url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
});

test('exec returns clear error when playwright not installed (stubbed)', async () => {
  browser.__setBrowserBackend({
    navigate: async () => { throw new Error('playwright not installed'); },
  });
  const t = browser.TOOLS.find(t => t.name === 'browser_navigate');
  const r = await t.exec({ url: 'https://example.com' });
  assert.equal(r.ok, false);
  browser.__setBrowserBackend(null);
});
