// Bash tool — runs a shell command, captures stdout/stderr/exit.
//
// Workspace is constrained to the lazyclaw process cwd (spec §5.2). We
// don't sandbox further (per §10 #6 — destructive-pattern confirmation
// is OFF by default); the audit log captures every invocation so post-hoc
// forensics work.
//
// Timeout defaults to 30s so a runaway command can't stall the whole
// agent turn. Override via args.timeoutMs (capped at 5 minutes).

import { spawn } from 'node:child_process';

export const NAME = 'bash';
export const DESCRIPTION = 'Run a shell command in the agent\'s workspace. Returns {stdout, stderr, exitCode}. Timeout 30s by default.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to execute.' },
    timeoutMs: { type: 'number', description: 'Optional override (max 300000).' },
  },
  required: ['command'],
};

const MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 200_000;  // 200 KB per stream — bigger gets truncated

export async function exec(args, { cwd = process.cwd() } = {}) {
  if (!args || typeof args.command !== 'string' || args.command.trim() === '') {
    return { ok: false, error: 'bash: command is required (non-empty string)' };
  }
  const timeoutMs = Math.min(
    Math.max(Number.isFinite(+args.timeoutMs) ? +args.timeoutMs : DEFAULT_TIMEOUT_MS, 100),
    MAX_TIMEOUT_MS
  );
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', args.command], { cwd, env: process.env });
    let stdout = '', stderr = '';
    let outBytes = 0, errBytes = 0;
    let truncated = false;
    let timedOut = false;
    const tm = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      outBytes += s.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        if (!truncated) stdout += s.slice(0, Math.max(0, MAX_OUTPUT_BYTES - (outBytes - s.length))) + '\n…[truncated]\n';
        truncated = true;
      } else {
        stdout += s;
      }
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      errBytes += s.length;
      if (errBytes > MAX_OUTPUT_BYTES) {
        if (!truncated) stderr += s.slice(0, Math.max(0, MAX_OUTPUT_BYTES - (errBytes - s.length))) + '\n…[truncated]\n';
        truncated = true;
      } else {
        stderr += s;
      }
    });
    child.on('close', (code) => {
      clearTimeout(tm);
      resolve({
        ok: true,
        stdout, stderr,
        exitCode: code,
        timedOut,
        truncated,
      });
    });
  });
}
