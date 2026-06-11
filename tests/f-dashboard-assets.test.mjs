// tests/f-dashboard-assets.test.mjs — the dashboard HTML must reference its
// CSS/JS by ABSOLUTE path. The daemon serves the page at /, /dashboard, and
// /dashboard/; a relative href resolves to /dashboard/dashboard.css under the
// trailing-slash URL and 404s, leaving the page unstyled with every tab stuck
// on "Loading…" (both static assets fail to load). Guard against regressing to
// relative refs, and against dropping the trailing-slash route.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('dashboard.html references CSS/JS by absolute path', () => {
  const html = readFileSync(join(root, 'web/dashboard.html'), 'utf8');
  assert.match(html, /<link[^>]+href="\/dashboard\.css"/, 'CSS href must be absolute (/dashboard.css)');
  assert.match(html, /<script[^>]+src="\/dashboard\.js"/, 'JS src must be absolute (/dashboard.js)');
  // No relative asset refs that would break under the /dashboard/ URL.
  assert.doesNotMatch(html, /href="dashboard\.css"/, 'no relative CSS href');
  assert.doesNotMatch(html, /src="dashboard\.js"/, 'no relative JS src');
});

test('daemon serves the dashboard at the trailing-slash URL too', () => {
  const rt = readFileSync(join(root, 'daemon/route_table.mjs'), 'utf8');
  assert.match(rt, /GET \/dashboard\//, 'route table must match GET /dashboard/');
});
