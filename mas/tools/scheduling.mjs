// scheduling — cron_add / cron_remove / cron_list. Wraps cron.mjs but the
// backend is overridable for tests via __setCronBackend.

let _backend = null;
export function __setCronBackend(b) { _backend = b; }

async function getBackend() {
  if (_backend) return _backend;
  const cron = await import('../../cron.mjs').catch(() => null);
  if (!cron) throw new Error('scheduling: cron.mjs not available');
  return {
    add:    async (j) => cron.add ? cron.add(j) : { ok: false, error: 'cron.add missing' },
    list:   async ()  => cron.list ? cron.list() : [],
    remove: async (n) => cron.remove ? cron.remove(n) : { ok: false, error: 'cron.remove missing' },
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
