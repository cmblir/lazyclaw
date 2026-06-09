// providers/probe.mjs — smoke-test a single provider with a tiny prompt.
//
// Returns the result object; it never logs and never calls process.exit, so
// callers decide how to render and whether to exit. The CLI `providers test`
// prints JSON and exits; the setup wizard's verify step prints one concise
// line and KEEPS GOING (a process.exit here would kill the rest of the
// wizard — the bug this split fixes).
import { getRegistry } from '../lib/registry_boot.mjs';

export async function probeProvider({ name, model, prompt = 'ping', apiKey = '' }) {
  const provider = getRegistry().PROVIDERS[name];
  if (!provider) {
    return { ok: false, provider: name, model, durationMs: 0, error: `unknown provider: ${name}`, code: 'UNKNOWN_PROVIDER' };
  }
  const t0 = Date.now();
  try {
    let reply = '';
    const stream = provider.sendMessage([{ role: 'user', content: prompt }], { apiKey, model });
    for await (const chunk of stream) {
      if (typeof chunk === 'string') reply += chunk;
    }
    const durationMs = Date.now() - t0;
    const ok = reply.length > 0;
    return { ok, provider: name, model, durationMs, replyLength: reply.length, reply: reply.slice(0, 200) + (reply.length > 200 ? '…' : '') };
  } catch (err) {
    return { ok: false, provider: name, model, durationMs: Date.now() - t0, error: err?.message || String(err), code: err?.code || null };
  }
}
