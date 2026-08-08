// Persistent claude stream-json session.
//
// pompos's default claude-cli path spawns a fresh `claude -p` per turn, so the
// Claude Code agent harness cold-boots and re-loads its base context EVERY turn
// (measured ~1.6-2.7s + ~24k tokens per spawn). Claude Code also supports a
// realtime streaming-input mode (`--input-format stream-json`): keep ONE child
// alive per conversation, write each user turn as a JSON line to its stdin, read
// the reply from stdout. The harness boots ONCE per session and stays warm — the
// same way the Hermes upstream stays fast on the same $0 Pro subscription.
// Measured here: turn 1 ~4.4s, turn 2 ~2.2s (boot amortized).
//
// Lifecycle: sessions are keyed by a conversation id, serialise one turn at a
// time, evict on child exit/crash (next getSession respawns), kill on abort
// (so a half-generated turn can't leak into the next), and idle-timeout teardown.
// Callers keep the existing one-shot providers/claude_cli.mjs path as the
// fallback for stateless calls and when this mode is unavailable.

import { spawn } from 'node:child_process';
import { resolveModelAlias, AbortError } from './claude_cli.mjs';

const SESSIONS = new Map();
const DEFAULT_IDLE_MS = 5 * 60_000;

function extractTextDelta(obj) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'stream_event') return '';
  const ev = obj.event || {};
  if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
    return ev.delta.text;
  }
  return '';
}

class ClaudeSession {
  constructor(key, opts = {}) {
    this.key = key;
    this.opts = opts;
    this.idleMs = opts.idleMs || DEFAULT_IDLE_MS;
    this._spawn = opts._spawn || spawn;
    this.busy = false;
    this.alive = true;
    this.buffer = '';
    this._spawnChild();
  }

  _spawnChild() {
    const o = this.opts;
    const args = [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--include-partial-messages', '--verbose',
    ];
    if (o.lean !== false) args.push('--setting-sources', '', '--strict-mcp-config');
    const mt = o.maxTurns == null ? 1 : o.maxTurns;
    if (mt > 0) args.push('--max-turns', String(mt));
    args.push('--tools', o.tools == null ? '' : String(o.tools));
    if (o.permissionMode) args.push('--permission-mode', String(o.permissionMode));
    const model = resolveModelAlias(o.model);
    if (model) args.push('--model', model);
    if (o.system && String(o.system).trim()) args.push('--append-system-prompt', String(o.system));

    this.proc = this._spawn(o.bin || process.env.POMPOS_CLAUDE_BIN || 'claude', args, {
      cwd: o.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try { this.proc.stdout.setEncoding('utf8'); } catch { /* fake child in tests */ }
    const evict = () => {
      this.alive = false;
      clearTimeout(this._idle);
      if (SESSIONS.get(this.key) === this) SESSIONS.delete(this.key);
    };
    this.proc.on('exit', evict);
    this.proc.on('error', evict);
    this._touch();
  }

  _touch() {
    clearTimeout(this._idle);
    this._idle = setTimeout(() => this.close(), this.idleMs);
    if (this._idle && typeof this._idle.unref === 'function') this._idle.unref();
  }

  // Stream one turn. Yields text deltas until the matching `result` event.
  async *send(userText, { signal, onUsage, onTruncated } = {}) {
    if (this.busy) throw new Error('claude session busy — sends must be serialised per session');
    if (!this.alive) throw new Error('claude session is not alive');
    this.busy = true;
    this._touch();

    // Per-turn usage accumulated from `assistant` events (incl. cache fields);
    // falls back to the result event's usage if no assistant event was seen.
    const u = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, saw: false };
    const queue = [];
    let done = false;
    let error = null;
    let wake = null;
    const wait = () => new Promise((r) => { wake = r; });
    const onData = (d) => {
      this.buffer += d;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const t = extractTextDelta(obj);
        if (t) { queue.push(t); if (wake) wake(); }
        if (obj.type === 'assistant' && obj.message && obj.message.usage) {
          const mu = obj.message.usage;
          u.input += mu.input_tokens || 0;
          u.output += mu.output_tokens || 0;
          u.cacheCreate += mu.cache_creation_input_tokens || 0;
          u.cacheRead += mu.cache_read_input_tokens || 0;
          u.saw = true;
        }
        if (obj.type === 'result') {
          if (typeof onUsage === 'function') {
            const ru = obj.usage || {};
            try {
              onUsage({
                inputTokens: u.saw ? u.input : (ru.input_tokens || 0),
                outputTokens: u.saw ? u.output : (ru.output_tokens || 0),
                cacheCreationInputTokens: u.saw ? u.cacheCreate : (ru.cache_creation_input_tokens || 0),
                cacheReadInputTokens: u.saw ? u.cacheRead : (ru.cache_read_input_tokens || 0),
                totalCostUsd: obj.total_cost_usd || 0,
              });
            } catch { /* never fail a turn on a usage callback */ }
          }
          if (typeof onTruncated === 'function' && obj.is_error && /max_turns/.test(String(obj.subtype || ''))) {
            try { onTruncated('max_turns'); } catch { /* ditto */ }
          }
          done = true; if (wake) wake();
        }
      }
    };
    const onExit = () => { if (!error) error = new Error('claude session exited mid-turn'); done = true; if (wake) wake(); };
    this.proc.stdout.on('data', onData);
    this.proc.once('exit', onExit);

    let aborted = false;
    try {
      this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(userText) } }) + '\n');
      for (;;) {
        if (queue.length) { yield queue.shift(); continue; }
        if (done) break;
        if (signal && signal.aborted) { aborted = true; error = new AbortError('aborted mid-session'); break; }
        await wait();
      }
      if (error) throw error;
    } finally {
      this.proc.stdout.off('data', onData);
      this.proc.off('exit', onExit);
      this.busy = false;
      this._touch();
      // Abort mid-turn leaves a half-generated reply in the pipe; drop the warm
      // session so the next turn starts clean rather than reading stale output.
      if (aborted) this.close();
    }
  }

  close() {
    this.alive = false;
    clearTimeout(this._idle);
    if (SESSIONS.get(this.key) === this) SESSIONS.delete(this.key);
    try { if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

// Return the live session for `key`, spawning one if none is alive. A warm
// session fixes its system prompt at spawn (--append-system-prompt), so if the
// caller's system changes mid-conversation (e.g. plan-mode toggled), the warm
// session is stale — evict and respawn rather than answer with the old system.
export function getSession(key, opts = {}) {
  const existing = SESSIONS.get(key);
  if (existing && existing.alive) {
    if ((existing.opts.system || '') === (opts.system || '')) return existing;
    existing.close();
  }
  const s = new ClaudeSession(key, opts);
  SESSIONS.set(key, s);
  return s;
}

export function closeAllSessions() { for (const s of [...SESSIONS.values()]) s.close(); }
export function _resetSessions() { closeAllSessions(); SESSIONS.clear(); }
