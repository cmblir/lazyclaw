// dotenv_min.mjs — minimal .env loader shared by the CLI and the Ink slash
// dispatcher. Loads <cfgDir>/.env into process.env (without overwriting
// already-set vars) so Slack / provider tokens are available. Extracted from
// cli.mjs `_loadDotenvIfAny` so the /task Slack-close flow can reuse it.

import fs from 'node:fs';
import path from 'node:path';
import { writeTextSecure } from './secure_write.mjs';

export function loadDotenvIfAny(cfgDir) {
  const p = path.join(cfgDir, '.env');
  if (!fs.existsSync(p)) return { path: p, loaded: 0 };
  let loaded = 0;
  const raw = fs.readFileSync(p, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) { process.env[m[1]] = val; loaded++; }
  }
  return { path: p, loaded };
}

// Read-merge-write <cfgDir>/.env at 0600. Existing keys are preserved;
// keys present in `vars` are overwritten. Values are written verbatim
// (no quoting) — callers pass already-trimmed strings. Returns the path.
// Mirror of loadDotenvIfAny so .env read + write live together.
export function writeDotenvMerge(cfgDir, vars) {
  const p = path.join(cfgDir, '.env');
  const lines = [];
  const seen = new Set();
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  // Splitting '' yields [''] — one empty element that would be pushed ahead of
  // the vars and surface as a leading blank line in a brand-new .env. Only walk
  // existing lines when there is actual content to preserve.
  for (const line of existing ? existing.split(/\r?\n/) : []) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(vars, m[1])) {
      seen.add(m[1]);
      lines.push(`${m[1]}=${vars[m[1]]}`);
    } else {
      lines.push(line);
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  let text = lines.join('\n').replace(/\n+$/, '');
  if (text) text += '\n';
  writeTextSecure(p, text);
  return p;
}
