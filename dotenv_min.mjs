// dotenv_min.mjs — minimal .env loader shared by the CLI and the Ink slash
// dispatcher. Loads <cfgDir>/.env into process.env (without overwriting
// already-set vars) so Slack / provider tokens are available. Extracted from
// cli.mjs `_loadDotenvIfAny` so the /task Slack-close flow can reuse it.

import fs from 'node:fs';
import path from 'node:path';

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
