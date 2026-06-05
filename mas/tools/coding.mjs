// coding — sandboxed code runners (python_exec, node_exec), data tools
// (sql_query stub, http_request that reuses web_fetch SSRF policy),
// and a pure helper (regex_match).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS as webTools } from './web.mjs';

function runProc(cmd, args, opts = {}) {
  return new Promise(resolve => {
    let p;
    try { p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '', err = '';
    const timeout = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, opts.timeoutMs || 30_000);
    p.on('error', e => { clearTimeout(timeout); resolve({ ok: false, error: e.message }); });
    p.stdout?.on('data', d => out += d.toString());
    p.stderr?.on('data', d => err += d.toString());
    p.on('close', code => { clearTimeout(timeout); resolve({ ok: code === 0, stdout: out, stderr: err, exitCode: code }); });
    if (opts.stdin != null) { p.stdin.write(opts.stdin); p.stdin.end(); }
  });
}

const python_exec = {
  name: 'python_exec', category: 'coding', sensitive: true,
  description: 'Run a Python snippet in a sandboxed subprocess. 30s timeout.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' }, timeoutMs: { type: 'number' } },
    required: ['code'],
  },
  async exec(args, ctx) {
    const py = ctx?.python || process.env.LAZYCLAW_PYTHON || 'python3';
    return runProc(py, ['-c', args.code], { cwd: ctx?.cwd, timeoutMs: args.timeoutMs });
  },
};

const node_exec = {
  name: 'node_exec', category: 'coding', sensitive: true,
  description: 'Run a Node.js snippet in a sandboxed subprocess. 30s timeout.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' }, timeoutMs: { type: 'number' } },
    required: ['code'],
  },
  async exec(args, ctx) {
    const node = ctx?.node || process.execPath;
    return runProc(node, ['-e', args.code], { cwd: ctx?.cwd, timeoutMs: args.timeoutMs });
  },
};

const sql_query = {
  name: 'sql_query', category: 'coding', sensitive: true,
  description: 'Run a read-only SQL query against the agent\'s bound database. Returns rows.',
  parameters: {
    type: 'object',
    properties: { sql: { type: 'string' }, params: { type: 'array' } },
    required: ['sql'],
  },
  async exec(args, ctx) {
    const db = ctx?.db || null;
    if (!db) return { ok: false, error: 'sql_query: no database bound to agent context' };
    try {
      const stmt = db.prepare(args.sql);
      const rows = stmt.all(...(args.params || []));
      return { ok: true, rows };
    } catch (e) { return { ok: false, error: `sql_query: ${e.message}` }; }
  },
};

const http_request = {
  name: 'http_request', category: 'coding', sensitive: true,
  description: 'Generic HTTP client. Reuses web_fetch SSRF policy.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' }, method: { type: 'string' },
      headers: { type: 'object' }, body: { type: 'string' },
    },
    required: ['url'],
  },
  async exec(args, ctx) {
    const wf = webTools.find(t => t.name === 'web_fetch');
    return wf.exec(args, ctx);
  },
};

const regex_match = {
  name: 'regex_match', category: 'coding', sensitive: false,
  description: 'Run a regex over a string and return the matches.',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string' }, flags: { type: 'string' }, text: { type: 'string' } },
    required: ['pattern', 'text'],
  },
  async exec(args) {
    try {
      const re = new RegExp(args.pattern, args.flags || '');
      const matches = args.flags?.includes('g')
        ? [...args.text.matchAll(re)].map(m => m[0])
        : (args.text.match(re) || []);
      return { ok: true, matches };
    } catch (e) { return { ok: false, error: `regex_match: ${e.message}` }; }
  },
};

export const TOOLS = [python_exec, node_exec, sql_query, http_request, regex_match];
