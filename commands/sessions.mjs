// Session CRUD + portable bundle (export/import) + layered memory commands,
// extracted from cli.mjs (Phase D3). Owns the BUNDLE_VERSION constant.
import path from 'node:path';
import fs from 'node:fs';
import { configPath, readConfig, writeConfig, _resolveAuthKey } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';

const BUNDLE_VERSION = 1;

// Key names that carry secrets. A bundle on a teammate's laptop must never
// leak per-provider keys (cfg.authProfiles[<provider>][i].key, written by
// providers/auth_store.mjs) or any other secret-bearing config value, not
// just the legacy top-level cfg['api-key']. Match on the KEY name so we can
// redact custom/nested entries without knowing the config schema ahead of
// time, while leaving non-secret keys (baseUrl, model, label, …) untouched.
const SECRET_KEY_RE = /(?:api[-_]?key|secret|token|password|authorization|access[-_]?key)/i;

// Deep-clone cfg with every secret-bearing string value redacted. Pure — never
// mutates the input. Preserves structure/labels so the bundle stays
// inspectable (e.g. authProfiles keeps {label} but drops {key}).
function redactSecrets(value, keyName = '') {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v, k);
    return out;
  }
  if (typeof value === 'string' && SECRET_KEY_RE.test(keyName)) return '***REDACTED***';
  return value;
}

// Reciprocal of the export redaction: deep-clone cfg with every
// '***REDACTED***' placeholder dropped, so importing a redacted bundle never
// persists the literal placeholder string into config.json. Skipping the key
// (rather than writing it) means an existing real value survives the default
// "bundle wins" merge, and an authProfiles entry keeps its {label} slot minus
// the secret. Symmetric with redactSecrets / redactAuthProfileKeys above.
const REDACTED_PLACEHOLDER = '***REDACTED***';
function stripRedacted(value) {
  if (Array.isArray(value)) return value.map(stripRedacted);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === REDACTED_PLACEHOLDER) continue;   // drop the redacted key entirely
      out[k] = stripRedacted(v);
    }
    return out;
  }
  return value;
}

// Redact the per-provider api keys in authProfiles. The field is literally
// named `key` (not `apiKey`), so the generic key-name match above doesn't
// catch it; handle it structurally instead. Keep `label` so the auth profile
// shape stays inspectable. Operates on the already-cloned safeCfg.
function redactAuthProfileKeys(safeCfg) {
  const profiles = safeCfg.authProfiles;
  if (!profiles || typeof profiles !== 'object') return safeCfg;
  for (const provider of Object.keys(profiles)) {
    const arr = profiles[provider];
    if (!Array.isArray(arr)) continue;
    profiles[provider] = arr.map((p) =>
      p && typeof p === 'object' && 'key' in p ? { ...p, key: '***REDACTED***' } : p,
    );
  }
  return safeCfg;
}

export async function cmdExport(flags) {
  // Portable bundle: config + every installed skill + (optionally) every
  // persisted session. Writes JSON to stdout so the caller pipes it
  // wherever they want — disk, scp, gist, encrypted vault.
  //
  // Secrets default to redacted because a bundle on a teammate's laptop
  // shouldn't carry your API keys. --include-secrets flips that behavior
  // for the use case of "back up MY laptop to MY external drive".
  const skillsMod = await import('../skills.mjs');
  const sessionsMod = await import('../sessions.mjs');
  const cfgDir = path.dirname(configPath());
  const cfg = readConfig();
  // redactSecrets deep-clones, so --include-secrets keeps the original cfg
  // verbatim while the default path emits a fully redacted copy.
  const safeCfg = flags['include-secrets'] ? cfg : redactAuthProfileKeys(redactSecrets(cfg));
  const skills = skillsMod.listSkills(cfgDir).map(s => ({
    name: s.name,
    content: skillsMod.loadSkill(s.name, cfgDir),
  }));
  const includeSessions = !!flags['include-sessions'];
  const sessions = sessionsMod.listSessions(cfgDir).map(s => {
    const base = { id: s.id, mtime: new Date(s.mtimeMs).toISOString(), bytes: s.bytes };
    if (includeSessions) base.turns = sessionsMod.loadTurns(s.id, cfgDir);
    return base;
  });
  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    config: safeCfg,
    skills,
    sessions,
    secretsIncluded: !!flags['include-secrets'],
    sessionContentIncluded: includeSessions,
  };
  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
}

export async function cmdImport(flags) {
  // Read JSON bundle from stdin (or --from <path>). Apply with these rules:
  //   - config keys land via writeConfig; existing keys are overwritten
  //     UNLESS --no-overwrite-config is set.
  //   - skills land via installSkill; existing names are skipped UNLESS
  //     --overwrite-skills is set.
  //   - sessions land only when the bundle carried turn content AND
  //     --import-sessions is set; existing session files are NEVER
  //     overwritten (we don't want to clobber active conversations).
  //   - REDACTED api-key in the bundle is dropped (never written).
  const skillsMod = await import('../skills.mjs');
  const sessionsMod = await import('../sessions.mjs');
  const cfgDir = path.dirname(configPath());
  let raw;
  if (flags.from) raw = fs.readFileSync(flags.from, 'utf8');
  else {
    raw = await new Promise(resolve => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
    });
  }
  let bundle;
  try { bundle = JSON.parse(raw); }
  catch (e) { console.error(`import: invalid JSON: ${e.message}`); process.exit(2); }
  if (!bundle || typeof bundle !== 'object' || bundle.bundleVersion !== BUNDLE_VERSION) {
    console.error(`import: unsupported bundleVersion (got ${bundle?.bundleVersion}, expected ${BUNDLE_VERSION})`);
    process.exit(2);
  }
  const stats = { configKeys: 0, skillsAdded: 0, skillsSkipped: 0, sessionsAdded: 0, sessionsSkipped: 0 };
  // Config
  if (bundle.config && typeof bundle.config === 'object') {
    const existing = readConfig();
    // Strip every redacted placeholder from the incoming config BEFORE the
    // merge so the literal '***REDACTED***' is never persisted — at the
    // top-level api-key, inside authProfiles[].key, or any nested secret.
    const incoming = stripRedacted(bundle.config);
    const next = flags['no-overwrite-config']
      ? { ...incoming, ...existing }    // existing wins
      : { ...existing, ...incoming };   // bundle wins (default)
    writeConfig(next);
    stats.configKeys = Object.keys(bundle.config).length;
  }
  // Skills
  for (const s of bundle.skills || []) {
    if (!s?.name || typeof s.content !== 'string') continue;
    const file = skillsMod.skillPath(s.name, cfgDir);
    if (fs.existsSync(file) && !flags['overwrite-skills']) {
      stats.skillsSkipped += 1;
      continue;
    }
    skillsMod.installSkill(s.name, s.content, cfgDir);
    stats.skillsAdded += 1;
  }
  // Sessions — never overwrite, only add new
  if (flags['import-sessions']) {
    for (const sess of bundle.sessions || []) {
      if (!sess?.id || !Array.isArray(sess.turns)) continue;
      try {
        const file = sessionsMod.sessionPath(sess.id, cfgDir);
        if (fs.existsSync(file)) { stats.sessionsSkipped += 1; continue; }
        for (const t of sess.turns) {
          if (t?.role && typeof t.content === 'string') {
            sessionsMod.appendTurn(sess.id, t.role, t.content, cfgDir);
          }
        }
        stats.sessionsAdded += 1;
      } catch { stats.sessionsSkipped += 1; }
    }
  }
  console.log(JSON.stringify({ ok: true, ...stats }));
}
export async function cmdMemory(sub, positional, flags = {}) {
  const memMod = await import('../memory.mjs');
  const cfgDir = path.dirname(configPath());
  switch (sub) {
    case undefined:
    case 'show': {
      const which = positional[0] || 'core';
      if (which === 'core') {
        process.stdout.write(memMod.loadCore(cfgDir));
        return;
      }
      if (which === 'recent') {
        const n = flags.n !== undefined ? Number(flags.n) : 20;
        console.log(JSON.stringify(memMod.loadRecent(n, cfgDir), null, 2));
        return;
      }
      if (which === 'episodic') {
        const topic = positional[1];
        if (topic) { process.stdout.write(memMod.loadEpisodic(topic, cfgDir)); return; }
        console.log(JSON.stringify(memMod.listEpisodic(cfgDir), null, 2));
        return;
      }
      console.error(`unknown memory.show target: ${which} (expected: core, recent, episodic)`);
      process.exit(2);
      return;
    }
    case 'dream': {
      await ensureRegistry();
      const cfg = readConfig();
      const provName = flags.provider || cfg.provider || 'mock';
      const prov = getRegistry().PROVIDERS[provName];
      if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
      const sid = positional[0] || flags.session || null;
      try {
        const result = await memMod.dream(sid, {
          provider: prov,
          model: flags.model || cfg.model,
          apiKey: _resolveAuthKey(cfg, provName),
        }, cfgDir);
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } catch (e) { console.error(`dream error: ${e?.message || e}`); process.exit(1); }
      return;
    }
    case 'edit': {
      const which = positional[0] || 'core';
      if (which !== 'core') {
        console.error('Only core.md is editable right now (episodic is LLM-curated, recent is append-only)');
        process.exit(2);
      }
      const p = memMod.corePath(cfgDir);
      const fs_ = await import('node:fs');
      fs_.mkdirSync(memMod.memoryDir(cfgDir), { recursive: true });
      if (!fs_.existsSync(p)) fs_.writeFileSync(p, '');
      const editor = process.env.EDITOR || 'vi';
      const { spawnSync } = await import('node:child_process');
      // EDITOR=cat is the test-only escape hatch: spawnSync with stdio
      // inherit makes the file's contents land on stdout and the
      // command exits 0 without blocking.
      const r = spawnSync(editor, [p], { stdio: 'inherit' });
      if (r.status !== 0 && r.status !== null) {
        console.error(`editor exited ${r.status}`);
        process.exit(r.status);
      }
      return;
    }
    default:
      console.error('Usage: pompos memory <show|dream|edit> ...');
      process.exit(2);
  }
}
export async function cmdSessions(sub, positional, flags = {}) {
  const sessionsMod = await import('../sessions.mjs');
  const cfgDir = path.dirname(configPath());
  switch (sub) {
    case 'list': {
      // --filter <substring> applies a case-insensitive id substring
      // filter (no regex, deliberately — filtering on session ids is
      // typically about prefixes or fragments).
      // --limit <N> caps the result count after filter+sort. Negative
      // or zero values are ignored so a script can pass `--limit 0`
      // explicitly to opt out without special-casing.
      // --with-turn-count: opt-in flag that adds `turnCount` per
      // session. Loads each session file (one fs.read each) — opt-in
      // because the default `list` should be fast even with thousands
      // of sessions.
      let items = sessionsMod.listSessions(cfgDir);
      if (flags.filter) {
        const f = String(flags.filter).toLowerCase();
        items = items.filter(s => s.id.toLowerCase().includes(f));
      }
      if (flags.limit !== undefined) {
        const n = parseInt(flags.limit, 10);
        if (Number.isFinite(n) && n > 0) items = items.slice(0, n);
      }
      let out = items.map(s => {
        const base = { id: s.id, bytes: s.bytes, mtime: new Date(s.mtimeMs).toISOString(), _mtimeMs: s.mtimeMs };
        if (flags['with-turn-count'] || flags['sort-by'] === 'turn-count') {
          try { base.turnCount = sessionsMod.loadTurns(s.id, cfgDir).length; }
          catch { base.turnCount = null; }
        }
        return base;
      });
      // --sort-by mtime|turn-count|bytes|id. Default is mtime descending
      // (matches the underlying listSessions behavior). turn-count
      // implicitly enables turnCount loading above.
      if (flags['sort-by']) {
        const valid = new Set(['mtime', 'turn-count', 'bytes', 'id']);
        if (!valid.has(flags['sort-by'])) {
          console.error(`invalid --sort-by: ${flags['sort-by']} (expected: mtime, turn-count, bytes, id)`);
          process.exit(2);
        }
        const cmp = {
          mtime:        (a, b) => b._mtimeMs - a._mtimeMs,
          'turn-count': (a, b) => (b.turnCount ?? 0) - (a.turnCount ?? 0),
          bytes:        (a, b) => b.bytes - a.bytes,
          id:           (a, b) => a.id.localeCompare(b.id),
        };
        out.sort(cmp[flags['sort-by']]);
      }
      // Strip the internal helper field before serializing.
      out = out.map(({ _mtimeMs, ...rest }) => rest);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'show': {
      const id = positional[0];
      if (!id) { console.error('Usage: pompos sessions show <id>'); process.exit(2); }
      const turns = sessionsMod.loadTurns(id, cfgDir);
      console.log(JSON.stringify(turns, null, 2));
      return;
    }
    case 'clear': {
      const id = positional[0];
      if (!id) { console.error('Usage: pompos sessions clear <id>'); process.exit(2); }
      sessionsMod.clearSession(id, cfgDir);
      console.log(JSON.stringify({ ok: true, cleared: id }));
      return;
    }
    case 'export': {
      const id = positional[0];
      if (!id) { console.error('Usage: pompos sessions export <id> [--format md|json|text]'); process.exit(2); }
      const format = (flags.format || 'md').toLowerCase();
      const formatters = {
        md: sessionsMod.exportMarkdown,
        markdown: sessionsMod.exportMarkdown,
        json: sessionsMod.exportJson,
        text: sessionsMod.exportText,
        txt: sessionsMod.exportText,
      };
      const fn = formatters[format];
      if (!fn) {
        console.error(`unknown export format: ${format} (expected: md, json, text)`);
        process.exit(2);
      }
      try { process.stdout.write(fn(id, cfgDir)); }
      catch (e) { console.error(e.message); process.exit(1); }
      return;
    }
    case 'search': {
      const query = positional[0];
      if (!query) { console.error('Usage: pompos sessions search <query> [--regex]'); process.exit(2); }
      // --regex came in via the parsed flags map (parseArgs lifted it
      // out of positional). 'regex' is also in BOOLEAN_FLAGS so it
      // never consumes the next argument.
      const useRegex = !!flags.regex;
      let matcher;
      if (useRegex) {
        try { matcher = new RegExp(query, 'i'); }
        catch (e) { console.error(`invalid regex: ${e.message}`); process.exit(2); }
      } else {
        // Case-insensitive substring search. The naive `s.includes(q)`
        // pattern is exactly what the user wants — same shape they'd
        // get from `grep -i`.
        const q = query.toLowerCase();
        matcher = { test: (s) => String(s).toLowerCase().includes(q) };
      }
      const items = sessionsMod.listSessions(cfgDir);
      const matches = [];
      for (const s of items) {
        const turns = sessionsMod.loadTurns(s.id, cfgDir);
        let matchCount = 0;
        let firstExcerpt = null;
        for (const t of turns) {
          if (typeof t?.content !== 'string') continue;
          if (matcher.test(t.content)) {
            matchCount++;
            if (firstExcerpt === null) {
              // Excerpt: 40 chars before/after first match, clamped at
              // string boundaries. For regex matches we need to find
              // the actual position; for substring use indexOf.
              const c = t.content;
              let pos;
              if (useRegex) {
                pos = c.search(matcher);
              } else {
                pos = c.toLowerCase().indexOf(query.toLowerCase());
              }
              if (pos < 0) pos = 0;
              const start = Math.max(0, pos - 40);
              const end = Math.min(c.length, pos + query.length + 40);
              firstExcerpt = (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : '');
            }
          }
        }
        if (matchCount > 0) {
          matches.push({
            id: s.id,
            mtime: new Date(s.mtimeMs).toISOString(),
            matchCount,
            excerpt: firstExcerpt,
          });
        }
      }
      console.log(JSON.stringify({ query, regex: useRegex, matches }, null, 2));
      // Exit 0 even on no matches — `grep` convention is exit 1, but
      // a CLI tool that returns JSON should always exit 0 on a
      // successful search; the caller checks `matches.length` for
      // emptiness.
      return;
    }
    default:
      console.error('Usage: pompos sessions <list|show <id>|clear <id>|export <id>|search <query> [--regex]>');
      process.exit(2);
  }
}
