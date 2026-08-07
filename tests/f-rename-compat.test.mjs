// tests/f-rename-compat.test.mjs — the compatibility layer that lets a
// pre-rename install keep working after lazyclaw became pompos.
//
// Two separate promises are under test and they fail in different ways:
//   · env: 42 distinct LAZYCLAW_* variables are read from process.env at call
//     sites all over the codebase. If the mirror is wrong, an operator's existing
//     shell profile, CI secret or launchd plist silently stops taking effect.
//   · config dir: an existing install has real state in ~/.lazyclaw. If resolution
//     is wrong, that operator opens the tool and their agents, teams and search
//     index appear to have vanished.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyEnvCompat } from '../lib/env_compat.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-home-'));
}

test('a LAZYCLAW_ variable becomes readable under POMPOS_', () => {
  const env = { LAZYCLAW_AUTH_TOKEN: 'tok', PATH: '/bin' };
  const { filled } = applyEnvCompat(env);
  assert.equal(env.POMPOS_AUTH_TOKEN, 'tok');
  assert.deepEqual(filled, ['POMPOS_AUTH_TOKEN']);
});

test('a POMPOS_ variable becomes readable under LAZYCLAW_', () => {
  const env = { POMPOS_LOG_LEVEL: 'debug' };
  applyEnvCompat(env);
  assert.equal(env.LAZYCLAW_LOG_LEVEL, 'debug');
});

test('an explicitly set name is never overwritten by its mirror', () => {
  // Setting both to different values is the operator's own contradiction. The
  // explicit value must survive rather than being silently replaced.
  const env = { LAZYCLAW_LOG_LEVEL: 'info', POMPOS_LOG_LEVEL: 'debug' };
  const { filled } = applyEnvCompat(env);
  assert.equal(env.POMPOS_LOG_LEVEL, 'debug');
  assert.equal(env.LAZYCLAW_LOG_LEVEL, 'info');
  assert.deepEqual(filled, [], 'nothing to fill when both are already set');
});

test('an empty value counts as unset in both directions', () => {
  // `env: { ...process.env, FOO: '' }` is the ordinary way to clear a variable for
  // a child process. An empty LAZYCLAW_ name must not block its POMPOS_ mirror —
  // that is what made Number('') || 20 return the default instead of the value.
  const a = { LAZYCLAW_CHAT_WINDOW_TURNS: '', POMPOS_CHAT_WINDOW_TURNS: '9' };
  applyEnvCompat(a);
  assert.equal(a.LAZYCLAW_CHAT_WINDOW_TURNS, '9', 'the empty old name is filled from the new one');

  const b = { LAZYCLAW_LOG_LEVEL: '' };
  applyEnvCompat(b);
  assert.equal(b.POMPOS_LOG_LEVEL, undefined, 'an empty value is not propagated as if it were real');
});

test('unrelated variables are left alone, and a name just created is not re-read as a source', () => {
  const env = { HOME: '/home/x', LAZYCLAW_ALT: '1' };
  applyEnvCompat(env);
  assert.equal(env.HOME, '/home/x');
  // POMPOS_ALT was created from LAZYCLAW_ALT; it must not then be treated as a
  // source that writes back, which a naive loop over a live object would do.
  assert.equal(env.POMPOS_ALT, '1');
  assert.equal(Object.keys(env).length, 3);
});

// --- config dir resolution -------------------------------------------------
// os.homedir() honours $HOME on POSIX, which is the seam these use.

function resolveWith(env) {
  const code = "import { defaultConfigDir } from './lib/config_dir.mjs';"
    + ' process.stdout.write(defaultConfigDir());';
  return execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: ROOT, env: { ...process.env, POMPOS_CONFIG_DIR: '', LAZYCLAW_CONFIG_DIR: '', ...env }, encoding: 'utf8' });
}

test('an explicit POMPOS_CONFIG_DIR wins over everything', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.lazyclaw'));
  fs.mkdirSync(path.join(home, '.pompos'));
  assert.equal(resolveWith({ HOME: home, POMPOS_CONFIG_DIR: '/explicit' }), '/explicit');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an explicit LAZYCLAW_CONFIG_DIR still works — existing plists and units set it', () => {
  const home = tmpHome();
  assert.equal(resolveWith({ HOME: home, LAZYCLAW_CONFIG_DIR: '/legacy' }), '/legacy');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an existing ~/.lazyclaw is adopted in place when there is no ~/.pompos', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.lazyclaw'));
  assert.equal(resolveWith({ HOME: home }), path.join(home, '.lazyclaw'),
    'a pre-rename install must not be pointed at an empty new directory');
  fs.rmSync(home, { recursive: true, force: true });
});

test('~/.pompos wins once it exists, even with ~/.lazyclaw still present', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.lazyclaw'));
  fs.mkdirSync(path.join(home, '.pompos'));
  assert.equal(resolveWith({ HOME: home }), path.join(home, '.pompos'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a fresh install gets ~/.pompos', () => {
  const home = tmpHome();
  assert.equal(resolveWith({ HOME: home }), path.join(home, '.pompos'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a FILE named .lazyclaw is not mistaken for the config directory', () => {
  // Otherwise every later read fails with an ENOTDIR far from here.
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.lazyclaw'), 'not a dir');
  assert.equal(resolveWith({ HOME: home }), path.join(home, '.pompos'));
  fs.rmSync(home, { recursive: true, force: true });
});

// --- the load-bearing ordering --------------------------------------------

test('a POMPOS_-only env reaches a const read at module-evaluation time', () => {
  // chat_window.mjs computes CHAT_WINDOW_TURNS from LAZYCLAW_CHAT_WINDOW_TURNS
  // when the module is evaluated, not when a function runs. This passes only if
  // the mirror ran before that module was imported — which is the entire reason
  // lib/env_compat_boot.mjs exists as a separate first import in cli.mjs.
  const code = "import './lib/env_compat_boot.mjs';"
    + " const m = await import('./chat_window.mjs');"
    + ' process.stdout.write(String(m.CHAT_WINDOW_TURNS));';
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: ROOT, env: { ...process.env, LAZYCLAW_CHAT_WINDOW_TURNS: '', POMPOS_CHAT_WINDOW_TURNS: '9' }, encoding: 'utf8' });
  assert.equal(out, '9', 'the mirror must precede the module that reads the variable');
});

test('both binary names are published', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.pompos, 'cli.mjs');
  assert.equal(pkg.bin.lazyclaw, 'cli.mjs',
    'the old name stays: installed launchd plists and crontab lines invoke it by name');
});

// --- scheduled jobs stored before the rename ------------------------------

test('a job stored as lazyclaw still resolves to an absolute launcher', async () => {
  // The installed plist holds a resolved absolute path, so it is safe either way.
  // What is NOT safe is the stored config: a pre-rename job holds ['lazyclaw', ...]
  // and if resolveCommand stopped recognising that head it would pass the argv
  // through untouched, leaving launchd to exec a bare `lazyclaw` with a PATH that
  // has never contained it — a schedule that fails silently.
  const { resolveCommand } = await import('../cron.mjs');
  for (const head of ['lazyclaw', 'pompos', '/usr/local/bin/lazyclaw', '/opt/x/pompos']) {
    const out = resolveCommand([head, 'workflow', 'run', 'nightly']);
    assert.equal(out[0], process.execPath, `${head} must resolve to the node binary`);
    assert.match(out[1], /cli\.mjs$/, `${head} must resolve to an absolute cli.mjs`);
    assert.deepEqual(out.slice(2), ['workflow', 'run', 'nightly'], `${head} must keep its args`);
  }
});

test("a command that is not ours is passed through untouched", async () => {
  const { resolveCommand } = await import('../cron.mjs');
  assert.deepEqual(resolveCommand(['/usr/bin/rsync', '-a', 'x', 'y']),
    ['/usr/bin/rsync', '-a', 'x', 'y']);
});

// --- the dashboard's stored auth token -------------------------------------
// Unlike the config directory, this one lives in the operator's browser, so
// there is nothing to stat and adopt. A bare key rename logs out everyone who
// had pasted a token into a --auth-token daemon.

function withStubbedStorage(seed = {}) {
  const map = { ...seed };
  globalThis.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem(k, v) { map[k] = String(v); },
  };
  return map;
}

test('a token stored under the old key is still read, and copied forward', async () => {
  const map = withStubbedStorage({ lazyclaw_token: 'old-tok' });
  const { getToken } = await import('../web/ui/api.mjs');
  assert.equal(getToken(), 'old-tok', 'the pre-rename token must still authorize');
  assert.equal(map.pompos_token, 'old-tok', 'and be copied to the new key');
  assert.equal(map.lazyclaw_token, 'old-tok',
    'the old key is left in place — deleting it gains nothing and forfeits the way back');
});

test('the new key wins when both are present, and an absent token is empty', async () => {
  const { getToken } = await import('../web/ui/api.mjs');
  withStubbedStorage({ lazyclaw_token: 'old-tok', pompos_token: 'new-tok' });
  assert.equal(getToken(), 'new-tok');
  withStubbedStorage({});
  assert.equal(getToken(), '', 'no token at all must read as empty, not null');
});

// --- cron jobs scheduled before the rename ---------------------------------
// resolveCommand above covers the stored argv. This covers the other half: the
// plist launchd already has loaded. os.homedir() honours $HOME, so a temp HOME
// with a planted LaunchAgents file exercises the real resolver.

function cronLabelWith(home, planted = []) {
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  for (const f of planted) fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', f), '<plist/>');
  const code = "import { plistLabel, plistPath } from './cron.mjs';"
    + " process.stdout.write(JSON.stringify([plistLabel('nightly'), plistPath('nightly')]));";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: ROOT, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  return JSON.parse(out);
}

test('a cron job whose plist predates the rename keeps its own label', () => {
  const home = tmpHome();
  const [label, plist] = cronLabelWith(home, ['com.lazyclaw.nightly.plist']);
  assert.equal(label, 'com.lazyclaw.nightly',
    'rewriting it under the new label would leave the loaded one firing too');
  assert.equal(plist, path.join(home, 'Library', 'LaunchAgents', 'com.lazyclaw.nightly.plist'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a new cron job gets the new label, and the new plist wins over a leftover old one', () => {
  const fresh = tmpHome();
  assert.equal(cronLabelWith(fresh)[0], 'com.pompos.nightly');
  fs.rmSync(fresh, { recursive: true, force: true });

  const both = tmpHome();
  assert.equal(cronLabelWith(both, ['com.lazyclaw.nightly.plist', 'com.pompos.nightly.plist'])[0],
    'com.pompos.nightly', 'once a current plist exists it is the one that counts');
  fs.rmSync(both, { recursive: true, force: true });
});

test('cron log paths follow the configured directory instead of a hardcoded one', () => {
  // They were pinned to ~/.lazyclaw/logs, so an operator who moved their config
  // dir got cron logs somewhere else entirely.
  const home = tmpHome();
  const code = "import { buildPlist } from './cron.mjs';"
    + " process.stdout.write(buildPlist('nightly', '0 9 * * *', ['pompos', 'agent', 'x']));";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: ROOT, env: { ...process.env, HOME: home, POMPOS_CONFIG_DIR: '/tmp/cfgx', LAZYCLAW_CONFIG_DIR: '' }, encoding: 'utf8' });
  assert.match(out, /<string>\/tmp\/cfgx\/logs\/cron-nightly\.out\.log<\/string>/);
  assert.match(out, /<string>\/tmp\/cfgx\/logs\/cron-nightly\.err\.log<\/string>/);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- one resolver, not seventeen ------------------------------------------
// This is the trap the whole adoption design walked into once. Sixteen modules
// re-derived the config directory themselves as
//   process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.pompos')
// so an operator whose state was in ~/.lazyclaw had config.json and agents read
// correctly while the search index, trajectories, agent memory, audit log and
// device-auth store were CREATED under ~/.pompos. That directory existing then
// made rule 2 fire on the next run, and the whole tool switched to the empty new
// directory — agents, teams, config and secrets all apparently gone.

test('no module re-derives the config directory instead of calling the resolver', () => {
  const skip = new Set(['lib/config_dir.mjs']);   // the resolver itself
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const rel = path.relative(ROOT, full);
      if (skip.has(rel)) continue;
      const src = fs.readFileSync(full, 'utf8');
      // Joining a home directory with a literal config-dir name is the shape
      // that bypasses adoption. Only the resolver may do it.
      if (/(os\.homedir\(\)|process\.env\.HOME[^)]*)\s*,\s*['"]\.(pompos|lazyclaw)['"]/.test(src)) {
        offenders.push(rel);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [],
    'these must call defaultConfigDir() — a private copy silently skips legacy adoption');
});

test('every resolver agrees on a pre-rename install, and none of them creates the new dir', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.lazyclaw'));
  const code = `
    const seen = new Set();
    for (const m of ['./mas/agent_memory.mjs','./mas/audit.mjs','./mas/nudge.mjs',
                     './mas/user_modeler.mjs','./sessions.mjs']) {
      const x = await import(m);
      if (typeof x.defaultConfigDir === 'function') seen.add(x.defaultConfigDir());
    }
    const c = await import('./lib/config.mjs');
    seen.add(require('node:path').dirname(c.configPath()));
    process.stdout.write(JSON.stringify([...seen]));
  `.replace("require('node:path')", "(await import('node:path')).default");
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: ROOT, env: { ...process.env, HOME: home, POMPOS_CONFIG_DIR: '', LAZYCLAW_CONFIG_DIR: '' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [path.join(home, '.lazyclaw')],
    'all of them must land on the one directory that has the operator\'s state');
  assert.equal(fs.existsSync(path.join(home, '.pompos')), false,
    'creating it would make rule 2 fire next run and orphan everything');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- tests must not write into the developer's own state -------------------
// providers/orchestrator.mjs resolves its own config directory and persists a
// trajectory per run, so a test that drives it without an isolated directory
// writes fake-planner records into the real ~/.pompos — mixing test data into
// the operator's trajectories and search index. Three files did exactly that.
//
// Scoped to this one import deliberately. Most tests that touch a disk-writing
// module pass configDir as an argument and are already safe; an env-only rule
// applied to all of them would be 28 false positives. This pins the surface that
// resolves the directory for itself.

test('every test driving the orchestrator provider isolates its config directory', () => {
  const dir = path.join(ROOT, 'tests');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.test.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!src.includes('providers/orchestrator.mjs')) continue;
    if (!/POMPOS_CONFIG_DIR|LAZYCLAW_CONFIG_DIR/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    'set process.env.POMPOS_CONFIG_DIR to a mkdtemp dir at module scope and remove it in after()');
});
