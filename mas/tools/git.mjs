// git — read-only inspection (status/diff/log/blame/branch) and two
// sensitive writes (commit/push). All shell out to git in ctx.cwd.

import { spawnSync } from 'node:child_process';

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
}

const git_status = {
  name: 'git_status', category: 'git', sensitive: false,
  description: 'Run `git status` in the workspace.',
  parameters: { type: 'object', properties: {} },
  async exec(_args, ctx) { return git(ctx?.cwd, ['status']); },
};

const git_diff = {
  name: 'git_diff', category: 'git', sensitive: false,
  description: 'Run `git diff [path]`. Pass {staged:true} for `--staged`.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } } },
  async exec(args, ctx) {
    const ar = ['diff'];
    if (args?.staged) ar.push('--staged');
    if (args?.path) ar.push('--', args.path);
    return git(ctx?.cwd, ar);
  },
};

const git_log = {
  name: 'git_log', category: 'git', sensitive: false,
  description: 'Recent commits as structured objects.',
  parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  async exec(args, ctx) {
    const n = Math.max(1, Math.min(args?.limit || 10, 100));
    const r = git(ctx?.cwd, ['log', `-n${n}`, '--pretty=format:%H%x09%an%x09%aI%x09%s']);
    if (!r.ok) return r;
    const commits = r.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, author, date, subject] = line.split('\t');
      return { hash, author, date, subject };
    });
    return { ok: true, commits };
  },
};

const git_blame = {
  name: 'git_blame', category: 'git', sensitive: false,
  description: 'Run `git blame <path>`.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async exec(args, ctx) { return git(ctx?.cwd, ['blame', '--', args.path]); },
};

const git_branch = {
  name: 'git_branch', category: 'git', sensitive: false,
  description: 'List branches.',
  parameters: { type: 'object', properties: {} },
  async exec(_args, ctx) {
    const r = git(ctx?.cwd, ['branch', '--all', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)']);
    if (!r.ok) return r;
    const branches = r.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, upstream, head] = line.split('\t');
      return { name, upstream, current: head === '*' };
    });
    return { ok: true, branches };
  },
};

const git_commit = {
  name: 'git_commit', category: 'git', sensitive: true,
  description: 'Stage paths (or skip when omitted) and commit.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      paths:   { type: 'array', items: { type: 'string' } },
      amend:   { type: 'boolean' },
    },
    required: ['message'],
  },
  async exec(args, ctx) {
    if (Array.isArray(args.paths) && args.paths.length) {
      const a = git(ctx?.cwd, ['add', '--', ...args.paths]);
      if (!a.ok) return a;
    }
    const ar = ['commit', '-m', args.message];
    if (args.amend) ar.splice(1, 0, '--amend');
    return git(ctx?.cwd, ar);
  },
};

const git_push = {
  name: 'git_push', category: 'git', sensitive: true,
  description: 'Push to a remote. Refuses --force unless force=true explicitly.',
  parameters: {
    type: 'object',
    properties: {
      remote: { type: 'string' }, branch: { type: 'string' },
      force:  { type: 'boolean' },
    },
  },
  async exec(args, ctx) {
    const ar = ['push'];
    if (args?.force) ar.push('--force-with-lease');
    if (args?.remote) ar.push(args.remote);
    if (args?.branch) ar.push(args.branch);
    return git(ctx?.cwd, ar);
  },
};

export const TOOLS = [git_status, git_diff, git_log, git_blame, git_branch, git_commit, git_push];
