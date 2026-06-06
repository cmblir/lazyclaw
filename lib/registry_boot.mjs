// Provider-registry bootstrap, extracted from cli.mjs so every command module
// (commands/*.mjs) shares one lazily-loaded registry instance instead of each
// re-importing and re-registering. One-directional dependency: registry_boot
// -> config (never the reverse), so this stays cycle-free.
import { readConfig, _resolveAuthKey, setRegistryEnvResolver } from './config.mjs';

let _registryMod = null;

// Throwing accessor — use when the caller has already awaited ensureRegistry()
// and a null registry would be a programmer error.
export function requireRegistry() {
  if (!_registryMod) {
    throw new Error('registry module not pre-loaded — call ensureRegistry() first');
  }
  return _registryMod;
}

// Nullable accessor — returns the loaded registry module or null. Mirrors the
// old bare `_registryMod` read semantics for sites that tolerate "not loaded".
export function getRegistry() {
  return _registryMod;
}

export async function ensureRegistry() {
  if (!_registryMod) {
    _registryMod = await import('../providers/registry.mjs');
    // Wire config._resolveAuthKey's built-in env-var fallback to the registry
    // without config importing the registry (keeps config a leaf module).
    if (typeof _registryMod.resolveBuiltinEnvKey === 'function') {
      setRegistryEnvResolver((p) => _registryMod.resolveBuiltinEnvKey(p));
    }
  }
  // Re-run registration on every call so config changes within the same
  // process (e.g. setup wizard adding a custom endpoint mid-session) take
  // effect for the next chat / agent / picker invocation. registerCustom-
  // Providers is idempotent — re-registering the same name is a no-op.
  try {
    if (typeof _registryMod.registerCustomProviders === 'function') {
      _registryMod.registerCustomProviders(readConfig());
    }
  } catch { /* never let a malformed cfg.customProviders block startup */ }
  // Wire the orchestrator's live cfg + auth-key resolver. We do this on
  // every ensureRegistry() call (cheap — just replaces the closure) so a
  // mid-session config edit (custom provider added, env var exported)
  // takes effect on the next orchestrator turn without a restart.
  try {
    if (typeof _registryMod.registerOrchestrator === 'function') {
      _registryMod.registerOrchestrator({
        cfgGetter: readConfig,
        keyResolver: _resolveAuthKey,
      });
    }
  } catch { /* defensive */ }
  return _registryMod;
}
