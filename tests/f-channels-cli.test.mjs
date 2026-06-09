// tests/f-channels-cli.test.mjs — coverage for the surfaces that were
// previously untested: the `lazyclaw channels` CLI command (commands/channels.mjs
// cmdChannels) and the legacy (non-Ink) REPL slash path, where the dispatcher
// runs with a ctx that has NO readConfig/writeConfig and must fall back to disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpCfg(prefix = 'lc-channels-cli-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, cfgDir, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
  });
}

function readDiskConfig(cfgDir) {
  const p = path.join(cfgDir, 'config.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── cmdChannels CLI: enable persists to disk (Finding 5) ──────────────────
test('channels enable writes channels.<name>.enabled=true to disk config', () => {
  const dir = tmpCfg();
  const r = runCli(['channels', 'enable', 'slack'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { ok: true, channel: 'slack', enabled: true });
  const cfg = readDiskConfig(dir);
  assert.equal(cfg.channels.slack.enabled, true, 'on-disk config.json toggled');
});

test('channels disable writes channels.<name>.enabled=false to disk config', () => {
  const dir = tmpCfg();
  runCli(['channels', 'enable', 'slack'], dir);
  const r = runCli(['channels', 'disable', 'slack'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.equal(readDiskConfig(dir).channels.slack.enabled, false);
});

// ── cmdChannels CLI: list --json output shape (Finding 5) ─────────────────
test('channels list --json emits {configured, plugins}', () => {
  const dir = tmpCfg();
  runCli(['channels', 'enable', 'slack'], dir);
  const r = runCli(['channels', 'list', '--json'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.configured), 'configured is an array');
  assert.ok(Array.isArray(out.plugins), 'plugins is an array');
  const slack = out.configured.find((c) => c.name === 'slack');
  assert.ok(slack, 'slack appears in the configured list');
  assert.equal(slack.enabled, true);
});

// ── cmdChannels CLI: rejects unknown name with exit 2 (Finding 2) ─────────
test('channels enable rejects an unknown name (exit 2, no config pollution)', () => {
  const dir = tmpCfg();
  const r = runCli(['channels', 'enable', 'slak'], dir);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout=${r.stdout}`);
  assert.match(r.stderr, /unknown channel: slak \(known: /);
  // The bogus key must NOT be persisted.
  const cfg = readDiskConfig(dir);
  assert.equal(cfg.channels && cfg.channels.slak, undefined, 'no bogus section written');
});

// ── Legacy REPL path: dispatchSlash with a ctx lacking readConfig/writeConfig
//    falls back to disk (Finding 6). We import the dispatcher in a child
//    process so LAZYCLAW_CONFIG_DIR points at our temp dir for lib/config. ──
test('legacy path /channels toggle persists to disk via the lib/config fallback', () => {
  const dir = tmpCfg();
  // Seed an enabled slack section so the toggle has something to flip and the
  // name passes the known/existing guard.
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ channels: { slack: { enabled: true } } }),
  );
  // _legacyCtx-shaped: a cfg object but NO readConfig/writeConfig. This is the
  // exact ctx shape the readline default-branch hands to _dispatchSlash.
  const script = `
    import { dispatchSlash } from '${path.join(REPO_ROOT, 'tui/slash_dispatcher.mjs').replace(/\\\\/g, '/')}';
    const ctx = { cfg: { channels: { slack: { enabled: true } } } };
    const out = await dispatchSlash('/channels', 'slack off', ctx, () => {});
    process.stdout.write(JSON.stringify({ out, ctxEnabled: ctx.cfg.channels.slack.enabled }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: dir },
  });
  assert.equal(r.status, 0, `child exited ${r.status}; stderr=${r.stderr}`);
  const { out, ctxEnabled } = JSON.parse(r.stdout);
  assert.match(out, /slack → disabled/, 'slash returned the toggle confirmation');
  // (a) disk config is toggled
  assert.equal(readDiskConfig(dir).channels.slack.enabled, false, 'disk config persisted the toggle');
  // (b) in-session ctx.cfg is now consistent (the fallback mirrors the toggle
  //     onto ctx.cfg so a follow-up in-session read isn't stale).
  assert.equal(ctxEnabled, false, 'in-memory ctx.cfg mirrors the toggle (no staleness)');
});
