// tui/config_picker.mjs — the `/config` slash: change ONE setting without
// re-running the whole wizard.
//
// Split of duties (user-requested):
//   /setup  — first-run / full re-setup: leaves chat and runs EVERY wizard
//             step (the behavior /config used to have).
//   /config — settings editor: pick a single item. In-chat items (provider /
//             model / context / trainer / orchestrator) delegate to their
//             existing slash handlers and stay inside chat; credential items
//             (channel tokens, outbound webhook) need readline prompts, so
//             they unmount, run JUST that step, and re-enter chat.
//
// On the legacy readline path (no ctx.openPicker modal) /config falls back
// to the full wizard — same as before, no silent degradation.
//
// `/config set <key> <value>` / `/config unset <key>` — added because the
// dashboard needs to change a setting and this command used to ignore its
// arguments entirely: over HTTP, where there is no picker, it reported
// success and wrote nothing (ctx.requestSetup + 'EXIT', collapsed by the
// adapter to {ok:true, lines:[]}). The rules mirror daemon/routes/config.mjs's
// configKeyPut: nested cargo goes to its dedicated endpoint, the whole config
// is re-validated before it is persisted, and api-key is never echoed. The
// no-argument picker path below is untouched.
import { splitArgs } from '../loop-engine.mjs';
import { validateConfig } from '../config-validate.mjs';
import { PROVIDERS, maskApiKey } from '../providers/registry.mjs';

const NESTED = new Set(['customProviders', 'rates', 'authProfiles']);
const USAGE = 'usage: /config set <key> <value>  ·  /config unset <key>  ·  /config with no arguments opens the picker';

// Values arrive as text but config.json is typed — "4096" must land as a
// number or validation (and every later reader) breaks far from here.
function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

// `tui/slash_helpers.mjs`'s `splitWhitespace` does NOT honor quotes (it is a
// bare `.split(/\s+/)`) — despite this command's original plan assuming it
// did. Reusing it here would store `"hello` and `world"` (quotes and all) for
// `/config set note "hello world"`. `splitArgs` (loop-engine.mjs) is the
// tokenizer in this codebase that actually strips quotes; it throws on an
// unterminated quote, which is a malformed line, not a crash.
function tokenizeConfigArgs(raw) {
  try {
    return splitArgs(raw);
  } catch {
    return null;
  }
}

const CONFIG_ITEMS = [
  { id: 'provider',     label: 'provider',            desc: 'switch the chat provider (family → vendor picker)' },
  { id: 'model',        label: 'model',               desc: 'switch the model (live list when the provider supports it)' },
  { id: 'context',      label: 'context window',      desc: 'history turns / token budget sent per turn' },
  { id: 'hud',          label: 'HUD status bar',      desc: 'show/hide the usage · models · cost row above the input' },
  { id: 'trainer',      label: 'trainer',             desc: 'learning-loop provider/model (auto = $0 on claude-cli)' },
  { id: 'orchestrator', label: 'orchestrator',        desc: 'multi-agent on/off, planner, workers' },
  { id: 'channel',      label: 'channel credentials', desc: 'Slack/Telegram/Matrix tokens — leaves chat for the prompts, then returns' },
  { id: 'webhook',      label: 'outbound webhook',    desc: 'message-send webhook URL — leaves chat, then returns' },
  { id: 'wizard',       label: 'everything (full wizard)', desc: 'rerun all setup steps — same as /setup' },
];

export async function runConfigSlash(args, ctx, handlers) {
  const raw = String(args || '').trim();
  if (raw) {
    const tokens = tokenizeConfigArgs(raw);
    if (tokens === null) return USAGE;
    const verb = (tokens[0] || '').toLowerCase();
    if (verb === 'set' || verb === 'unset') {
      if (typeof ctx.readConfig !== 'function' || typeof ctx.writeConfig !== 'function') {
        return 'config: this session cannot write config';
      }
      const key = tokens[1];
      if (!key || (verb === 'set' && tokens.length < 3)) return USAGE;
      if (NESTED.has(key)) {
        return `config: "${key}" is not settable here — use the dedicated endpoint (POST /providers · PUT /rates/<key> · authProfiles via CLI)`;
      }
      const cfg = ctx.readConfig();
      if (verb === 'unset') delete cfg[key];
      else cfg[key] = coerce(tokens.slice(2).join(' '));
      // Re-validate the WHOLE config, not just the touched key — same rule
      // configKeyPut applies, so a slash edit can't persist a state the
      // daemon's PUT would have refused.
      const v = validateConfig(cfg, PROVIDERS);
      if (!v.ok) return `config: invalid — ${(v.issues || []).join('; ') || 'validation failed'}`;
      ctx.writeConfig(cfg);
      if (verb === 'unset') return `config: unset ${key}`;
      // api-key is rendered into a browser and a terminal — never in the clear.
      const shown = key === 'api-key' ? maskApiKey(String(cfg[key])) : JSON.stringify(cfg[key]);
      return `config: set ${key} = ${shown}`;
    }
  }
  if (typeof ctx.openPicker !== 'function') {
    // Legacy readline path has no modal picker — keep the old /config
    // behavior there (full wizard) rather than failing.
    ctx.requestSetup = true;
    return 'EXIT';
  }
  const picked = await ctx.openPicker({
    kind: 'config-item',
    title: 'config — change one setting',
    subtitle: 'Enter to edit · Esc to cancel · /setup reruns the whole wizard',
    items: CONFIG_ITEMS.map((i) => ({ id: i.id, label: i.label, desc: i.desc })),
  });
  const id = typeof picked === 'string' ? picked : (picked && picked.id);
  if (!id || id === 'CANCEL') return 'config: cancelled';
  if (id === 'wizard') { ctx.requestSetup = true; return 'EXIT'; }
  if (id === 'channel' || id === 'webhook') {
    // These steps need raw readline prompts (secrets), so the REPL unmounts,
    // chat.mjs runs the single step, and chat restarts automatically.
    ctx.requestConfigStep = id;
    return 'EXIT';
  }
  const handler = handlers && handlers.get && handlers.get(`/${id}`);
  if (!handler) return `config: no in-chat editor for "${id}"`;
  return handler('', ctx);
}

export { CONFIG_ITEMS };
