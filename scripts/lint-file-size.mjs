#!/usr/bin/env node
// File-size lint gate (D8) — locks the module architecture so files can't
// silently grow back into the monoliths that Phase D broke up.
//
// Rule: every committed .mjs source file must be <= LIMIT lines, EXCEPT the
// files in ALLOW, each pinned to its current size as a ratchet ceiling. The
// gate fails when:
//   - a NON-allowlisted file exceeds LIMIT (a new monolith), or
//   - an allowlisted file grows past its pinned ceiling (regression).
//
// The ALLOW map is tech debt, not a blessing: each entry is a file that
// still needs splitting to get under LIMIT (the rest of D8). When a file
// drops to <= LIMIT, remove it from ALLOW (the gate prints a reminder).
// Shrinking ALLOW to empty is "D8 done".
//
// Deliberately dependency-free (no ESLint) and node:test-independent so it
// can run as its own fast CI step.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const LIMIT = 500;

// Directories we never lint (vendored, generated, or test fixtures that are
// legitimately long).
const SKIP_DIRS = new Set(['node_modules', 'tests', 'dist-lazyclaw', '.git']);

// Ratchet allowlist: path (relative to repo root) -> max allowed lines.
// Pinned to the size each file had when the gate landed; tighten as files
// are split. DO NOT raise a ceiling to make room — split the file instead.
const ALLOW = {
  'tui/slash_dispatcher.mjs': 1797,
  'commands/chat.mjs': 1253,
  'tui/pickers.mjs': 917,
  'commands/setup.mjs': 738,
  'commands/agents.mjs': 669,
  'gateway/device_auth.mjs': 664,
  'commands/workflow.mjs': 661,
  'tui/repl.mjs': 656,
  'providers/registry.mjs': 623,
  'commands/automation.mjs': 582,
  'mas/mention_router.mjs': 540,
};

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function countLines(file) {
  // Match `wc -l` semantics closely enough: number of newline-terminated
  // lines, plus a trailing partial line if the file doesn't end in \n.
  const buf = fs.readFileSync(file, 'utf8');
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === '\n') n++;
  if (buf[buf.length - 1] !== '\n') n++;
  return n;
}

const files = walk(REPO_ROOT, []);
const violations = [];
const staleAllow = [];

for (const abs of files) {
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  const lines = countLines(abs);
  if (rel in ALLOW) {
    const ceiling = ALLOW[rel];
    if (lines > ceiling) {
      violations.push(`${rel}: ${lines} lines > pinned ceiling ${ceiling} — split it (do not raise the ceiling)`);
    } else if (lines <= LIMIT) {
      staleAllow.push(`${rel}: now ${lines} lines (<= ${LIMIT}) — remove it from the ALLOW ratchet`);
    }
  } else if (lines > LIMIT) {
    violations.push(`${rel}: ${lines} lines > ${LIMIT} — keep one file to one responsibility (split into a module)`);
  }
}

if (staleAllow.length) {
  process.stdout.write(`file-size gate: ${staleAllow.length} allowlisted file(s) are now under ${LIMIT} — tidy the ratchet:\n`);
  for (const s of staleAllow) process.stdout.write(`  • ${s}\n`);
}

if (violations.length) {
  process.stderr.write(`\nfile-size gate FAILED (${violations.length} violation(s), limit ${LIMIT} lines):\n`);
  for (const v of violations) process.stderr.write(`  ✗ ${v}\n`);
  process.stderr.write(`\n${ALLOW && Object.keys(ALLOW).length} file(s) remain on the split-debt ratchet (see scripts/lint-file-size.mjs).\n`);
  process.exit(1);
}

process.stdout.write(`file-size gate OK: ${files.length} .mjs files <= ${LIMIT} lines (or within their pinned ratchet ceiling).\n`);
