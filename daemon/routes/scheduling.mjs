// Daemon route handlers (scheduling) — a read-mostly window onto the three
// scheduling surfaces the CLI owns: cron jobs (cfg.cron), durable goals
// (<configDir>/goals/*.json), and loop runs (<configDir>/loops/*/).
//
// Deliberately NO create endpoint: scheduling a job installs a launchd/crontab
// entry that runs a command, and this daemon is loopback-but-unauthenticated by
// default (`lazyclaw dashboard` mints no token), so creation stays in the
// trusted CLI. The one mutation exposed is DELETE /cron/<name> — removing a
// schedule only ever reduces what runs, is reversible from the CLI, and is
// guarded by ctx.writeConfig so a read-only daemon refuses it.

import { writeJson } from './_deps.mjs';

export async function schedulingList(c) {
  const { ctx, gwConfigDir, res } = c;
  const cfg = ctx.readConfig();
  let cron = [];
  let goals = [];
  let loops = [];
  try { const m = await import('../../cron.mjs'); cron = m.listJobs(cfg); } catch { /* none */ }
  try { const m = await import('../../goals.mjs'); goals = m.listGoals(gwConfigDir); } catch { /* none */ }
  try {
    const m = await import('../../loops.mjs');
    loops = m.listLoops(gwConfigDir).map((l) => m.reconcileStatus(l));
  } catch { /* none */ }
  return writeJson(res, 200, { cron, goals, loops });
}

export async function cronDelete(c) {
  const { ctx, res, url } = c;
  if (typeof ctx.writeConfig !== 'function') {
    return writeJson(res, 405, { error: 'mutation disabled' });
  }
  const match = url.pathname.match(/^\/cron\/([^/]+)$/);
  const name = match ? decodeURIComponent(match[1]) : '';
  const cron = await import('../../cron.mjs');
  const cfg = ctx.readConfig();
  try { cron.removeJob(cfg, name); }
  catch (e) { return writeJson(res, 404, { error: e?.message || String(e) }); }
  ctx.writeConfig(cfg);
  // Best-effort OS teardown — cfg is the source of truth, so a launchctl /
  // crontab hiccup must not fail the delete (`cron sync` reconciles later).
  try {
    if (cron.pickBackend() === 'launchd') cron.uninstallLaunchdJob(name);
    else cron.uninstallCrontabJob(name);
  } catch { /* best-effort */ }
  return writeJson(res, 200, { ok: true, removed: name });
}
