#!/usr/bin/env node
// Pack-completeness gate — the guard that would have caught the 6.0.0
// breakage (cli.mjs imported ./lib/config.mjs but `files` never shipped lib/).
//
// `node --test` and the Playwright suite run from the repo where EVERY file
// exists, so a missing entry in package.json `files` is invisible to them.
// This gate instead asks npm what it WOULD publish, then statically resolves
// every relative import inside each packed source file and fails if any target
// is not itself packed. It catches "module X is imported but not shipped"
// without installing or executing anything.
//
// Limits: only LITERAL relative specifiers are checked (static `from './x'`
// and dynamic `import('./x')`). Computed/templated dynamic imports can't be
// resolved statically and are skipped — keep those rare.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Ask npm for the exact file list it would publish (dir entries in `files`
// are already expanded to individual paths here).
let packed;
try {
  const raw = execSync('npm pack --dry-run --json', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const arr = JSON.parse(raw);
  packed = new Set((arr[0]?.files || []).map((f) => f.path.split(path.sep).join('/')));
} catch (e) {
  process.stderr.write(`check-pack: could not run \`npm pack --dry-run --json\`: ${e?.message || e}\n`);
  process.exit(1);
}

// Pull every relative import specifier out of a source file.
const SPEC_RE = /(?:import\s*\(|\bfrom)\s*(['"])(\.{1,2}\/[^'"]+)\1/g;
function relSpecs(src) {
  const out = [];
  let m;
  while ((m = SPEC_RE.exec(src)) !== null) out.push(m[2]);
  return out;
}

const violations = [];
let checked = 0;

for (const rel of packed) {
  if (!rel.endsWith('.mjs') && !rel.endsWith('.js')) continue;
  const abs = path.join(REPO_ROOT, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  checked++;
  const fromDir = path.posix.dirname(rel);
  for (const spec of relSpecs(src)) {
    // Resolve the specifier relative to the importing file, repo-relative.
    const target = path.posix.normalize(path.posix.join(fromDir, spec));
    // A target that escapes the package root can't be a packaged file (and is
    // almost always a specifier quoted inside a comment, not a real import).
    if (target.startsWith('..')) continue;
    if (!packed.has(target)) {
      violations.push(`${rel}  →  ${spec}  (resolves to ${target}, NOT in the published package)`);
    }
  }
}

if (violations.length) {
  process.stderr.write(`\npack-completeness gate FAILED — ${violations.length} import(s) target files that package.json \`files\` does not ship:\n`);
  for (const v of violations) process.stderr.write(`  ✗ ${v}\n`);
  process.stderr.write(`\nAdd the missing path(s) to package.json "files". A published install would crash with ERR_MODULE_NOT_FOUND on these.\n`);
  process.exit(1);
}

process.stdout.write(`pack-completeness gate OK: every relative import across ${checked} packed source files is also shipped.\n`);
