// Codex subscription/CLI provider (no API key).
//
// Spawns the local `codex` CLI binary (OpenAI's Codex CLI shipped from
// npm: @openai/codex) in non-interactive mode:
//
//   codex exec --skip-git-repo-check --json [-m model] "<prompt>"
//
// Auth is whatever `codex` is signed into — a ChatGPT Plus/Pro/Business
// session bound to ~/.codex/auth — so no OPENAI_API_KEY is required and
// no key lands in the lazyclaw config. This is the CLI counterpart to
// providers/openai.mjs (which talks to api.openai.com and needs an API
// key).
//
// Output protocol (NDJSON on stdout, one JSON object per line):
//   {"type":"thread.started", "thread_id": "..."}
//   {"type":"turn.started"}
//   {"type":"item.completed", "item": {"type":"agent_message","text":"..."}}
//   {"type":"turn.completed", "usage": {...}}
//
// We stream-parse line-by-line and yield the `text` field of every
// agent_message item. Reasoning items (`item.type === 'reasoning'`)
// are skipped — they're internal thought summaries, not the visible
// answer. Usage from turn.completed is surfaced via onUsage.
//
// Why `--skip-git-repo-check` is hard-coded: lazyclaw orchestrator
// runs workers from scratch dirs (often /tmp) that aren't git repos,
// and codex's default git-repo gate would reject every such spawn.
// The flag is a UX shim for headless invocation, not a security
// downgrade — we're handing codex our own prompt, not user-trusted
// shell input.

import { spawnSandboxed } from '../sandbox.mjs';
import { classifyCliExit } from './cli_error.mjs';

class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT';
  }
}

class CliMissingError extends Error {
  constructor() {
    super('codex CLI not found in PATH — install @openai/codex or use the openai API provider');
    this.name = 'CodexCliMissingError';
    this.code = 'CLI_MISSING';
  }
}

class CliExitError extends Error {
  constructor(code, signal, stderr) {
    super(`codex CLI exited ${code ?? signal}: ${String(stderr).slice(0, 400)}`);
    this.name = 'CodexCliExitError';
    // Transient upstream throttle → retriable RATE_LIMIT; genuine cap → CLI_EXIT.
    const cls = classifyCliExit(stderr);
    this.code = cls.code;
    if (cls.retryAfterMs !== undefined) this.retryAfterMs = cls.retryAfterMs;
    this.exitCode = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

// No alias map. The previous aliases mapped "codex"/"gpt-codex" to
// "gpt-5-codex", but that model is rejected by a ChatGPT-account codex
// login ("not supported when using Codex with a ChatGPT account"), so the
// alias actively produced a broken `-m`. An empty/unknown model now means
// "no -m" → codex falls back to the account default in ~/.codex/config.toml,
// which is the only model set guaranteed to be allowed for that login.
const _ALIASES = {};

// Drop cross-vendor model ids (claude-*, gemini-*) silently so the
// CLI falls back to its own default. The orchestrator workflow forwards
// cfg.model verbatim to every worker, and `providers test` does the
// same — both would otherwise crash here when cfg.model is Anthropic
// or Google.
function resolveModel(model) {
  if (!model) return '';
  const lower = String(model).toLowerCase();
  if (_ALIASES[lower]) return _ALIASES[lower];
  if (
    lower.startsWith('gpt-') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4')
  ) return String(model);
  return '';
}

function buildPrompt(messages, system) {
  const parts = [];
  if (system) parts.push(`[System instructions: ${system}]`);
  for (const m of messages) {
    if (!m || !m.content) continue;
    if (m.role === 'system' && !system) parts.push(`[System instructions: ${m.content}]`);
    else if (m.role === 'user') parts.push(`User: ${m.content}`);
    else if (m.role === 'assistant') parts.push(`Assistant: ${m.content}`);
  }
  return parts.length ? parts.join('\n') + '\n\nAssistant:' : '';
}

// Pull text out of a single NDJSON event. We only surface agent_message
// items (the visible answer). Reasoning summaries are intentionally
// dropped so the orchestrator's planner doesn't see the model's
// internal deliberation as part of "the worker's answer".
function extractEventText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type !== 'item.completed') return '';
  const item = obj.item || {};
  if (item.type === 'agent_message' && typeof item.text === 'string') return item.text;
  return '';
}

// Pull a human-readable error out of a codex failure event. Codex reports
// API/turn failures on STDOUT (not stderr) as either:
//   {"type":"error","message":"<json-string>"}
//   {"type":"turn.failed","error":{"message":"<json-string>"}}
// where the message is usually itself a JSON document
//   {"type":"error","status":400,"error":{"message":"<the real reason>"}}.
// We unwrap one level of nesting so callers surface "The 'x' model is not
// supported …" instead of the misleading "Reading additional input from
// stdin…" the CLI happens to print on stderr. Returns '' for non-error events.
function extractEventError(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type !== 'error' && obj.type !== 'turn.failed') return '';
  let raw = obj.type === 'turn.failed' ? (obj.error?.message ?? obj.message) : obj.message;
  if (typeof raw === 'string') {
    try {
      const inner = JSON.parse(raw);
      raw = inner?.error?.message || inner?.message || raw;
    } catch (_) { /* not nested JSON — use the string as-is */ }
  }
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? obj);
}

function extractUsage(obj) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'turn.completed') return null;
  const u = obj.usage || {};
  const input = (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0);
  const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  if (!input && !output) return null;
  return { inputTokens: input, outputTokens: output, totalCostUsd: 0 };
}

export const codexCliProvider = {
  name: 'codex-cli',
  async *sendMessage(messages, opts = {}) {
    const bin = opts.bin || 'codex';
    const prompt = buildPrompt(messages, opts.system || messages.find(m => m.role === 'system')?.content);
    if (!prompt) return;

    const args = ['exec', '--skip-git-repo-check', '--json'];
    const model = resolveModel(opts.model);
    if (model) args.push('-m', model);
    args.push(prompt);

    if (opts.signal?.aborted) throw new AbortError('aborted before spawn');

    let proc;
    try {
      proc = spawnSandboxed(opts.sandbox || null, bin, args, {
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new CliMissingError();
      throw err;
    }

    const onAbort = () => { try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ } };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort);

    // A missing binary surfaces as an ASYNC ChildProcess 'error' event on
    // some platforms (the sync try/catch above doesn't see it). Without a
    // listener that's an uncaughtException that kills the WHOLE process mid
    // `providers test` — capture it and surface a per-provider CliMissingError
    // instead (same fix claude_cli.mjs received in F8).
    let spawnError = null;
    const spawnErrorPromise = new Promise((resolve) => {
      proc.once('error', (err) => { spawnError = err; resolve(); });
    });

    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.stdout.setEncoding('utf8');
    let buffer = '';
    let apiError = null;
    let exitInfo = null;
    const exitPromise = new Promise((resolve) => {
      proc.on('close', (code, signal) => {
        exitInfo = { code, signal };
        resolve();
      });
    });

    try {
      for await (const chunk of proc.stdout) {
        if (opts.signal?.aborted) throw new AbortError('aborted mid-stream');
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          const text = extractEventText(obj);
          if (text) yield text;
          const errMsg = extractEventError(obj);
          if (errMsg) apiError = errMsg;
          const usage = extractUsage(obj);
          if (usage && typeof opts.onUsage === 'function') {
            try { opts.onUsage(usage); } catch (_) { /* never break stream on usage */ }
          }
        }
      }
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer.trim());
          const text = extractEventText(obj);
          if (text) yield text;
        } catch (_) { /* incomplete tail — drop */ }
      }
      // Wait for either a clean exit or an async spawn error. On ENOENT the
      // process never starts, so 'close' never fires — racing against
      // spawnErrorPromise keeps this from hanging forever.
      await Promise.race([exitPromise, spawnErrorPromise]);
      if (spawnError) {
        throw spawnError.code === 'ENOENT' ? new CliMissingError() : spawnError;
      }
      // Prefer the real API/turn error (carried on stdout) over the CLI's
      // unhelpful stderr ("Reading additional input from stdin…"). codex
      // exits non-zero on turn.failed, so this runs before the generic
      // exit-code branch and gives the actionable message.
      if (apiError && !opts.signal?.aborted) {
        throw new CliExitError(exitInfo?.code ?? 1, exitInfo?.signal ?? null, apiError);
      }
      if (exitInfo && exitInfo.code !== 0 && !opts.signal?.aborted) {
        throw new CliExitError(exitInfo.code, exitInfo.signal, stderr);
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (!proc.killed && exitInfo === null) {
        try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      }
    }
  },
};

export { CliMissingError, CliExitError, AbortError, resolveModel, buildPrompt, extractEventText, extractEventError, extractUsage };
