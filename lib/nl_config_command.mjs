// lib/nl_config_command.mjs — turn a few high-signal natural-language requests
// into REAL lazyclaw config changes, so the chat model can't just reply
// "done" without anything happening (the user's bug: orchestrator on/off and
// planner/worker model swaps typed in chat were hallucinated as success).
//
// Deliberately CONSERVATIVE — it must never hijack a genuine chat turn. It only
// fires on short, imperative messages that clearly name a setting + an action,
// and bails on anything that looks like a question. Everything it doesn't catch
// falls through to the model (where the system-prompt honesty guard tells it to
// point at the real command instead of claiming success).

import { resolveModelAlias } from '../providers/claude_cli.mjs';
import { orchestratorGet, orchestratorSet, orchestratorEnable } from '../config_features.mjs';

// Appended to the chat system prompt (when one exists) so the model stops
// claiming it changed a setting it can't reach. The common orchestrator on/off
// and planner/worker swaps ARE applied for real by detectConfigCommand above;
// everything else must be redirected to a command, not faked.
export const LAZYCLAW_META_GUARD =
  'You are running inside the lazyclaw CLI. You CANNOT change lazyclaw\'s own configuration ' +
  '(provider, orchestrator planner/workers, models, agents, teams) from this chat — you have no tool for it. ' +
  'If the user asks you to change a setting, do NOT claim you did it. Instead give the exact command: ' +
  '`/orchestrator off | planner <provider:model> | worker add <provider:model>`, `lazyclaw agent add …`, ' +
  '`lazyclaw team …`, or `lazyclaw config set <key> <value>`. ' +
  '(Plain-language orchestrator on/off and planner/worker model changes are applied automatically — others are not.)';

const ORCH = /오케스트라|오케스트레이터|오케스트레이션|orchestrat/i;
const OFF = /\boff\b|\bdisable\b|끄|꺼|비활성/i;
const ON = /\bon\b|\benable\b|켜|활성/i;
const KO_MODEL = [['소넷', 'sonnet'], ['쏘넷', 'sonnet'], ['하이쿠', 'haiku'], ['오퍼스', 'opus'], ['오푸스', 'opus']];
const MODEL_TOKEN = /\b(opus|sonnet|haiku|gpt-?[0-9][\w.-]*|gemini-?[0-9][\w.-]*|o[0-9]|claude-[a-z0-9-]+)\b/i;

// Questions / explanations must pass straight through to the model.
function looksLikeQuestion(t) {
  return /[?？]/.test(t) ||
    /(법|방법|어떻게|어케|뭐|무엇|설명|알려|차이|왜|how\b|what\b|why\b|explain|difference|\bvs\b)/i.test(t);
}

function extractModel(t) {
  for (const [ko, en] of KO_MODEL) if (t.includes(ko)) return en;
  const m = MODEL_TOKEN.exec(t);
  if (!m) return null;
  const tok = m[1].toLowerCase();
  return resolveModelAlias(tok) || tok;
}

// Returns an intent object or null. Intents:
//   { kind: 'orchestrator', enable: boolean }
//   { kind: 'planner'|'worker', model: string }
export function detectConfigCommand(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return null;       // long → a real task, not a command
  if (looksLikeQuestion(t)) return null;

  if (ORCH.test(t)) {
    if (OFF.test(t)) return { kind: 'orchestrator', enable: false }; // 비활성 → off (checked first)
    if (ON.test(t)) return { kind: 'orchestrator', enable: true };
  }

  const wantsPlanner = /플래너|planner/i.test(t);
  const wantsWorker = /워커|worker/i.test(t);
  if (wantsPlanner && wantsWorker) return null;  // ambiguous — do them in separate messages
  if (wantsPlanner || wantsWorker) {
    const model = extractModel(t);
    if (model) return { kind: wantsPlanner ? 'planner' : 'worker', model };
  }
  return null;
}

const provOf = (spec) => {
  const s = String(spec || '');
  return s.includes(':') ? s.split(':')[0] : (s || 'claude-cli');
};

// Apply a detected intent for real. deps: { readConfig, writeConfig, ctxCfg? }.
// Returns a short confirmation string to show the user.
export function applyConfigCommand(intent, deps) {
  const cfg = deps.readConfig();
  const syncCtx = () => {
    if (deps.ctxCfg) { deps.ctxCfg.provider = cfg.provider; deps.ctxCfg.orchestrator = cfg.orchestrator; }
  };

  if (intent.kind === 'orchestrator') {
    orchestratorEnable(cfg, intent.enable);
    deps.writeConfig(cfg); syncCtx();
    return intent.enable
      ? '✓ Orchestrator ON — chats route through planner + workers. Set models with `/orchestrator planner <provider:model>` and `/orchestrator worker add <provider:model>`.'
      : `✓ Orchestrator off — chats route to \`${cfg.provider}\`.`;
  }

  const o = orchestratorGet(cfg);
  if (intent.kind === 'planner') {
    const spec = `${provOf(o.planner)}:${intent.model}`;
    orchestratorSet(cfg, { planner: spec });
    deps.writeConfig(cfg); syncCtx();
    return `✓ Planner → \`${spec}\`.`;
  }
  // worker — set the workers list to the chosen model (preserves the provider).
  const spec = `${provOf((o.workers && o.workers[0]) || o.planner)}:${intent.model}`;
  orchestratorSet(cfg, { workers: [spec] });
  deps.writeConfig(cfg); syncCtx();
  return `✓ Workers → [\`${spec}\`].`;
}
