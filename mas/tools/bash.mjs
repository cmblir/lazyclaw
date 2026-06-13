// Bash tool — runs a shell command, captures stdout/stderr/exit.
//
// The command runs with cwd defaulted to the lazyclaw process cwd, but this
// is NOT an OS sandbox — absolute paths and `cd` escape it. Two real
// protections apply instead: (1) bash is a `sensitive` tool, so the
// fail-closed approval gate in tool_runner requires operator confirmation
// (or an explicit security.allowUnattendedSensitive opt-in) before it runs;
// (2) the child env is scrubbed of secrets (scrubEnv) so a command cannot
// exfiltrate API keys / channel tokens inherited from the parent or
// <configDir>/.env. Every invocation is still audit-logged for forensics.
//
// Timeout defaults to 30s so a runaway command can't stall the whole
// agent turn. Override via args.timeoutMs (capped at 5 minutes).

import { spawn } from 'node:child_process';
import { scrubEnv } from '../scrub_env.mjs';
import { spawnSandboxed } from '../../sandbox.mjs';

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

export async function exec(args, { cwd = process.cwd(), sandbox = null, _spawnSandboxed = spawnSandboxed } = {}) {
  if (!args || typeof args.command !== 'string' || args.command.trim() === '') {
    return { ok: false, error: 'bash: command is required (non-empty string)' };
  }
  const timeoutMs = Math.min(
    Math.max(Number.isFinite(+args.timeoutMs) ? +args.timeoutMs : DEFAULT_TIMEOUT_MS, 100),
    MAX_TIMEOUT_MS
  );
  return new Promise((resolve) => {
    // When a sandbox spec is present, run the SAME scrubbed `sh -c <cmd>`
    // inside it (containment ADDED, never replacing the approval gate); a
    // null/absent spec keeps the byte-stable bare-host path (unchanged).
    // _spawnSandboxed is a test injection seam — defaults to the real impl.
    const child = sandbox
      ? _spawnSandboxed(sandbox, 'sh', ['-c', args.command], { cwd, env: scrubEnv(process.env) })
      : spawn('sh', ['-c', args.command], { cwd, env: scrubEnv(process.env) });
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
