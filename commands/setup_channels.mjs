// commands/setup_channels.mjs — Hermes-style "where will you run it?"
// onboarding step plus the outbound-webhook step, split out of
// commands/setup.mjs (CLAUDE.md §7: one file = one responsibility, and to
// keep setup.mjs under its size-gate ceiling).
//
// Credentials are written to <cfgDir>/.env (0600) — the same file the
// channel modules read via dotenv_min. Metadata (enabled / boundAgent) is
// written to cfg.channels.<name>, the exact shape daemon/routes/ops.mjs
// and the dashboard read. Plugin channels are recorded the same way with an
// honest "needs a plugin package" notice — we never pretend a channel works
// when it requires an uninstalled package or an external binary.
import { readConfig, writeConfig } from '../lib/config.mjs';
import { writeDotenvMerge } from '../dotenv_min.mjs';
import { messageAdd } from '../config_features.mjs';

// fields[].key is the answer key; .env is the env var it maps to; .secret
// masks it on echo; .optional lets the user skip it.
export const CHANNEL_CATALOG = [
  { name: 'slack',    builtin: true,  label: 'Slack',
    fields: [
      { key: 'token', env: 'SLACK_BOT_TOKEN', prompt: 'Bot token (xoxb-…)', secret: true },
      { key: 'appToken', env: 'SLACK_APP_TOKEN', prompt: 'App-level token (xapp-…, for inbound / Socket Mode)', secret: true, optional: true },
    ] },
  { name: 'telegram', builtin: true,  label: 'Telegram',
    fields: [{ key: 'token', env: 'TELEGRAM_BOT_TOKEN', prompt: 'Bot token (from @BotFather)', secret: true }] },
  { name: 'matrix',   builtin: true,  label: 'Matrix',
    fields: [
      { key: 'homeserver', env: 'MATRIX_HOMESERVER', prompt: 'Homeserver URL (https://matrix.org)' },
      { key: 'token',      env: 'MATRIX_ACCESS_TOKEN', prompt: 'Access token', secret: true },
      { key: 'userId',     env: 'MATRIX_USER_ID', prompt: 'User id (@you:matrix.org)' },
    ] },
  { name: 'http',     builtin: true,  label: 'HTTP (generic inbound endpoint)', fields: [] },
  { name: 'discord',  builtin: false, plugin: '@lazyclaw/channel-discord', label: 'Discord',
    fields: [{ key: 'token', env: 'DISCORD_BOT_TOKEN', prompt: 'Bot token', secret: true }] },
  { name: 'email',    builtin: false, plugin: '@lazyclaw/channel-email', label: 'Email (IMAP/SMTP)',
    fields: [
      { key: 'host', env: 'EMAIL_IMAP_HOST', prompt: 'IMAP host' },
      { key: 'user', env: 'EMAIL_IMAP_USER', prompt: 'IMAP user' },
      { key: 'pass', env: 'EMAIL_IMAP_PASS', prompt: 'IMAP password', secret: true },
    ] },
  { name: 'signal',   builtin: false, plugin: '@lazyclaw/channel-signal', label: 'Signal (needs signal-cli)',
    fields: [{ key: 'account', env: 'SIGNAL_ACCOUNT', prompt: 'Signal account (+15551234567)' }] },
  { name: 'voice',    builtin: false, plugin: '@lazyclaw/channel-voice', label: 'Voice (Whisper transcription)',
    fields: [{ key: 'apiKey', env: 'OPENAI_API_KEY', prompt: 'OpenAI API key (whisper)', secret: true }] },
  { name: 'whatsapp', builtin: false, plugin: '@lazyclaw/channel-whatsapp', label: 'WhatsApp (web session)',
    fields: [] },
];

export function channelByName(name) {
  return CHANNEL_CATALOG.find((c) => c.name === name) || null;
}

// Pure: turn collected answers into { envVars, channelConfig, needsPlugin }.
// Empty/whitespace answers are dropped so a skipped optional field doesn't
// write an empty env var.
export function buildChannelEntry(name, answers = {}) {
  const spec = channelByName(name);
  if (!spec) throw new Error(`unknown channel: ${name}`);
  const envVars = {};
  for (const f of spec.fields) {
    const v = (answers[f.key] == null ? '' : String(answers[f.key])).trim();
    if (v) envVars[f.env] = v;
  }
  return {
    envVars,
    channelConfig: { enabled: true },
    needsPlugin: spec.builtin ? null : spec.plugin,
  };
}

// Side-effecting persist used by the interactive step (and unit-tested with a
// temp cfgDir). Writes creds to <cfgDir>/.env and metadata to cfg.channels.
// readConfig()/writeConfig() resolve configPath() fresh on every call (it
// reads LAZYCLAW_CONFIG_DIR at use-time, nothing import-cached), so they
// target <cfgDir>/config.json when the caller has pointed the env var there.
export function persistChannel(cfgDir, name, answers) {
  const entry = buildChannelEntry(name, answers);
  if (Object.keys(entry.envVars).length) writeDotenvMerge(cfgDir, entry.envVars);
  const cfg = readConfig();
  cfg.channels = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {};
  cfg.channels[name] = { ...(cfg.channels[name] || {}), ...entry.channelConfig };
  writeConfig(cfg);
  return entry;
}

const mask = (v) => {
  const s = String(v);
  return s.length <= 4 ? '••••' : `${s.slice(0, 3)}…${s.slice(-2)}`;
};

// Verify a channel's stored credentials with a cheap live call (Slack
// auth.test, Telegram getMe, Matrix whoami). Reads creds from `env` (defaults
// to process.env — load the .env first). Returns { ok, detail, hint }:
// ok=true verified, ok=false rejected/unreachable (hint = how to fix),
// ok=null when the channel has no verifiable endpoint (http/plugins). Pure
// w.r.t. config; fetch is injectable for tests.
export async function verifyChannel(name, { env = process.env, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const spec = channelByName(name);
  if (!spec) return { ok: false, detail: `unknown channel "${name}"`, hint: '' };
  const need = (envVar) => env[envVar] || '';
  try {
    if (name === 'slack') {
      const token = need('SLACK_BOT_TOKEN');
      if (!token) return { ok: false, detail: 'no SLACK_BOT_TOKEN set', hint: 'set it with /channels slack setup' };
      const base = env.SLACK_API_BASE || 'https://slack.com/api';
      const res = await f(`${base}/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      return j && j.ok
        ? { ok: true, detail: `team=${j.team || '?'} user=${j.user || '?'}`, hint: '' }
        : { ok: false, detail: `Slack rejected the token (${j && j.error ? j.error : 'auth.test failed'})`, hint: 'check SLACK_BOT_TOKEN via /channels slack setup' };
    }
    if (name === 'telegram') {
      const token = need('TELEGRAM_BOT_TOKEN');
      if (!token) return { ok: false, detail: 'no TELEGRAM_BOT_TOKEN set', hint: 'set it with /channels telegram setup' };
      const res = await f(`https://api.telegram.org/bot${token}/getMe`);
      const j = await res.json().catch(() => ({}));
      return j && j.ok
        ? { ok: true, detail: `@${(j.result && j.result.username) || '?'}`, hint: '' }
        : { ok: false, detail: `Telegram rejected the token (${j && j.description ? j.description : 'getMe failed'})`, hint: 'check TELEGRAM_BOT_TOKEN via /channels telegram setup' };
    }
    if (name === 'matrix') {
      const hs = need('MATRIX_HOMESERVER');
      const token = need('MATRIX_ACCESS_TOKEN');
      if (!hs || !token) return { ok: false, detail: 'no MATRIX_HOMESERVER / MATRIX_ACCESS_TOKEN set', hint: 'set them with /channels matrix setup' };
      const res = await f(`${hs.replace(/\/$/, '')}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      return res.ok && j && j.user_id
        ? { ok: true, detail: j.user_id, hint: '' }
        : { ok: false, detail: 'Matrix rejected the token', hint: 'check MATRIX_ACCESS_TOKEN via /channels matrix setup' };
    }
    return { ok: null, detail: `no live verification for "${name}"`, hint: '' };
  } catch (e) {
    return { ok: false, detail: `could not reach ${name}: ${e && e.message ? e.message : e}`, hint: 'check your network / credentials' };
  }
}

// Interactive channel step. `prompt(label)` resolves to a trimmed string;
// `write(text)` sinks UI output (defaults to process.stdout). Returns
// { skipped, channel?, needsPlugin? }. Never echoes a secret field value.
export async function runChannelStep({ cfgDir, prompt, colors, write = (s) => process.stdout.write(s) }) {
  const { dim, ok, warn } = colors;
  const list = CHANNEL_CATALOG.map((c) => `${c.name}${c.builtin ? '' : ' *'}`).join(' · ');
  write(`  ${dim('Where will you talk to the agent? Built-in: slack/telegram/matrix/http. (* = needs a plugin package.)')}\n`);
  write(`  ${dim(list)}\n\n`);
  const pick = (await prompt('  channel (Enter to skip): ')).trim().toLowerCase();
  if (!pick) { write(`  ${dim('— skipped —')}\n\n`); return { skipped: true }; }
  const spec = channelByName(pick);
  if (!spec) { write(`  ${warn('skipped:')} unknown channel "${pick}"\n\n`); return { skipped: true }; }

  const answers = {};
  for (const f of spec.fields) {
    // Mask secret fields so tokens aren't echoed in plaintext to the terminal.
    const v = (await prompt(`  ${spec.label} — ${f.prompt}${f.optional ? ' (optional)' : ''}: `, { secret: !!f.secret })).trim();
    if (v) answers[f.key] = v;
  }
  try {
    const entry = persistChannel(cfgDir, pick, answers);
    const credKeys = Object.keys(entry.envVars);
    write(`  ${ok('✓ channel enabled:')} ${pick}  ${credKeys.length ? dim(`creds: ${credKeys.join(', ')}`) : ''}\n`);
    for (const f of spec.fields) {
      if (f.secret && answers[f.key]) write(`    ${dim(`${f.env} = ${mask(answers[f.key])}  (stored in ${cfgDir}/.env, 0600)`)}\n`);
    }
    if (entry.needsPlugin) {
      write(`  ${warn('plugin required:')} ${entry.needsPlugin}\n`);
      write(`    ${dim(`install with: lazyclaw channels install ${entry.needsPlugin}  (or npm install --prefix ${cfgDir} ${entry.needsPlugin})`)}\n`);
    }
    write('\n');
    return { skipped: false, channel: pick, needsPlugin: entry.needsPlugin };
  } catch (e) {
    write(`  ${warn('skipped:')} ${e?.message || e}\n\n`);
    return { skipped: true };
  }
}

// Outbound webhook step (moved verbatim-in-spirit from setup.mjs).
export async function runWebhookStep({ prompt, colors, write = (s) => process.stdout.write(s) }) {
  const { dim, ok, warn } = colors;
  write(`  ${dim('Outbound webhook for `lazyclaw message send <name> <text>`. Slack / Discord Incoming Webhook URLs work as-is.')}\n\n`);
  const hookName = (await prompt('  webhook name (Enter to skip): ')).trim();
  if (!hookName) { write(`  ${dim('— skipped —')}\n\n`); return { skipped: true }; }
  const hookUrl = (await prompt('  webhook URL: ')).trim();
  if (!hookUrl) { write(`  ${warn('skipped:')} URL required\n\n`); return { skipped: true }; }
  try {
    const fresh = readConfig();
    messageAdd(fresh, hookName, hookUrl);
    writeConfig(fresh);
    write(`  ${ok('✓ webhook saved:')} ${hookName}\n\n`);
    return { skipped: false, name: hookName };
  } catch (e) {
    write(`  ${warn('skipped:')} ${e?.message || e}\n\n`);
    return { skipped: true };
  }
}

// Context-window step (asked right after the model pick): how much past
// conversation to keep each turn — a sliding history budget, NOT the model's
// hard limit. Enter on both prompts keeps the defaults.
export async function runContextStep({ prompt, colors, write = (s) => process.stdout.write(s) }) {
  const { dim, ok } = colors;
  const cf = await import('../config_features.mjs');
  const cur = cf.chatWindowGet(readConfig());
  write(`  ${dim(`Context window — how much past conversation to send each turn (sliding budget, not the model's hard limit). Now: ${cur.turns} turns · ${cur.tokens} tokens.`)}\n\n`);
  const turnsRaw = (await prompt(`  turns to keep (Enter = ${cur.turns}): `)).trim();
  const tokensRaw = (await prompt(`  token budget (Enter = ${cur.tokens}): `)).trim();
  if (!turnsRaw && !tokensRaw) { write(`  ${dim('— kept defaults —')}\n\n`); return { skipped: true }; }
  const turns = parseInt(turnsRaw, 10);
  const tokens = parseInt(tokensRaw, 10);
  const cfg = readConfig();
  cf.chatWindowSet(cfg, {
    ...(Number.isFinite(turns) && turns > 0 ? { turns } : {}),
    ...(Number.isFinite(tokens) && tokens >= 256 ? { tokens } : {}),
  });
  writeConfig(cfg);
  const w = cf.chatWindowGet(cfg);
  write(`  ${ok('✓ context window:')} ${w.turns} turns · ${w.tokens} tokens\n`);
  write(`  ${dim('change later: /context turns <N> | tokens <N>')}\n\n`);
  return { skipped: false, ...w };
}

// Optional orchestration step: enable the multi-agent planner+workers pipeline.
// Defaults the planner to the configured provider and workers to [planner];
// the user can layer more workers later via /orchestrator or the CLI.
export async function runOrchestratorStep({ prompt, colors, write = (s) => process.stdout.write(s) }) {
  const { dim, ok } = colors;
  const cf = await import('../config_features.mjs');
  // Reuse the same searchable provider/model picker as the model step, so
  // planner + workers are chosen from a list (arrow keys / filter), not typed.
  const { _pickProviderInteractive } = await import('../tui/pickers.mjs');
  const toSpec = (p) => (p && p.provider) ? (p.model ? `${p.provider}:${p.model}` : p.provider) : null;
  write(`  ${dim('Multi-agent: a planner splits your task into subtasks, workers run them in parallel, then a synthesis step merges the results. Skip for a single agent.')}\n\n`);
  const yn = (await prompt('  enable orchestration? [y/N] ')).trim().toLowerCase();
  if (yn !== 'y' && yn !== 'yes') { write(`  ${dim('— skipped —')}\n\n`); return { skipped: true }; }
  const cfg = readConfig();
  const base = cfg.provider && cfg.provider !== 'orchestrator' ? cfg.provider : 'claude-cli';
  // Planner — pick from the provider/model list (Esc keeps the default).
  write(`  ${dim('Pick the PLANNER (decomposes the task):')}\n`);
  const planner = toSpec(await _pickProviderInteractive()) || base;
  // Workers — pick one or more from the same list.
  const workers = [];
  let more = true;
  while (more) {
    write(`  ${dim(`Pick a WORKER (runs the subtasks)${workers.length ? ` — ${workers.length} added` : ''}:`)}\n`);
    const spec = toSpec(await _pickProviderInteractive());
    if (spec && !workers.includes(spec)) workers.push(spec);
    more = ((await prompt('  add another worker? [y/N] ')).trim().toLowerCase().startsWith('y'));
  }
  if (!workers.length) workers.push(planner);
  cf.orchestratorSet(cfg, { planner, workers });
  cf.orchestratorEnable(cfg, true);
  writeConfig(cfg);
  write(`  ${ok('✓ orchestration enabled:')} planner ${planner} · workers ${workers.join(', ')}\n`);
  write(`  ${dim('change later: /orchestrator  or  lazyclaw orchestrator status')}\n\n`);
  return { skipped: false, planner, workers };
}
