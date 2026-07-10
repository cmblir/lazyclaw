// scheduling — cron_add / cron_remove / cron_list. Wraps cron.mjs but the
// backend is overridable for tests via __setCronBackend.

let _backend = null;
export function __setCronBackend(b) { _backend = b; }

async function getBackend() {
  if (_backend) return _backend;
  // cron.mjs is config-object-shaped (upsertJob/listJobs/removeJob mutate a cfg),
  // not the add/list/remove the old code assumed — so every tool call used to hit
  // the "cron.add missing" fallback. Wire the tools to the real API plus the
  // shared config IO, and install/uninstall the OS-level job (skippable in tests
  // via LAZYCLAW_SKIP_CRON_INSTALL, mirroring goals_cron.mjs).
  const cron = await import('../../cron.mjs').catch(() => null);
  if (!cron) throw new Error('scheduling: cron.mjs not available');
  const { readConfig, writeConfig } = await import('../../lib/config.mjs');
  const skipInstall = () => !!process.env.LAZYCLAW_SKIP_CRON_INSTALL;
  const install = (name, schedule, command) => {
    if (skipInstall()) return;
    if (cron.pickBackend() === 'launchd') cron.installLaunchdJob(name, schedule, command);
    else cron.installCrontabJob(name, schedule, command);
  };
  const uninstall = (name) => {
    if (skipInstall()) return;
    if (cron.pickBackend() === 'launchd') cron.uninstallLaunchdJob(name);
    else cron.uninstallCrontabJob(name);
  };
  return {
    add: async ({ name, spec, command }) => {
      // Persist the LOGICAL command; cron.mjs resolves a bare "lazyclaw" to an
      // absolute node + CLI launcher at install/run time (buildPlist /
      // buildCrontabLine / runJob call resolveCommand), so config.json stays
      // portable and machine-independent.
      const cmd = Array.isArray(command) ? command : [String(command)];
      const cfg = readConfig();
      const status = cron.upsertJob(cfg, name, spec, cmd);
      writeConfig(cfg);
      install(name, spec, cmd);
      return { ok: true, name, status };
    },
    list: async () => cron.listJobs(readConfig()),
    remove: async (name) => {
      const cfg = readConfig();
      cron.removeJob(cfg, name);
      writeConfig(cfg);
      uninstall(name);
      return { ok: true, removed: name };
    },
  };
}

// Field-count validator independent of cron.mjs internals so we get a clean error.
function looksLikeCronSpec(s) {
  return typeof s === 'string' && s.trim().split(/\s+/).length === 5;
}

const cron_add = {
  name: 'cron_add', category: 'scheduling', sensitive: true,
  description: 'Schedule a recurring agent run or shell command.',
  parameters: {
    type: 'object',
    properties: {
      name:    { type: 'string' },
      spec:    { type: 'string', description: '5-field cron spec.' },
      command: { type: 'string' },
    },
    required: ['name', 'spec', 'command'],
  },
  async exec(args) {
    if (!looksLikeCronSpec(args.spec)) return { ok: false, error: `cron_add: bad cron spec "${args.spec}"` };
    const b = await getBackend();
    return b.add({ name: args.name, spec: args.spec, command: args.command });
  },
};

const cron_remove = {
  name: 'cron_remove', category: 'scheduling', sensitive: true,
  description: 'Remove a scheduled job by name.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async exec(args) {
    const b = await getBackend();
    return b.remove(args.name);
  },
};

const cron_list = {
  name: 'cron_list', category: 'scheduling', sensitive: true,
  description: 'List scheduled jobs.',
  parameters: { type: 'object', properties: {} },
  async exec() {
    const b = await getBackend();
    return { ok: true, jobs: await b.list() };
  },
};

export const TOOLS = [cron_add, cron_remove, cron_list];
