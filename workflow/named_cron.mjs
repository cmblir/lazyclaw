// workflow/named_cron.mjs — schedule a named declarative workflow via cron.
//
// Mirrors goals_cron.mjs: install an OS cron job (launchd / crontab) whose
// command is `pompos workflow run <name>`, so the OS scheduler fires the
// stored workflow on its schedule (no resident daemon loop). The job runs the
// def and posts its reply to the bound channel (commands/workflow_named.mjs).
// LAZYCLAW_SKIP_CRON_INSTALL writes the config but skips the backend install,
// so the wiring is unit-testable with no real launchd/crontab.
//
// Note: launchd/crontab do NOT capture the shell env, so a scheduled run that
// posts to Slack needs SLACK_BOT_TOKEN available to the cron environment
// (export it in the launch context) — same requirement as the goal-tick fan-out.

import * as cronMod from '../cron.mjs';
import { readConfig as defaultRead, writeConfig as defaultWrite } from '../lib/config.mjs';

export function attachWorkflowCron(name, schedule, deps = {}) {
  const cron = deps.cron || cronMod;
  const readConfig = deps.readConfig || defaultRead;
  const writeConfig = deps.writeConfig || defaultWrite;
  cron.parseCronSpec(schedule); // validate before touching state
  const cfg = readConfig();
  const jobName = `wf-${name}`;
  const cmd = ['pompos', 'workflow', 'run', name];
  cron.upsertJob(cfg, jobName, schedule, cmd);
  writeConfig(cfg);
  if (process.env.LAZYCLAW_SKIP_CRON_INSTALL) return { jobName, skipped: true };
  const backend = cron.pickBackend();
  if (backend === 'launchd') cron.installLaunchdJob(jobName, schedule, cmd);
  else cron.installCrontabJob(jobName, schedule, cmd);
  return { jobName, skipped: false };
}

export function detachWorkflowCron(name, deps = {}) {
  const cron = deps.cron || cronMod;
  const readConfig = deps.readConfig || defaultRead;
  const writeConfig = deps.writeConfig || defaultWrite;
  const cfg = readConfig();
  const jobName = `wf-${name}`;
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
