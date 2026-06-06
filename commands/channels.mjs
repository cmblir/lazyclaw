// Slack / Telegram / Matrix listener commands, extracted from cli.mjs (D3).
import path from 'node:path';
import { configPath, readConfig, _resolveAuthKey } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { loadDotenvIfAny as _loadDotenvShared } from '../dotenv_min.mjs';

// Thin .env loader wrapper kept local so the module stays self-contained.
export function _loadDotenvIfAny(cfgDir) { return _loadDotenvShared(cfgDir); }

export async function cmdSlack(sub, positional, flags = {}) {
  if (sub !== 'listen') {
    console.error('Usage: lazyclaw slack listen [--provider X] [--model Y]');
    process.exit(2);
  }
  await ensureRegistry();
  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());

  const envInfo = _loadDotenvIfAny(cfgDir);
  process.stderr.write(`[slack] .env: ${envInfo.loaded} keys loaded from ${envInfo.path}\n`);

  const provName = flags.provider || cfg.provider || 'mock';
  const prov = getRegistry().PROVIDERS[provName];
  if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
  const model = flags.model || cfg.model;

  // Per-thread rolling chat history so multi-turn coherence works
  // without committing to on-disk sessions. Capped at MAX_TURNS to
  // bound the prompt size.
  const threadMsgs = new Map();
  const MAX_TURNS = 20;

  const handler = async ({ threadId, text }) => {
    const cleaned = String(text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
    // Phase 19.2: never post a placeholder ("(empty message)" / "(empty
    // reply)") into the thread — those leaked through as visible noise
    // when listener self-message echoes happened. Return null and let
    // _simulateInbound's guard drop the send. Real provider errors
    // still surface so the operator knows something went wrong.
    if (!cleaned) {
      process.stderr.write('[slack] dropping empty inbound (after mention strip)\n');
      return null;
    }
    const msgs = threadMsgs.get(threadId) || [];
    msgs.push({ role: 'user', content: cleaned });
    let acc = '';
    try {
      for await (const chunk of prov.sendMessage(msgs, {
        apiKey: _resolveAuthKey(cfg, provName),
        model,
      })) acc += chunk;
    } catch (err) {
      msgs.pop();
      const why = err?.message || String(err);
      process.stderr.write(`[slack] provider error: ${why}\n`);
      return `(provider error: ${why})`;
    }
    msgs.push({ role: 'assistant', content: acc });
    if (msgs.length > MAX_TURNS) msgs.splice(0, msgs.length - MAX_TURNS);
    threadMsgs.set(threadId, msgs);
    if (!acc.trim()) {
      process.stderr.write('[slack] provider returned empty text — not posting\n');
      return null;
    }
    return acc;
  };

  const { SlackChannel } = await import('../channels/slack.mjs');
  const ch = new SlackChannel();
  process.stderr.write(`[slack] provider=${provName} model=${model || '(default)'}\n`);
  try {
    await ch.start(handler);
    await ch._connectSocketMode({ logger: (line) => process.stderr.write(line) });
  } catch (err) {
    if (err?.code === 'SLACK_MISSING_ENV') {
      console.error(`slack: missing env vars: ${(err.missing || []).join(', ')}`);
      console.error(`hint: set them in ${path.join(cfgDir, '.env')} (uncomment SLACK_APP_TOKEN / SLACK_SIGNING_SECRET)`);
    } else {
      console.error(`slack: ${err?.message || err}`);
    }
    process.exit(2);
  }
  process.stderr.write(`[slack] listening. Ctrl-C to stop.\n`);

  await new Promise((resolve) => {
    const onSig = async () => {
      process.stderr.write(`\n[slack] shutting down…\n`);
      try { await ch.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

// `lazyclaw telegram listen` — zero-install mobile control surface.
// Long-polls the Telegram Bot API (no public URL / webhook needed) and
// pipes each inbound message through the active provider, replying in
// the same chat. Mirrors `slack listen`. Access is gated by the existing
// `pairing` allowlist (Telegram numeric user ids); an empty allowlist
// means "reply to anyone who can reach the bot".
export async function cmdTelegram(sub, positional, flags = {}) {
  if (sub !== 'listen') {
    console.error('Usage: lazyclaw telegram listen [--provider X] [--model Y]\n  Long-polls the Telegram Bot API. Set TELEGRAM_BOT_TOKEN in ~/.lazyclaw/.env.\n  Restrict who can talk to it with `lazyclaw pairing add <telegram-user-id>`.');
    process.exit(2);
  }
  await ensureRegistry();
  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());

  const envInfo = _loadDotenvIfAny(cfgDir);
  process.stderr.write(`[telegram] .env: ${envInfo.loaded} keys loaded from ${envInfo.path}\n`);

  const provName = flags.provider || cfg.provider || 'mock';
  const prov = getRegistry().PROVIDERS[provName];
  if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
  const model = flags.model || cfg.model;

  const threadMsgs = new Map();
  const MAX_TURNS = 20;

  const handler = async ({ threadId, text }) => {
    const cleaned = String(text || '').trim();
    if (!cleaned) { process.stderr.write('[telegram] dropping empty inbound\n'); return null; }
    const msgs = threadMsgs.get(threadId) || [];
    msgs.push({ role: 'user', content: cleaned });
    let acc = '';
    try {
      for await (const chunk of prov.sendMessage(msgs, { apiKey: _resolveAuthKey(cfg, provName), model })) acc += chunk;
    } catch (err) {
      msgs.pop();
      const why = err?.message || String(err);
      process.stderr.write(`[telegram] provider error: ${why}\n`);
      return `(provider error: ${why})`;
    }
    msgs.push({ role: 'assistant', content: acc });
    if (msgs.length > MAX_TURNS) msgs.splice(0, msgs.length - MAX_TURNS);
    threadMsgs.set(threadId, msgs);
    if (!acc.trim()) { process.stderr.write('[telegram] provider returned empty text — not posting\n'); return null; }
    return acc;
  };

  // The pairing allowlist doubles as the Telegram sender allowlist.
  const allowlist = (cfg.pairing || []).map((p) => String(p.id));
  const { TelegramChannel } = await import('../channels/telegram.mjs');
  let ch;
  try {
    ch = new TelegramChannel({ allowlist: allowlist.length ? allowlist : null });
  } catch (err) {
    console.error(`telegram: ${err?.message || err}`);
    process.exit(2);
  }
  process.stderr.write(`[telegram] provider=${provName} model=${model || '(default)'} allowlist=${allowlist.length || 'open'}\n`);
  try {
    await ch.start(handler, { poll: true, logger: (line) => process.stderr.write(line) });
  } catch (err) {
    if (err?.code === 'TELEGRAM_MISSING_TOKEN') {
      console.error('telegram: TELEGRAM_BOT_TOKEN not set');
      console.error(`hint: add TELEGRAM_BOT_TOKEN=... to ${path.join(cfgDir, '.env')}`);
    } else {
      console.error(`telegram: ${err?.message || err}`);
    }
    process.exit(2);
  }
  process.stderr.write(`[telegram] listening. Ctrl-C to stop.\n`);

  await new Promise((resolve) => {
    const onSig = async () => {
      process.stderr.write(`\n[telegram] shutting down…\n`);
      try { await ch.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

// `lazyclaw matrix listen` — Matrix inbound over the client-server API's
// long-poll /sync (no SDK). Mirrors `telegram listen`. Set MATRIX_HOMESERVER
// + MATRIX_ACCESS_TOKEN (+ MATRIX_USER_ID for self-filtering) in ~/.lazyclaw/.env.
export async function cmdMatrix(sub, positional, flags = {}) {
  if (sub !== 'listen') {
    console.error('Usage: lazyclaw matrix listen [--provider X] [--model Y]\n  Long-polls the Matrix /sync API. Set MATRIX_HOMESERVER + MATRIX_ACCESS_TOKEN (+ MATRIX_USER_ID) in ~/.lazyclaw/.env.\n  Restrict who can talk to it with `lazyclaw pairing add <@user:server>`.');
    process.exit(2);
  }
  await ensureRegistry();
  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());

  const envInfo = _loadDotenvIfAny(cfgDir);
  process.stderr.write(`[matrix] .env: ${envInfo.loaded} keys loaded from ${envInfo.path}\n`);

  const provName = flags.provider || cfg.provider || 'mock';
  const prov = getRegistry().PROVIDERS[provName];
  if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
  const model = flags.model || cfg.model;

  const threadMsgs = new Map();
  const MAX_TURNS = 20;
  const handler = async ({ threadId, text }) => {
    const cleaned = String(text || '').trim();
    if (!cleaned) { process.stderr.write('[matrix] dropping empty inbound\n'); return null; }
    const msgs = threadMsgs.get(threadId) || [];
    msgs.push({ role: 'user', content: cleaned });
    let acc = '';
    try {
      for await (const chunk of prov.sendMessage(msgs, { apiKey: _resolveAuthKey(cfg, provName), model })) acc += chunk;
    } catch (err) {
      msgs.pop();
      const why = err?.message || String(err);
      process.stderr.write(`[matrix] provider error: ${why}\n`);
      return `(provider error: ${why})`;
    }
    msgs.push({ role: 'assistant', content: acc });
    if (msgs.length > MAX_TURNS) msgs.splice(0, msgs.length - MAX_TURNS);
    threadMsgs.set(threadId, msgs);
    if (!acc.trim()) { process.stderr.write('[matrix] provider returned empty text — not posting\n'); return null; }
    return acc;
  };

  const allowlist = (cfg.pairing || []).map((p) => String(p.id));
  const { MatrixChannel } = await import('../channels/matrix.mjs');
  let ch;
  try {
    ch = new MatrixChannel({ allowlist: allowlist.length ? allowlist : null });
  } catch (err) {
    console.error(`matrix: ${err?.message || err}`);
    process.exit(2);
  }
  process.stderr.write(`[matrix] provider=${provName} model=${model || '(default)'} allowlist=${allowlist.length || 'open'}\n`);
  try {
    await ch.start(handler, { poll: true, logger: (line) => process.stderr.write(line) });
  } catch (err) {
    if (err?.code === 'MATRIX_MISSING_TOKEN' || err?.code === 'MATRIX_MISSING_HOMESERVER') {
      console.error(`matrix: ${err.message}`);
      console.error(`hint: set MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN in ${path.join(cfgDir, '.env')}`);
    } else {
      console.error(`matrix: ${err?.message || err}`);
    }
    process.exit(2);
  }
  process.stderr.write(`[matrix] listening. Ctrl-C to stop.\n`);

  await new Promise((resolve) => {
    const onSig = async () => {
      process.stderr.write(`\n[matrix] shutting down…\n`);
      try { await ch.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}


