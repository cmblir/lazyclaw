// Claude subscription provider (no API key).
//
// Spawns the local `claude` CLI binary that ships with Claude Code and
// streams the JSON event format it emits with:
//
//   claude -p "<prompt>" --output-format stream-json
//          --include-partial-messages --verbose [--model opus|sonnet|haiku]
//
// The user's authentication is whatever `claude` is already logged in
// with — i.e. an Anthropic Pro / Max / Team subscription session — so
// no API key is needed and no key shows up in the pompos config.
//
// Why this is a separate provider from ./anthropic.mjs:
// - anthropic.mjs talks to api.anthropic.com directly and requires
//   `sk-ant-` keys (pay-per-token).
// - claude_cli.mjs delegates auth + billing entirely to the `claude`
//   CLI's already-established session (Pro/Max subscription quota).
// Both can coexist; users pick at onboard time.

import { spawn } from 'node:child_process';
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
    super('claude CLI not found in PATH — install Claude Code or use the anthropic provider');
    this.name = 'ClaudeCliMissingError';
    this.code = 'CLI_MISSING';
  }
}

class CliExitError extends Error {
  constructor(code, signal, stderr) {
    super(`claude CLI exited ${code ?? signal}: ${String(stderr).slice(0, 400)}`);
    this.name = 'ClaudeCliExitError';
    // A transient upstream throttle (claude's "Server temporarily limiting
    // requests", overload, 429/5xx) maps to a retriable RATE_LIMIT so
    // withRateLimitRetry retries it; a genuine usage cap stays CLI_EXIT.
    const cls = classifyCliExit(stderr);
    this.code = cls.code;
    if (cls.retryAfterMs !== undefined) this.retryAfterMs = cls.retryAfterMs;
    this.exitCode = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

// Map canonical Anthropic model ids and friendly aliases to the short
// form `claude --model` actually accepts. The Python dashboard ran into
// the same issue (FF1) — passing the full id silently hangs the CLI.
const _CLI_MODEL_ALIASES = {
  'claude-fable-5':       'fable',
  'claude-opus-4-8':      'opus',
  'claude-opus-4-7':      'opus',
  'claude-opus-4-6':      'opus',
  'claude-sonnet-4-6':    'sonnet',
  'claude-sonnet-4-5':    'sonnet',
  'claude-haiku-4-5':     'haiku',
  'claude-haiku-4-5-20251001': 'haiku',
  fable: 'fable',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

function resolveModelAlias(model) {
  if (!model) return '';
  const lower = String(model).toLowerCase();
  if (_CLI_MODEL_ALIASES[lower]) return _CLI_MODEL_ALIASES[lower];
  // Unknown but already a bare short alias (e.g. a new tier the table doesn't
  // enumerate yet, like a future "opusplus") → pass it through rather than
  // dropping to '' (which makes the CLI silently ignore the user's model
  // choice). Full canonical ids (with digits/dashes) stay mapped-or-dropped,
  // because passing a full id to `claude --model` hangs the CLI (FF1).
  if (/^[a-z]+$/.test(lower)) return lower;
  return '';
}

// Flatten the chat-style messages array into a single -p prompt the
// CLI accepts. Mirrors how the dashboard formats Claude turns when it
// has no native multi-turn channel.
function buildPrompt(messages, system) {
  const parts = [];
  if (system) parts.push(`[System instructions: ${system}]`);
  for (const m of messages) {
    if (!m || !m.content) continue;
    if (m.role === 'system' && !system) parts.push(`[System instructions: ${m.content}]`);
    else if (m.role === 'user') parts.push(`User: ${m.content}`);
    else if (m.role === 'assistant') parts.push(`Assistant: ${m.content}`);
  }
  // Trailing "Assistant:" cue so the CLI continues the conversation.
  return parts.length ? parts.join('\n') + '\n\nAssistant:' : '';
}

// Walk the partial-message JSON stream and pull text deltas out. The
// `claude` CLI emits one JSON object per line; the shapes we care about:
//   { type: 'stream_event', event: { type: 'content_block_delta',
//     delta: { type: 'text_delta', text: '...' } } }
//   { type: 'result', usage: {...}, total_cost_usd: ... }
function extractTextDelta(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type !== 'stream_event') return '';
  const ev = obj.event || {};
  if (ev.type === 'content_block_delta') {
    const d = ev.delta || {};
    if (d.type === 'text_delta' && typeof d.text === 'string') return d.text;
  }
  return '';
}

// Build the `claude` argv. By DEFAULT pompos runs claude LEAN: pompos
// supplies its own system prompt, so claude must NOT inherit the user's global
// CLAUDE.md / skills / hooks / MCP servers. Loading them made every turn pull
// ~180k tokens (measured) and let Claude Code act on the user's personal config
// instead of pompos's prompt — slow and off-task. `--setting-sources ''`
// loads none of user/project/local; `--strict-mcp-config` (no --mcp-config)
// loads no MCP servers. Pass opts.lean=false to restore the full environment.
export function buildArgs(prompt, opts = {}) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (opts.lean !== false) {
    args.push('--setting-sources', '', '--strict-mcp-config');
  }
  // Bound Claude Code's internal autonomous agent loop. A plain chat/worker
  // completion is ONE turn with NO built-in tools — without this a single
  // question can trigger Claude Code's full Read/Grep/Bash exploration loop
  // (measured 6-11 internal model calls, 90-126s) instead of just answering.
  // Callers that genuinely want agentic behavior raise maxTurns and pass a
  // tools whitelist (the agentic/team path uses the tool-use adapter instead).
  const maxTurns = opts.maxTurns == null ? 1 : opts.maxTurns;
  if (maxTurns > 0) args.push('--max-turns', String(maxTurns));
  args.push('--tools', opts.tools == null ? '' : String(opts.tools));
  // Permission mode (e.g. bypassPermissions) so the agent doesn't stop to ask
  // before every tool. Only emitted when set — the caller centralises the
  // default via lib/permission_mode.resolvePermissionMode.
  if (opts.permissionMode) args.push('--permission-mode', String(opts.permissionMode));
  const modelAlias = resolveModelAlias(opts.model);
  if (modelAlias) args.push('--model', modelAlias);
  return args;
}

export const claudeCliProvider = {
  name: 'claude-cli',
  /**
   * @param {Array<{role:string,content:string}>} messages
   * @param {{
   *   model?: string,
   *   system?: string,
   *   signal?: AbortSignal,
   *   bin?: string,           // override the resolved binary (tests)
   *   cwd?: string,           // working dir for the subprocess
   *   onUsage?: (u: object) => void,
   * }} opts
   */
  async *sendMessage(messages, opts = {}) {
    const bin = opts.bin || 'claude';

    // Opt-in persistent stream-json session: reuse ONE warm `claude` per
    // conversation (the harness boots once, not every turn). Send only the NEW
    // user turn — the session holds prior context server-side. We must NOT fall
    // back to a fresh one-shot spawn once a chunk has been yielded (that would
    // re-run the turn), so only fall through on a PRE-yield failure.
    if (opts.persistent && opts.sessionKey) {
      const last = [...messages].reverse().find((m) => m && m.role === 'user');
      if (last && String(last.content).trim()) {
        const { getSession } = await import('./claude_cli_session.mjs');
        const session = getSession(opts.sessionKey, {
          bin, model: opts.model, cwd: opts.cwd, lean: opts.lean,
          maxTurns: opts.maxTurns, tools: opts.tools, permissionMode: opts.permissionMode,
          system: opts.sessionSystem || opts.system || messages.find((m) => m.role === 'system')?.content,
        });
        let yielded = false;
        try {
          for await (const chunk of session.send(String(last.content), { signal: opts.signal, onUsage: opts.onUsage, onTruncated: opts.onTruncated })) {
            yielded = true;
            yield chunk;
          }
          return;
        } catch (err) {
          if (yielded || err?.code === 'ABORT') throw err; // can't re-run mid-stream
          // pre-yield session failure → fall through to the one-shot spawn below
        }
      }
    }

    const prompt = buildPrompt(messages, opts.system || messages.find(m => m.role === 'system')?.content);
    if (!prompt) return;

    const args = buildArgs(prompt, opts);

    if (opts.signal?.aborted) throw new AbortError('aborted before spawn');

    let proc;
    try {
      // opts.sandbox (parsed by parseSandboxSpec) routes the spawn
      // through `docker run` instead of running `claude` on the
      // host. spawnSandboxed is a no-op when sandbox is null, so
      // the un-sandboxed path stays bit-identical to before.
      proc = spawnSandboxed(opts.sandbox || null, bin, args, {
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // ENOENT means the binary isn't on PATH. Surface a clearer error
      // than the raw spawn failure so onboard / doctor can hint at
      // "install Claude Code or pick a different provider".
      if (err && err.code === 'ENOENT') throw new CliMissingError();
      throw err;
    }

    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
    };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort);

    // child_process reports spawn failures (ENOENT when `claude` isn't on
    // PATH, EACCES, ...) ASYNCHRONOUSLY via an 'error' event — the
    // synchronous try/catch around spawn above never sees them. Without a
    // listener Node escalates the unhandled 'error' event to an
    // uncaughtException and crashes the whole process; on a box with no
    // claude binary (e.g. CI) this took down `providers test` for the CLI
    // and the daemon entirely. Capture it and surface it through the stream
    // as a normal, catchable error so callers report it per-provider.
    let spawnError = null;
    const spawnErrorPromise = new Promise((resolve) => {
      proc.once('error', (err) => { spawnError = err; resolve(); });
    });

    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    // The stdout protocol is newline-delimited JSON. We buffer partial
    // lines across chunks (shapes can straddle a single read).
    proc.stdout.setEncoding('utf8');
    let buffer = '';
    let exitInfo = null;
    const exitPromise = new Promise((resolve) => {
      proc.on('close', (code, signal) => {
        exitInfo = { code, signal };
        resolve();
      });
    });

    // Accumulate per-turn usage from `assistant` events. The streaming `result`
    // event reports ZERO token usage (verified on claude 2.1.185), so reading it
    // dropped input/output counts to 0; the truthful per-turn usage rides the
    // `assistant` message event. Emit on the result event (which carries cost),
    // summing across assistant events so a multi-turn run reports its total.
    const _usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, saw: false };
    const _accumulateUsage = (obj) => {
      if (obj?.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        _usage.input += u.input_tokens || 0;
        _usage.output += u.output_tokens || 0;
        _usage.cacheCreate += u.cache_creation_input_tokens || 0;
        _usage.cacheRead += u.cache_read_input_tokens || 0;
        _usage.saw = true;
      }
      if (obj?.type === 'result' && typeof opts.onUsage === 'function') {
        try {
          opts.onUsage({
            inputTokens: _usage.saw ? _usage.input : (obj.usage?.input_tokens || 0),
            outputTokens: _usage.saw ? _usage.output : (obj.usage?.output_tokens || 0),
            cacheCreationInputTokens: _usage.cacheCreate,
            cacheReadInputTokens: _usage.cacheRead,
            totalCostUsd: obj.total_cost_usd || 0,
          });
        } catch (_) { /* never fail the stream on a usage callback */ }
      }
    };

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
          const text = extractTextDelta(obj);
          if (text) yield text;
          _accumulateUsage(obj);
        }
      }
      // Drain trailing buffered line — handle usage too, so a result line that
      // isn't newline-terminated still reports tokens + cost.
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer.trim());
          const text = extractTextDelta(obj);
          if (text) yield text;
          _accumulateUsage(obj);
        } catch (_) { /* incomplete tail — drop */ }
      }
      // Wait for either a clean exit or an async spawn error. On ENOENT
      // the process never starts, so 'close' never fires — racing against
      // spawnErrorPromise keeps this from hanging forever.
      await Promise.race([exitPromise, spawnErrorPromise]);
      if (spawnError) {
        throw spawnError.code === 'ENOENT' ? new CliMissingError() : spawnError;
      }
      if (exitInfo && exitInfo.code !== 0 && !opts.signal?.aborted) {
        throw new CliExitError(exitInfo.code, exitInfo.signal, stderr);
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      // Make sure we don't leave a runaway subprocess if the consumer
      // bailed mid-iteration without explicit abort.
      if (!proc.killed && exitInfo === null) {
        try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      }
    }
  },
};

export { CliMissingError, CliExitError, AbortError, resolveModelAlias, buildPrompt };
// buildArgs is also exported at its definition (lean-flag seam).
