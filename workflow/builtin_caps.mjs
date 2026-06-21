// workflow/builtin_caps.mjs — side-effecting workflow node types, granted via
// capability injection. compileWorkflow only ships the safe no-I/O types
// (set/template); the runner (daemon/CLI) opts a workflow into real power by
// passing these as caps.nodeTypes. Each factory takes its primitive (fetch,
// provider, …) so a workflow can never reach ambient I/O on its own.

import { isSafeUrl } from '../mas/tools/web.mjs';

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
// lazyclaw provider (sendMessage yields text chunks).
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

// Assemble caps.nodeTypes from a grants object. Only granted types appear, so a
// caller that grants nothing gets the safe built-ins only.
//   buildCaps({ http: true|{fetchImpl}, llm: { provider, apiKey, model } })
export function buildCaps(grants = {}) {
  const nodeTypes = {};
  if (grants.http) nodeTypes.http = httpNode(grants.http === true ? {} : grants.http);
  if (grants.llm) nodeTypes.llm = llmNode(grants.llm === true ? {} : grants.llm);
  return { nodeTypes };
}
