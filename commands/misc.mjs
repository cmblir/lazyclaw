// Misc commands: cmdBrowse (headless URL fetch) and the sandbox backend
// subcommands (list/test/add/use), extracted from cli.mjs (Phase D3).
import path from 'node:path';
import fs from 'node:fs';
import { configPath } from '../lib/config.mjs';
import { resolveSandbox, listBackends } from '../sandbox/index.mjs';
import { pickAvailableConfiner } from '../sandbox/spawn.mjs';

export async function cmdBrowse(url, flags = {}) {
  if (!url) { console.error('Usage: pompos browse <url> [--max-bytes <N>] [--timeout-ms <N>] [--meta]'); process.exit(2); }
  const { browse } = await import('../browse.mjs');
  const opts = {};
  if (flags['max-bytes'] !== undefined) opts.maxBytes = parseInt(flags['max-bytes'], 10);
  if (flags['timeout-ms'] !== undefined) opts.timeoutMs = parseInt(flags['timeout-ms'], 10);
  if (flags['user-agent']) opts.userAgent = flags['user-agent'];
  try {
    const r = await browse(url, opts);
    if (flags.meta) {
      process.stderr.write(JSON.stringify({
        url: r.url, title: r.title, bytes: r.bytes, truncated: r.truncated,
      }) + '\n');
    }
    process.stdout.write(r.markdown);
  } catch (e) {
    console.error(`error: ${e?.message || e}`);
    process.exit(1);
  }
}
export async function cmdSandbox(args, flags = {}) {
  const sub = args[0];

  if (!sub || sub === 'list') {
    for (const kind of listBackends()) process.stdout.write(`${kind}\n`);
    return 0;
  }

  if (sub === 'status') {
    // Show the EFFECTIVE default-on confinement posture for this host so the
    // operator can audit what sensitive tools run under.
    const cfg = _sandboxLoadConfigOrEmpty();
    const sb = cfg.sandbox || {};
    const off = sb.confine === false || sb.default === 'off' || sb.default === 'none';
    const confiner = (sb.local && sb.local.confiner && sb.local.confiner !== 'auto')
      ? sb.local.confiner
      : pickAvailableConfiner();
    const allowNet = sb.allowNet !== false;
    process.stdout.write(`confinement: ${off ? 'OFF' : 'ON'} (default-on; opt out with cfg.sandbox.confine=false)\n`);
    process.stdout.write(`host confiner: ${confiner}\n`);
    process.stdout.write(`policy: writes → workspace + temp only · secret dirs unreadable · network ${allowNet ? 'allowed' : 'denied'}\n`);
    if (!off && confiner === 'none') {
      process.stdout.write('note: no OS confiner available on this host — sensitive tools run UNCONFINED. Install bubblewrap or firejail on Linux.\n');
    }
    return 0;
  }

  if (sub === 'test') {
    const name = args[1];
    if (!name) { process.stderr.write('usage: pompos sandbox test <kind|profile>\n'); return 2; }
    const cfg = _sandboxLoadConfigOrEmpty();
    // If `name` looks like a known kind, route to that kind. If it
    // is not a known kind AND not a profile in cfg, treat as an
    // unknown identifier and report SANDBOX_BAD_KIND.
    const isKind = listBackends().includes(name);
    const profile = cfg.sandbox && cfg.sandbox.profiles && cfg.sandbox.profiles[name];
    if (!isKind && !profile) {
      process.stderr.write(`SANDBOX_BAD_KIND: unknown sandbox kind or profile "${name}"\n`);
      return 1;
    }
    let sb;
    try {
      const synthCfg = isKind
        ? { sandbox: { default: name, ...cfg.sandbox } }
        : cfg;
      sb = resolveSandbox(synthCfg);
    } catch (e) {
      process.stderr.write(`${e.code || 'SANDBOX_ERR'}: ${e.message}\n`); return 1;
    }
    if (sb.spec.kind !== 'local' && sb.spec.kind !== 'docker') {
      // Remote/serverless backends just construct argv in unit tests;
      // we report "shape-ok" without actually executing.
      process.stdout.write(`ok ${sb.spec.kind} (argv-shape)\n`);
      return 0;
    }
    const sess = await sb.open();
    try {
      const r = await sess.exec(['echo', 'pompos-sandbox-test']);
      if (r.code !== 0 || !/pompos-sandbox-test/.test(r.stdout)) {
        process.stderr.write(`fail ${name}: exit=${r.code} stdout=${r.stdout}\n`); return 1;
      }
      process.stdout.write(`ok ${name}\n`);
      return 0;
    } finally { await sess.close(); }
  }

  if (sub === 'add') {
    const name = args[1];
    if (!name) { process.stderr.write('usage: pompos sandbox add <name> --kind <kind> [...]\n'); return 2; }
    const opts = {};
    if (flags.kind) opts.kind = flags.kind;
    if (flags.image) opts.image = flags.image;
    if (flags.host) opts.host = flags.host;
    if (flags.user) opts.user = flags.user;
    if (flags.workspace) opts.workspace = flags.workspace;
    if (flags.app) opts.app = flags.app;
    if (flags.confiner) opts.confiner = flags.confiner;
    if (!listBackends().includes(opts.kind)) {
      process.stderr.write(`unknown kind "${opts.kind}"\n`); return 1;
    }
    const cfg = _sandboxLoadConfigOrEmpty();
    cfg.sandbox = cfg.sandbox || {};
    cfg.sandbox.profiles = cfg.sandbox.profiles || {};
    cfg.sandbox.profiles[name] = opts;
    _sandboxSaveConfig(cfg);
    process.stdout.write(`added profile ${name} (${opts.kind})\n`);
    return 0;
  }

  if (sub === 'use') {
    const name = args[1];
    if (!name) { process.stderr.write('usage: pompos sandbox use <profile>\n'); return 2; }
    const cfg = _sandboxLoadConfigOrEmpty();
    const prof = cfg.sandbox && cfg.sandbox.profiles && cfg.sandbox.profiles[name];
    if (!prof) { process.stderr.write(`no profile "${name}"\n`); return 1; }
    cfg.sandbox = cfg.sandbox || {};
    cfg.sandbox.default = prof.kind;
    cfg.sandbox[prof.kind] = { ...(cfg.sandbox[prof.kind] || {}), ...prof, kind: undefined };
    delete cfg.sandbox[prof.kind].kind;
    _sandboxSaveConfig(cfg);
    process.stdout.write(`using profile ${name} (${prof.kind})\n`);
    return 0;
  }

  process.stderr.write(`unknown subcommand "${sub}". Try: list | test | add | use\n`);
  return 2;
}

export function _sandboxLoadConfigOrEmpty() {
  const p = process.env.LAZYCLAW_CONFIG || configPath();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}

export function _sandboxSaveConfig(cfg) {
  const p = process.env.LAZYCLAW_CONFIG || configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}
