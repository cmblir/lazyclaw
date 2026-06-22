// claude-cli tool-use adapter (Phase 19).
//
// Unlike the API-based adapters, this one wraps the official `claude`
// CLI (Claude Code). The CLI runs the *entire* tool-use loop inside
// itself — bash, edit, read, write, grep, etc. — and emits a single
// final text answer. From lazyclaw's mention-router perspective every
// call resolves to `{ kind: 'final', text }` after one iteration, so
// the multi-agent handoff still works (we just lose lazyclaw's audit
// log for tools claude ran on its own; the CLI keeps its own log).
//
// Wiring choices:
//   - --output-format stream-json + --verbose so we can accumulate
//     text deltas exactly like providers/claude_cli.mjs does (proven
//     parser, no second JSON shape to maintain).
//   - --permission-mode bypassPermissions because spec §10 #6 ships
//     destructive-pattern confirmation OFF by default. Audit log
//     still captures every tool the CLI runs (via the CLI's own
//     telemetry — we don't double-write here).
//   - --tools maps the lazyclaw whitelist into claude's built-in
//     names (bash → Bash, etc.). When the whitelist is empty we pass
//     `""` so tools are fully disabled.
//   - --system-prompt carries the agent role + memory + team metadata
//     the mention router builds.
//   - LAZYCLAW_CLAUDE_BIN overrides the binary path so tests can
//     point at a deterministic shim script.

import { spawn } from 'node:child_process';
import { classifyCliExit } from '../cli_error.mjs';

const DEFAULT_BIN = 'claude';
const LAZYCLAW_TO_CLAUDE_TOOL = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
};

export class ClaudeCliToolUseError extends Error {
  constructor(message, code, body) {
    super(message);
    this.name = 'ClaudeCliToolUseError';
    this.code = code || 'CLAUDE_CLI_ERR';
    if (body) this.body = body;
  }
}

// The schemas value from listToolSchemas comes in lazyclaw form; claude
// expects a comma-separated string of its OWN built-in tool names.
// Returning a string rather than an array lets us pass it as a single
// CLI argument unchanged. An empty string is meaningful — it disables
// all tools — so callers should distinguish "no tools whitelisted" from
// "tools field omitted".
export function toClaudeTools(schemas) {
  if (!Array.isArray(schemas) || schemas.length === 0) return '';
  const names = schemas
    .map((s) => LAZYCLAW_TO_CLAUDE_TOOL[s?.name])
    .filter(Boolean);
  return [...new Set(names)].join(',');
}

export function normalizeHistory(turns) {
  return Array.isArray(turns) ? [...turns] : [];
}

export function initialUserMessage(text) {
  return { role: 'user', content: String(text) };
}

// Build the single prompt string the CLI sees. Concatenate every
// non-system message, prefixing prior assistant turns with a "[prior]
// " marker so the model can tell them apart from the live user turn.
// Mirrors the established pattern in providers/claude_cli.mjs.
function buildPrompt(messages) {
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  if (!lastUser) return '';
  const history = messages
    .filter((m) => m !== lastUser && m && m.role !== 'system')
    .map((m) => {
      const tag = m.role === 'assistant' ? '[prior assistant]' : '[prior user]';
      return `${tag} ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    })
    .join('\n\n');
  return history ? `${history}\n\n${lastUser.content}` : String(lastUser.content);
}

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

// Walk stream-json output to completion, accumulating text deltas, and
// return the final concatenated reply. The CLI also emits an
// 'assistant' record carrying the full message content; we fall back
// to that when no `stream_event` deltas were observed (some claude
// versions only emit the consolidated record).
async function readUntilDone(proc) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let acc = '';
    let assistantFallback = '';
    let resultText = '';
    // Per-turn usage rides the `assistant` event (the streaming `result` event
    // reports zero tokens); cost rides the result event. Accumulate so the cost
    // cap can account for this default subscription path.
    const u = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, saw: false };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const delta = extractTextDelta(obj);
        if (delta) acc += delta;
        // Fallback: consolidated assistant content block (no streaming).
        if (obj?.type === 'assistant' && obj?.message?.content) {
          for (const block of obj.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              assistantFallback += block.text;
            }
          }
        }
        if (obj?.type === 'result' && typeof obj.result === 'string') {
          resultText = obj.result;
        }
        if (obj?.type === 'assistant' && obj?.message?.usage) {
          const mu = obj.message.usage;
          u.input += mu.input_tokens || 0;
          u.output += mu.output_tokens || 0;
          u.cacheCreate += mu.cache_creation_input_tokens || 0;
          u.cacheRead += mu.cache_read_input_tokens || 0;
          u.saw = true;
        }
        if (obj?.type === 'result' && Number.isFinite(obj.total_cost_usd)) u.cost = obj.total_cost_usd;
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        // Transient upstream throttle → retriable RATE_LIMIT; otherwise keep
        // the non-retriable CLAUDE_CLI_EXIT code.
        const cls = classifyCliExit(stderr);
        const exitCode = cls.code === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'CLAUDE_CLI_EXIT';
        const err = new ClaudeCliToolUseError(`claude CLI exit ${code}: ${stderr.slice(0, 300)}`, exitCode, stderr);
        if (cls.retryAfterMs !== undefined) err.retryAfterMs = cls.retryAfterMs;
        return reject(err);
      }
      // Prefer accumulated stream deltas; fall back to the assistant
      // record or the final result text when streaming was disabled.
      const text = acc || assistantFallback || resultText || '';
      const usage = (u.saw || u.cost)
        ? {
            inputTokens: u.input, outputTokens: u.output,
            cacheCreationInputTokens: u.cacheCreate, cacheReadInputTokens: u.cacheRead,
            totalCostUsd: u.cost,
          }
        : null;
      resolve({ text, usage });
    });
  });
}

// Build the `claude` argv for the tool-use path. Runs LEAN by default —
// single-sourced with providers/claude_cli.mjs's policy — so this path (agentic
// chat / every mention-router team turn / the per-turn trainer calls) does NOT
// re-load the user's CLAUDE.md/skills/hooks/MCP (~180k tokens/spawn, measured).
// It previously omitted the lean flags, which is why the streaming provider's
// lean fix didn't help these paths. Pass lean:false to restore the full env.
export function buildToolUseArgs({ prompt, model, system, tools = [], permissionMode = 'bypassPermissions', lean, maxTurns } = {}) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', permissionMode,
  ];
  if (lean !== false) {
    args.push('--setting-sources', '', '--strict-mcp-config');
  }
  // Bound Claude Code's internal autonomous loop. This adapter DOES let the
  // agent use tools (--tools whitelist below), but the internal loop was
  // otherwise uncapped (lazyclaw's own maxIterations is a no-op for claude-cli).
  const cap = maxTurns == null ? 16 : maxTurns;
  if (cap > 0) args.push('--max-turns', String(cap));
  if (model) args.push('--model', model);
  if (system && String(system).trim()) {
    args.push('--system-prompt', String(system));
  }
  // Phase 19: pass the lazyclaw whitelist through to claude's --tools even when
  // empty (an empty string explicitly disables every tool).
  args.push('--tools', toClaudeTools(tools));
  return args;
}

export async function callOnce({
  messages,
  tools = [],
  model,
  apiKey,           // unused — the CLI authenticates itself
  system,
  baseUrl,          // unused
  fetchImpl,        // unused
  signal,
  bin,
  cwd,
  lean,
  maxTurns,
  permissionMode = 'bypassPermissions',
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ClaudeCliToolUseError('messages[] is required and non-empty', 'NO_MESSAGES');
  }
  const prompt = buildPrompt(messages);
  if (!prompt) {
    throw new ClaudeCliToolUseError('messages produced an empty prompt', 'NO_PROMPT');
  }
  const args = buildToolUseArgs({ prompt, model, system, tools, permissionMode, lean, maxTurns });

  const binPath = bin || process.env.LAZYCLAW_CLAUDE_BIN || DEFAULT_BIN;
  let proc;
  try {
    proc = spawn(binPath, args, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new ClaudeCliToolUseError(`claude CLI binary not found at "${binPath}"`, 'CLAUDE_CLI_NOT_FOUND');
    }
    throw err;
  }
  const onAbort = () => { try { proc.kill('SIGTERM'); } catch { /* gone */ } };
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const { text, usage } = await readUntilDone(proc);
    return { kind: 'final', text, usage, raw: null };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// The CLI handles tools internally — these helpers exist to keep the
// adapter surface symmetrical with anthropic/openai/gemini. Neither
// path is actually exercised at runtime because callOnce always
// returns kind:'final'.
export function assistantTurnMessages(_resp) { return []; }
export function toolResultMessages(_results) { return []; }
