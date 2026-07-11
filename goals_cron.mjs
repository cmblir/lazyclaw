// goals_cron.mjs — attach/detach a cron schedule to a goal.
//
// Extracted from cli.mjs (_attachGoalCron / _detachGoalCron) so the Ink
// /goal slash can actually schedule (and unschedule) a goal instead of just
// recording the cron string and telling the user to re-run from the CLI.
// Dependency-injected on readConfig / writeConfig and the cron module so the
// core unit-tests with a fake cron and no real launchd/crontab writes.
// `LAZYCLAW_SKIP_CRON_INSTALL` skips the backend install (config still written).

export async function attachGoalCron({ readConfig, writeConfig, cron, name, schedule }) {
  cron.parseCronSpec(schedule); // validate before touching state
  const cfg = readConfig();
  const jobName = `goal-${name}`;
  // Persist the LOGICAL command so config.json stays portable/readable and
  // machine-independent. The bare "lazyclaw" token is resolved to an absolute
  // node + CLI entry only where the OS scheduler actually consumes it — inside
  // cron.mjs buildPlist / buildCrontabLine / runJob (resolveCommand) — which
  // is where the minimal, shell-less PATH would otherwise break it.
  const cmd = ['lazyclaw', 'goal', 'tick', name];
  cron.upsertJob(cfg, jobName, schedule, cmd);
  writeConfig(cfg);
  if (process.env.LAZYCLAW_SKIP_CRON_INSTALL) return { jobName, skipped: true };
  const backend = cron.pickBackend();
  if (backend === 'launchd') cron.installLaunchdJob(jobName, schedule, cmd);
  else cron.installCrontabJob(jobName, schedule, cmd);
  return { jobName, skipped: false };
}

// Run a single goal tick under the cross-process singleton lock with an
// overlap policy. A slow scheduled tick still running when the next cron fire
// arrives — or a manual `goal tick` racing the scheduled one — is a SEPARATE
// process; without this guard both open the same goal:<name> session and
// concurrently appendCheckIn, interleaving/losing writes. Default overlap
// policy is SKIP: if a live holder owns the lock, we do NOT run and return
// { skipped:true }. Fully dependency-injected so tests drive it with a fake
// runner and no real provider/session.
//
// Additive + opt-in: `commands/automation.mjs` adopts this at the tick site;
// nothing else changes. Failure-isolated — the lock releases in finally.
export async function runGoalTick({ name, withGoalLock, runTick, lockOpts }) {
  if (typeof withGoalLock !== 'function') throw new Error('runGoalTick requires withGoalLock');
  if (typeof runTick !== 'function') throw new Error('runGoalTick requires runTick');
  const outcome = await withGoalLock(name, () => runTick(), lockOpts || {});
  if (outcome && outcome.skipped) {
    // Overlap: another tick for this goal is in flight. Log + skip so the
    // scheduler does not crash and no interleaved check-in lands.
    if (process.env.LAZYCLAW_DEBUG) {
      const holderPid = outcome.holder && outcome.holder.pid;
      console.error(`goal tick "${name}" skipped: another tick is running${holderPid ? ` (pid ${holderPid})` : ''}`);
    }
    return { skipped: true, holder: outcome.holder || null };
  }
  return { skipped: false, result: outcome ? outcome.result : undefined };
}

export async function detachGoalCron({ readConfig, writeConfig, cron, name }) {
  const cfg = readConfig();
  const jobName = `goal-${name}`;
  if (!cfg.cron || !cfg.cron[jobName]) return false;
  cron.removeJob(cfg, jobName);
  writeConfig(cfg);
  if (process.env.LAZYCLAW_SKIP_CRON_INSTALL) return true;
  const backend = cron.pickBackend();
  try {
    if (backend === 'launchd') cron.uninstallLaunchdJob(jobName);
    else cron.uninstallCrontabJob(jobName);
  } catch { /* best-effort — cron sync recovers */ }
  return true;
}
