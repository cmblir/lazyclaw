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
  const cmd = ['lazyclaw', 'goal', 'tick', name];
  cron.upsertJob(cfg, jobName, schedule, cmd);
  writeConfig(cfg);
  if (process.env.LAZYCLAW_SKIP_CRON_INSTALL) return { jobName, skipped: true };
  const backend = cron.pickBackend();
  if (backend === 'launchd') cron.installLaunchdJob(jobName, schedule, cmd);
  else cron.installCrontabJob(jobName, schedule, cmd);
  return { jobName, skipped: false };
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
