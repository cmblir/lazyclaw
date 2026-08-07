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
