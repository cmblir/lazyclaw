// workflow/builtin_caps.mjs — side-effecting workflow node types, granted via
// capability injection. compileWorkflow only ships the safe no-I/O types
// (set/template); the runner (daemon/CLI) opts a workflow into real power by
// passing these as caps.nodeTypes. Each factory takes its primitive (fetch,
// provider, …) so a workflow can never reach ambient I/O on its own.

import { isSafeUrl } from '../mas/tools/web.mjs';
import { spawnSyncSandboxed } from '../sandbox.mjs';
import { scrubEnv } from '../mas/scrub_env.mjs';

// http: { url, method?, headers?, body?, json? } → { status, ok, body|json }.
// SSRF-guarded with the same policy as the web tool (loopback / RFC1918 /
// link-local / non-http(s) are rejected, incl. DNS-rebind via resolution).
export function httpNode({ fetchImpl = globalThis.fetch, isSafe = isSafeUrl, maxBytes = 5_000_000 } = {}) {
  return async (cfg, ctx) => {
    const url = String(cfg?.url || '');
    if (!url) throw new Error('http node: url is required');
    const safe = await isSafe(url);
    if (!safe || !safe.ok) throw new Error(`http node: ${safe?.error || 'blocked url'}`);
    const init = { method: cfg.method || 'GET', headers: cfg.headers || {}, signal: ctx?.signal };
    if (cfg.body != null) init.body = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
    const res = await fetchImpl(url, init);
    const text = await res.text();
    const out = { status: res.status, ok: !!res.ok };
    if (cfg.json) { try { out.json = JSON.parse(text); } catch { out.json = null; } }
    else out.body = text.length > maxBytes ? text.slice(0, maxBytes) : text;
    return out;
  };
}

// llm: { prompt, system?, model? } → the assistant's full text. `provider` is a
// pompos provider (sendMessage yields text chunks).
export function llmNode({ provider, apiKey, model: defaultModel } = {}) {
  return async (cfg, ctx) => {
    if (!provider || typeof provider.sendMessage !== 'function') throw new Error('llm node: no provider granted');
    const messages = [];
    if (cfg?.system) messages.push({ role: 'system', content: String(cfg.system) });
    messages.push({ role: 'user', content: String(cfg?.prompt ?? '') });
    let out = '';
    for await (const chunk of provider.sendMessage(messages, { apiKey, model: cfg?.model || defaultModel, signal: ctx?.signal })) {
      out += chunk;
    }
    return out;
  };
}

// shell: { command } or { bin, args[] } → { code, stdout, stderr }. Runs through
// spawnSyncSandboxed (confined by `sandbox`) with a SCRUBBED env (the snippet
// can't read API keys), argv as an ARRAY (no shell-string injection). This is a
// powerful capability — it is NEVER granted by the daemon route (run_request),
// only by a CLI / trusted runner that opts in via buildCaps({ shell: ... }).
export function shellNode({ spawnSyncImpl = spawnSyncSandboxed, sandbox = null, env, timeoutMs = 30_000, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return (cfg, ctx) => {
    const bin = cfg?.bin || 'sh';
    const args = Array.isArray(cfg?.args) ? cfg.args.map(String) : ['-c', String(cfg?.command ?? '')];
    const r = spawnSyncImpl(sandbox, bin, args, {
      encoding: 'utf8',
      env: env || scrubEnv(process.env),
      timeout: Number.isFinite(cfg?.timeoutMs) ? cfg.timeoutMs : timeoutMs,
      maxBuffer,
      signal: ctx?.signal,
    });
    return { code: r?.status ?? null, stdout: r?.stdout || '', stderr: r?.stderr || '' };
  };
}

// channel-send: { to | threadId, text } → { ts, ok }. The sender is INJECTED and
// already started — the node never constructs a channel client itself (no
// ambient I/O, no per-node socket). CLI / trusted runners only.
export function channelSendNode({ sender } = {}) {
  return async (cfg) => {
    if (!sender || typeof sender.send !== 'function') throw new Error('channel-send node: no sender granted');
    const to = cfg?.to ?? cfg?.threadId;
    if (!to) throw new Error('channel-send node: "to" (channel/thread) is required');
    const opts = {};
    if (cfg.username) opts.username = cfg.username;
    if (cfg.icon_emoji) opts.icon_emoji = cfg.icon_emoji;
    const res = await sender.send(String(to), String(cfg.text ?? ''), opts);
    return { ts: res?.ts || null, ok: true };
  };
}

// Assemble caps.nodeTypes from a grants object. Only granted types appear, so a
// caller that grants nothing gets the safe built-ins only. http/llm are safe
// enough for the daemon route; shell/channel are CLI/trusted-only.
//   buildCaps({ http: true|{fetchImpl}, llm: {provider}, shell: {sandbox}, channel: {sender} })
export function buildCaps(grants = {}) {
  const nodeTypes = {};
  if (grants.http) nodeTypes.http = httpNode(grants.http === true ? {} : grants.http);
  if (grants.llm) nodeTypes.llm = llmNode(grants.llm === true ? {} : grants.llm);
  if (grants.shell) nodeTypes.shell = shellNode(grants.shell === true ? {} : grants.shell);
  if (grants.channel) nodeTypes['channel-send'] = channelSendNode(grants.channel === true ? {} : grants.channel);
  return { nodeTypes };
}
