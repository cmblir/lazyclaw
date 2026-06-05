// Gemini subscription/CLI provider (no API key).
//
// Spawns the local `gemini` CLI binary (the Google Gemini CLI shipped
// from npm: @google/gemini-cli) in non-interactive mode:
//
//   gemini --skip-trust -p "<prompt>" -o json [-m model]
//
// Auth is whatever `gemini` is already signed into on the host —
// Google account / Vertex / AI Studio session — so no GEMINI_API_KEY
// is required and no key lands in the lazyclaw config. This is the
// CLI counterpart to providers/gemini.mjs (which talks to the
// Generative Language API and needs an API key).
//
// Output shape (one JSON object on stdout):
//   { session_id, response: "<text>", stats: { models: {...} } }
//
// We capture stdout in full, parse the JSON once, and yield the
// `response` string in a single chunk. The orchestrator and chat
// REPL both treat AsyncIterable<string> as their only contract, so
// non-streaming is transparent to callers.
//
// Why `--skip-trust` is hard-coded: lazyclaw orchestrator / workflow
// subprocesses commonly run from /tmp or scratch dirs which gemini's
// trusted-folder policy rejects. We are spawning gemini ourselves with
// our own prompt, so the policy adds friction without security value.

import { spawnSandboxed } from '../sandbox.mjs';

class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT';
  }
}

class CliMissingError extends Error {
  constructor() {
    super('gemini CLI not found in PATH — install @google/gemini-cli or use the gemini API provider');
    this.name = 'GeminiCliMissingError';
    this.code = 'CLI_MISSING';
  }
}

class CliExitError extends Error {
  constructor(code, signal, stderr) {
    super(`gemini CLI exited ${code ?? signal}: ${String(stderr).slice(0, 400)}`);
    this.name = 'GeminiCliExitError';
    this.code = 'CLI_EXIT';
    this.exitCode = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

// `gemini -m` accepts the marketing model id directly (e.g. gemini-2.5-pro),
// so unlike claude_cli no alias map is needed. We still normalize a few
// shorthand inputs that users have typed in chat config.
const _ALIASES = {
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-pro',
  'gemini-flash': 'gemini-2.5-flash',
};

// Drop cross-vendor model ids (claude-*, gpt-*, o1/o3/o4-*) silently so the
// CLI falls back to its own default. The orchestrator workflow happily
// dispatches the same cfg.model to every worker, and `providers test`
// forwards cfg.model verbatim — both would otherwise crash here with
// "ModelNotFoundError" the moment cfg.model is anything Anthropic/OpenAI.
function resolveModel(model) {
  if (!model) return '';
  const lower = String(model).toLowerCase();
  if (_ALIASES[lower]) return _ALIASES[lower];
  if (lower.startsWith('gemini') || lower.startsWith('gemma')) return String(model);
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

// Pull usage totals out of the gemini stats block. The shape is
// `stats.models["<model-id>"].api` + `.tokens`. We sum across all
// model entries since a single response can route through multiple
// (e.g. flash for reasoning + pro for the final answer).
function extractUsage(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const models = stats.models || {};
  let input = 0, output = 0;
  for (const m of Object.values(models)) {
    const t = m?.tokens || {};
    input  += (t.prompt ?? t.input ?? 0);
    output += (t.candidates ?? t.output ?? 0);
  }
  if (!input && !output) return null;
  return { inputTokens: input, outputTokens: output, totalCostUsd: 0 };
}

export const geminiCliProvider = {
  name: 'gemini-cli',
  async *sendMessage(messages, opts = {}) {
    const bin = opts.bin || 'gemini';
    const prompt = buildPrompt(messages, opts.system || messages.find(m => m.role === 'system')?.content);
    if (!prompt) return;

    const args = ['--skip-trust', '-p', prompt, '-o', 'json'];
    const model = resolveModel(opts.model);
    if (model) args.push('-m', model);

    if (opts.signal?.aborted) throw new AbortError('aborted before spawn');

    let proc;
    try {
      proc = spawnSandboxed(opts.sandbox || null, bin, args, {
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new CliMissingError();
      throw err;
    }

    const onAbort = () => { try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ } };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort);

    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });

    const exitInfo = await new Promise((resolve) => {
      proc.on('close', (code, signal) => resolve({ code, signal }));
    });

    try {
      if (opts.signal?.aborted) throw new AbortError('aborted mid-run');
      if (exitInfo.code !== 0) {
        throw new CliExitError(exitInfo.code, exitInfo.signal, stderr || stdout);
      }
      // Gemini emits one JSON document; some installations prefix it
      // with a "Ripgrep is not available. Falling back to GrepTool."
      // line on stderr (harmless) and never touch stdout. Defensive
      // parse: find the first `{` to skip any pre-banner noise.
      const first = stdout.indexOf('{');
      const payload = first >= 0 ? stdout.slice(first) : stdout;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (err) {
        throw new Error(`gemini CLI returned non-JSON stdout: ${err.message} :: ${payload.slice(0, 200)}`);
      }
      const text = typeof parsed.response === 'string' ? parsed.response : '';
      if (text) yield text;
      const usage = extractUsage(parsed.stats);
      if (usage && typeof opts.onUsage === 'function') {
        try { opts.onUsage(usage); } catch (_) { /* never break stream on usage callback */ }
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (!proc.killed && exitInfo === null) {
        try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      }
    }
  },
};

export { CliMissingError, CliExitError, AbortError, resolveModel, buildPrompt, extractUsage };
