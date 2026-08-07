// Configuration + diagnostics commands: personality, config get/set/edit/
// validate, doctor, status, version, completion. Extracted from cli.mjs (D3).
import path from 'node:path';
import fs from 'node:fs';
import { configPath, readConfig, writeConfig, readVersionFromRepo } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { bashCompletion, zshCompletion } from '../lib/args.mjs';
import { defaultConfigDir as _persDefaultCfg } from '../memory.mjs';

export async function cmdPersonality(sub, a, b) {
  const cfgDir = process.env.LAZYCLAW_CONFIG_DIR || _persDefaultCfg();
  const dir = path.join(cfgDir, 'personalities');
  fs.mkdirSync(dir, { recursive: true });

  if (!sub || sub === 'list') {
    const names = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
      : [];
    if (!names.length) { console.log('No personalities installed'); return 0; }
    for (const n of names.sort()) console.log(n);
    return 0;
  }

  if (sub === 'show') {
    if (!a) { console.error('Usage: pompos personality show <name>'); return 2; }
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) { console.error(`personality not found: ${a}`); return 1; }
    process.stdout.write(fs.readFileSync(p, 'utf8'));
    return 0;
  }

  if (sub === 'install') {
    if (!a || !b) { console.error('Usage: pompos personality install <name> <file>'); return 2; }
    const dst = path.join(dir, `${a}.md`);
    if (fs.existsSync(dst)) { console.error(`personality already installed: ${a}`); return 1; }
    if (!fs.existsSync(b)) { console.error(`source file not found: ${b}`); return 1; }
    fs.writeFileSync(dst, fs.readFileSync(b, 'utf8'));
    console.log(`installed ${a}`);
    return 0;
  }

  if (sub === 'remove') {
    if (!a) { console.error('Usage: pompos personality remove <name>'); return 2; }
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) { console.error(`personality not installed: ${a}`); return 1; }
    fs.unlinkSync(p);
    console.log(`removed ${a}`);
    return 0;
  }

  if (sub === 'use') {
    if (!a) { console.error('Usage: pompos personality use <name>'); return 2; }
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) { console.error(`personality not installed: ${a}`); return 1; }
    const cfgPath = path.join(cfgDir, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
    cfg.persona = { ...(cfg.persona || {}), personality: a };
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`active personality: ${a}`);
    return 0;
  }

  console.error(`Unknown personality subcommand: ${sub}`);
  return 2;
}

export async function cmdConfigEdit() {
  // Open config.json in $EDITOR (or sensible default), then validate
  // the result before letting the user walk away believing the edit
  // landed. A bad JSON syntax error here would silently break every
  // future invocation, so we re-parse the file post-edit and refuse
  // to leave it broken.
  const p = configPath();
  // Ensure the file exists with at least an empty object so $EDITOR
  // doesn't open a blank scratch buffer the user accidentally saves
  // as nothing.
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '{}\n');
  const editor = process.env.LAZYCLAW_EDITOR || process.env.VISUAL || process.env.EDITOR || 'vi';
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(editor, [p], { stdio: 'inherit' });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`editor exited ${code}`));
    });
    child.on('error', reject);
  });
  // Validate the result. If JSON.parse throws, restore from a backup
  // we made before the edit (the original content if the file existed,
  // or an empty {} otherwise — the file always has SOME valid JSON).
  try {
    const txt = fs.readFileSync(p, 'utf8');
    JSON.parse(txt);
    console.log(JSON.stringify({ ok: true, path: p }));
  } catch (e) {
    console.error(`config: edit produced invalid JSON: ${e.message}`);
    console.error(`Re-run \`pompos config edit\` to fix; nothing else has been touched.`);
    process.exit(1);
  }
}

// Coerce a CLI string value into the type it most likely represents so a
// boolean/number setting isn't stored as a string the rest of the code then
// mis-compares (`if (cfg.chat.recall)` is truthy for the string "false").
//   'true' / 'false'        → boolean
//   integer / float strings → number
//   everything else         → the original string (provider/model/api-key/…)
function coerceConfigValue(value) {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Only treat as a number when the WHOLE string is a clean numeric literal —
  // Number('') is 0 and Number('1.2.3') is NaN, both of which we reject so
  // ids like "gpt-4.1" or empty values stay strings.
  if (value.trim() !== '' && /^-?(?:\d+|\d*\.\d+|\d+\.\d*)$/.test(value.trim()) && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

export function cmdConfigSet(key, value) {
  const cfg = readConfig();
  const coerced = coerceConfigValue(value);
  if (typeof key === 'string' && key.includes('.')) {
    // Dotted key → nested path. Walk/create each intermediate object so
    // `chat.recall` lands as cfg.chat.recall (not a flat "chat.recall" key).
    // A non-object value blocking the path is replaced rather than crashing.
    const segs = key.split('.');
    let node = cfg;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (!node[seg] || typeof node[seg] !== 'object' || Array.isArray(node[seg])) node[seg] = {};
      node = node[seg];
    }
    node[segs[segs.length - 1]] = coerced;
  } else {
    cfg[key] = coerced;
  }
  writeConfig(cfg);
  console.log(JSON.stringify({ ok: true, key, value: coerced }));
}
export async function cmdDoctor() {
  await ensureRegistry();
  const cfg = readConfig();
  const issues = [];
  const warnings = [];
  if (!cfg.provider) issues.push('config.provider is missing — run `pompos onboard`');
  // Only flag a missing api-key when the picked provider actually
  // requires one. claude-cli / ollama / mock all run keylessly, so the
  // previous `provider !== 'mock'` check produced false positives.
  const _meta = (getRegistry().PROVIDER_INFO || {})[cfg.provider] || {};
  if (cfg.provider && _meta.requiresApiKey && !cfg['api-key']) {
    issues.push(`config['api-key'] is missing for provider "${cfg.provider}"`);
  }
  if (cfg.provider && !PROVIDERS_HAS(getRegistry().PROVIDERS, cfg.provider)) {
    issues.push(`unknown provider "${cfg.provider}" — registered: ${Object.keys(getRegistry().PROVIDERS).join(', ')}`);
  }
  // v5.3.2 soft-migration — pre-5.3.2 wizards could write
  // `provider: 'orchestrator'` even when the user never configured the
  // orchestrator section (planner / workers). On those installs the
  // first chat turn dies with an opaque "orchestrator not configured"
  // error. Surface a warning + the fix hint, but never auto-rewrite
  // cfg.json — the user might have legitimately picked orchestrator
  // and just hasn't finished setup yet.
  if (cfg.provider === 'orchestrator') {
    const orch = cfg.orchestrator;
    const configured = orch && typeof orch === 'object'
      && typeof orch.planner === 'string' && orch.planner
      && Array.isArray(orch.workers) && orch.workers.length > 0;
    if (!configured) {
      warnings.push(
        'config.provider is "orchestrator" but cfg.orchestrator is missing/empty. '
        + 'Pre-v5.3.2 setup wizards could leave you in this half-configured state. '
        + 'Either finish orchestrator setup (`pompos orchestrator set-planner …` + `pompos orchestrator workers add …`) '
        + 'or switch to a single concrete provider: `pompos config set provider claude-cli`.'
      );
    }
  }
  // C12 — MinGit / Windows safety net. mas/tools/git.mjs shells out to
  // `git`; on a stripped Windows PATH (no Git-for-Windows installed) or
  // a minimal Docker base image, that spawnSync ENOENTs and any agent
  // task touching the git tool fails opaquely. Probe up-front so
  // `pompos doctor` surfaces a clean diagnostic and the operator can
  // install the binary before they trip over it.
  let gitInfo = null;
  try {
    const { spawnSync } = await import('node:child_process');
    const gitExe = process.env.GIT_EXECUTABLE || 'git';
    const probe = spawnSync(gitExe, ['--version'], { encoding: 'utf8' });
    if (probe.error && probe.error.code === 'ENOENT') {
      issues.push('git binary not found on PATH — `mas/tools/git.mjs` will fail. Install Git: macOS `xcode-select --install`; Linux `apt install git` / `yum install git`; Windows Git-for-Windows (https://git-scm.com/download/win). Or set the GIT_EXECUTABLE env var to an explicit path.');
      gitInfo = { ok: false, code: 'ENOENT' };
    } else if (probe.status !== 0) {
      issues.push(`git --version exited ${probe.status} (${(probe.stderr || '').trim().slice(0, 200)})`);
      gitInfo = { ok: false, status: probe.status, stderr: (probe.stderr || '').trim().slice(0, 200) };
    } else {
      gitInfo = { ok: true, version: (probe.stdout || '').trim() };
    }
  } catch (e) {
    gitInfo = { ok: false, error: e?.message || String(e) };
  }
  // m11 — stale index probe. mas/index_db.mjs write-through hooks
  // log failures to <configDir>/index-failures.jsonl; surface a recent
  // count so the operator notices a silently-degraded index. Best-effort:
  // missing file → 0 failures (the common case).
  let indexInfo = null;
  try {
    const cfgDir = path.dirname(configPath());
    const auditFile = path.join(cfgDir, 'index-failures.jsonl');
    if (fs.existsSync(auditFile)) {
      const raw = fs.readFileSync(auditFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let recent = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry?.ts && new Date(entry.ts).getTime() >= cutoff) recent++;
        } catch { /* skip malformed */ }
      }
      indexInfo = { failuresLast24h: recent, totalFailures: lines.length };
      if (recent > 0) {
        issues.push(`${recent} index write failure(s) in the last 24h — run \`pompos index rebuild\` to recover.`);
      }
    } else {
      indexInfo = { failuresLast24h: 0, totalFailures: 0 };
    }
  } catch (e) {
    indexInfo = { error: e?.message || String(e) };
  }
  // Workflow state health — informational counters that show whether
  // the user has any failed or stuck workflow runs to attend to. We
  // don't push these to `issues` (a stuck workflow doesn't break the
  // CLI) but they surface in the output so `pompos doctor | jq` can
  // surface them in dashboards.
  const stateDir = process.env.LAZYCLAW_WORKFLOW_STATE_DIR || '.workflow-state';
  let workflows = null;
  try {
    const { listSessions } = await import('../workflow/summary.mjs');
    if (fs.existsSync(stateDir)) {
      const sessions = listSessions(stateDir);
      const counts = { total: sessions.length, done: 0, resumable: 0, failed: 0, running: 0 };
      for (const s of sessions) {
        if (s.summary.done)         counts.done++;
        if (s.summary.resumable)    counts.resumable++;
        if (s.summary.failed > 0)   counts.failed++;
        if (s.summary.running > 0)  counts.running++;
      }
      workflows = { dir: stateDir, ...counts };
      // Surface a hint when there are stuck runs that the engine will
      // demote to pending on next load — this often signals a process
      // that crashed; the user should at least know.
      if (counts.running > 0) {
        issues.push(`${counts.running} workflow session(s) have 'running' nodes from a prior interrupted run — they will be demoted to pending on next resume.`);
      }
    } else {
      workflows = { dir: stateDir, present: false };
    }
  } catch (e) {
    workflows = { dir: stateDir, error: e?.message || String(e) };
  }
  const ok = issues.length === 0;
  const out = {
    ok,
    configPath: configPath(),
    provider: cfg.provider || null,
    model: cfg.model || null,
    hasApiKey: !!cfg['api-key'],
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    issues,
    warnings,
    knownProviders: Object.keys(getRegistry().PROVIDERS),
    workflows,
    git: gitInfo,
    index: indexInfo,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(ok ? 0 : 1);
}

export function PROVIDERS_HAS(map, name) {
  return Object.prototype.hasOwnProperty.call(map, name);
}

export async function cmdStatus() {
  await ensureRegistry();
  const cfg = readConfig();
  const out = {
    configPath: configPath(),
    provider: cfg.provider || null,
    model: cfg.model || null,
    keyMasked: getRegistry().maskApiKey(cfg['api-key']),
  };
  console.log(JSON.stringify(out, null, 2));
}
export async function cmdVersion() {
  const out = {
    version: readVersionFromRepo(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  console.log(JSON.stringify(out));
}

export async function cmdCompletion(shell) {
  if (shell === 'bash') { process.stdout.write(bashCompletion()); return; }
  if (shell === 'zsh')  { process.stdout.write(zshCompletion()); return; }
  console.error('Usage: pompos completion <bash|zsh>');
  process.exit(2);
}
export function cmdConfigGet(key) {
  const cfg = readConfig();
  if (!key) { console.log(JSON.stringify(cfg)); return; }
  let value = cfg;
  for (const seg of String(key).split('.')) {
    if (value && typeof value === 'object' && seg in value) value = value[seg];
    else { value = null; break; }
  }
  console.log(JSON.stringify({ key, value }));
}

// Structural integrity check across the whole config. Distinct from
// `pompos doctor` (runtime checks: provider available, key present
// for the active provider). Validate is purely about *shape* — does
// every value have the right type, is `provider` known, are rates
// well-formed.
//
// Hard issues exit 1; unknown top-level keys produce warnings (kept
// exit 0 so a forward-compatible config from a newer CLI doesn't
// fail validate on an older CLI).
export async function cmdConfigValidate() {
  const cfg = readConfig();
  await ensureRegistry();
  const { validateConfig } = await import('../config-validate.mjs');
  const { ok, issues, warnings } = validateConfig(cfg, getRegistry().PROVIDERS);
  console.log(JSON.stringify({
    ok,
    configPath: configPath(),
    keys: Object.keys(cfg),
    issues,
    warnings,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}
