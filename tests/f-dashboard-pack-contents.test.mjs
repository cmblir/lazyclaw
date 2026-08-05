// tests/f-dashboard-pack-contents.test.mjs — the browser fetches every panel
// and shared module in web/ui/ (and every avatar in web/avatars/) by URL at
// runtime, via ABSOLUTE '/ui/...' specifiers in web/dashboard.js. Those don't
// match scripts/check-pack.mjs's relative-import regex (`\.{1,2}\/...`), so
// `npm run lint:pack` never actually traces them — it only verifies that an
// already-packed file's *relative* import resolves to another packed file. If
// `package.json` `files` ever stopped covering web/ui/** or web/avatars/**,
// that gate would stay green while a real install 404s every panel with no
// fallback (the page just dies). This test closes that blind spot directly:
// it asks npm what it would actually publish and diffs it against the real
// directory contents, independent of any import graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

function packedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const arr = JSON.parse(raw);
  return new Set((arr[0]?.files || []).map((f) => f.path.split(path.sep).join('/')));
}

test('every web/ui/**.mjs file (panels + shared) is in the published tarball', () => {
  const packed = packedFiles();
  const onDisk = walk(path.join(root, 'web/ui')).filter((f) => f.endsWith('.mjs'));
  assert.ok(onDisk.length > 0, 'expected at least one web/ui/*.mjs on disk');
  const missing = onDisk.filter((f) => !packed.has(f));
  assert.deepEqual(missing, [], `these web/ui files are on disk but NOT in the tarball: ${missing.join(', ')}`);
});

test('every web/avatars/*.png file is in the published tarball', () => {
  const packed = packedFiles();
  const onDisk = walk(path.join(root, 'web/avatars')).filter((f) => f.endsWith('.png'));
  assert.ok(onDisk.length > 0, 'expected at least one web/avatars/*.png on disk');
  const missing = onDisk.filter((f) => !packed.has(f));
  assert.deepEqual(missing, [], `these avatar files are on disk but NOT in the tarball: ${missing.join(', ')}`);
});
