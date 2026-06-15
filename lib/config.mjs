// Shared config + key/url resolution helpers, extracted from cli.mjs so the
// per-domain command modules (commands/*.mjs) can import them without pulling
// in the whole entrypoint. Leaf module: depends only on node builtins and the
// owner-only secure writer — never on the provider registry (the registry
// dependency is injected via setRegistryEnvResolver to keep this a leaf and
// avoid a config<->registry_boot import cycle).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// Owner-only (0600/0700) atomic writer for config.json — it holds plaintext
// API keys / auth profiles and must not be group/other readable.
import { writeJsonSecure, tightenIfLoose } from '../secure_write.mjs';

export function configPath() {
  const override = process.env.LAZYCLAW_CONFIG_DIR;
  const dir = override ? override : path.join(os.homedir(), '.lazyclaw');
  return path.join(dir, 'config.json');
}

// Thrown when config.json EXISTS but is not parseable JSON. We fail fast here
// instead of returning {} so a typo in the file can't masquerade as a fresh
// install (silently dropping provider/keys/channels) and — critically — so a
// downstream writeConfig never clobbers the recoverable, hand-editable bytes.
export class ConfigError extends Error {
  constructor(message, { path: p, cause } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.path = p;
    if (cause) this.cause = cause;
  }
}

export function readConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  // Migrate already-deployed world/group-readable config.json (plaintext keys)
  // to 0600 the first time we touch it. Best-effort, idempotent.
  tightenIfLoose(p);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    // PRESENT-BUT-CORRUPT: never return {} (would look fresh and let a later
    // writeConfig overwrite the file). Warn loudly + actionably, then throw so
    // the CLI boot boundary fails fast with the settings still on disk.
    process.stderr.write(
      `\nlazyclaw: config.json is present but not valid JSON — refusing to ` +
      `continue so your settings aren't lost.\n` +
      `  path:  ${p}\n` +
      `  error: ${e.message}\n` +
      `  recover: fix the JSON, or move it aside ` +
      `(e.g. \`mv ${p} ${p}.bak\`) to start fresh.\n\n`,
    );
    throw new ConfigError(`config.json at ${p} is not valid JSON: ${e.message}`, { path: p, cause: e });
  }
}

export function writeConfig(cfg) {
  // 0600 file in a 0700 dir, atomically — config.json stores plaintext API
  // keys / auth profiles, so it must be owner-only on disk.
  writeJsonSecure(configPath(), cfg);
}

// Persist the active model selection to disk so it survives a restart
// (read-merge-write keeps unrelated keys). An empty/null name clears cfg.model
// so the provider falls back to its own default. Mirrors onto the in-memory
// `liveCfg` so the running session sees it without a re-read. Best-effort: a
// write failure must not break the in-memory switch the caller already made.
//
// Why this exists: /model (and the legacy readline path) historically mutated
// the in-memory active model only, so a model picked in one session reverted to
// cfg.model on the next launch. Routing the setter through here makes the
// choice stick.
export function persistActiveModel(liveCfg, name) {
  try {
    const c = readConfig();
    if (name) c.model = name; else delete c.model;
    writeConfig(c);
    if (liveCfg && typeof liveCfg === 'object') {
      if (name) liveCfg.model = name; else delete liveCfg.model;
    }
  } catch { /* best-effort — keep the in-memory selection */ }
}

// Persist the active provider, with one guard: orchestrator routing is owned by
// `/orchestrator on|off` (which stashes _prevProvider), so the model/provider
// setters must never write 'orchestrator' themselves nor clobber a saved
// 'orchestrator' provider. For ordinary provider switches it read-merge-writes
// cfg.provider and mirrors onto liveCfg.
export function persistActiveProvider(liveCfg, name) {
  if (!name || name === 'orchestrator') return;
  try {
    const c = readConfig();
    if (c.provider === 'orchestrator') return; // orchestrator active — leave its routing alone
    c.provider = name;
    writeConfig(c);
    if (liveCfg && typeof liveCfg === 'object') liveCfg.provider = name;
  } catch { /* best-effort */ }
}

// Injected built-in OpenAI-compat env-var resolver. registry_boot wires this
// to registry.resolveBuiltinEnvKey on ensureRegistry() so _resolveAuthKey can
// fall back to provider env vars without importing the registry (no cycle).
let _envResolver = null;
export function setRegistryEnvResolver(fn) { _envResolver = fn; }

// Synchronous, dependency-free resolver for the api-key the
// chat / agent flow sends. Mirrors config_features.resolveApiKey
// without forcing the dynamic import on every hot-path call.
//   1. cfg.authProfiles[provider] active label, if set
//   2. first profile in the array
//   3. customProviders[<provider>].apiKey (custom OpenAI-compat entries)
//   4. PROVIDER_INFO[<provider>].envKey / altEnvKeys env var (built-in
//      OpenAI-compat: nim → NVIDIA_API_KEY, openrouter → OPENROUTER_API_KEY, …)
//   5. legacy single `cfg["api-key"]` (pre-v3.93 configs)
export function _resolveAuthKey(cfg, provider) {
  const arr = (cfg.authProfiles || {})[provider] || [];
  const active = (cfg.authActiveProfile || {})[provider];
  const hit = arr.find((p) => p && p.label === active) || arr[0];
  if (hit?.key) return hit.key;
  const custom = Array.isArray(cfg.customProviders)
    ? cfg.customProviders.find((p) => p && p.name === provider)
    : null;
  if (custom?.apiKey) return custom.apiKey;
  // Built-in OpenAI-compat env var fallback. Skipped silently when the
  // registry module isn't loaded yet (every chat / agent path calls
  // ensureRegistry() before _resolveAuthKey, so this is just defence-in-depth).
  if (typeof _envResolver === 'function') {
    const envHit = _envResolver(provider);
    if (envHit) return envHit;
  }
  return cfg['api-key'] || '';
}

// Per-provider base-URL override (used by tests + private gateways).
// Single source of truth — the reflect / skill-synth / task-tick paths
// all resolve through here so a new provider's env var lands in one spot.
export function _resolveBaseUrl(provider) {
  return {
    anthropic: process.env.LAZYCLAW_ANTHROPIC_BASE_URL,
    openai:    process.env.LAZYCLAW_OPENAI_BASE_URL,
    gemini:    process.env.LAZYCLAW_GEMINI_BASE_URL,
  }[provider] || undefined;
}

export function readVersionFromRepo() {
  // Two source-of-truth lookups, in order:
  //   1. The npm-published package's own package.json (sits next to the
  //      entrypoint once installed via `npm i -g lazyclaw`).
  //   2. The monorepo's VERSION file at the repo root (one or two
  //      levels up depending on how the file is symlinked / copied).
  // Either one wins on first hit. Falls back to '0.0.0' so the CLI
  // never crashes on a stripped-down install. The candidate list is a
  // superset spanning both the repo-root entrypoint and this lib/ module
  // location so resolution is identical regardless of where it runs from.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    { kind: 'pkg',     path: path.resolve(here, './package.json') },
    { kind: 'pkg',     path: path.resolve(here, '../package.json') },
    { kind: 'pkg',     path: path.resolve(here, '../../package.json') },
    { kind: 'version', path: path.resolve(here, '../../VERSION') },
    { kind: 'version', path: path.resolve(here, '../../../VERSION') },
    { kind: 'version', path: path.resolve(here, '../../../../VERSION') },
  ];
  for (const c of candidates) {
    try {
      const raw = fs.readFileSync(c.path, 'utf8').trim();
      if (!raw) continue;
      if (c.kind === 'pkg') {
        const v = JSON.parse(raw).version;
        if (v) return v;
      } else {
        return raw;
      }
    } catch { /* keep trying */ }
  }
  return '0.0.0';
}
