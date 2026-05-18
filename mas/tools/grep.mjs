// Grep tool — recursive substring / regex search over the workspace.
//
// Pure JS scanner — no shell dependency on rg/grep. Walks the directory
// tree honoring a small built-in ignore list (node_modules, .git,
// dist/, build/, etc.) so a default search doesn't trawl megabytes of
// dependency code.

import fs from 'node:fs';
import path from 'node:path';

export const NAME = 'grep';
export const DESCRIPTION = 'Search files for a substring or /regex/. Returns matching lines with path + line number.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Plain substring or "/pattern/flags" regex form.' },
    path: { type: 'string', description: 'Root to search; defaults to workspace cwd.' },
    maxMatches: { type: 'number', description: 'Cap on results; default 200.' },
  },
  required: ['pattern'],
};

const DEFAULT_MAX_MATCHES = 200;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.playwright', 'playwright-report', 'test-results', '.lazyclaw']);
const MAX_FILE_BYTES = 1_000_000;  // skip files bigger than 1 MB
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.html', '.css', '.scss', '.sass', '.yml', '.yaml', '.toml', '.ini',
  '.py', '.rb', '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.java',
  '.kt', '.swift', '.sh', '.bash', '.zsh', '.fish', '.sql', '.xml',
  '.svg', '.vue', '.svelte', '.lua', '.php', '.gitignore', '',
]);

function compilePattern(raw) {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(raw);
  if (m) return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
  // Escape for substring literal use and force `g` so we can scan
  // multiple lines per file without restarting state.
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

function* walk(root) {
  let stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) yield full;
    }
  }
}

export async function exec(args, { cwd = process.cwd() } = {}) {
  if (!args || typeof args.pattern !== 'string' || !args.pattern) {
    return { ok: false, error: 'grep: pattern is required' };
  }
  const root = args.path
    ? (path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path))
    : cwd;
  const max = Math.max(1, Math.min(Number.isFinite(+args.maxMatches) ? +args.maxMatches : DEFAULT_MAX_MATCHES, 1000));
  let re;
  try { re = compilePattern(args.pattern); }
  catch (err) { return { ok: false, error: `grep: bad pattern: ${err?.message || err}` }; }

  const matches = [];
  let truncated = false;
  for (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase();
    if (TEXT_EXT.size && !TEXT_EXT.has(ext)) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 500) });
        if (matches.length >= max) { truncated = true; break; }
      }
    }
    if (truncated) break;
  }
  return { ok: true, count: matches.length, truncated, matches };
}
