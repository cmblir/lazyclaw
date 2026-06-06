// providers/auth_store.mjs — persist an api key for a provider into the
// authProfiles config shape that _resolveAuthKey reads (cfg.authProfiles
// [provider] = [{ label, key }], cfg.authActiveProfile[provider] = label).
//
// Extracted as a tiny DI'd helper so the Ink /provider key-entry flow can
// store a key without re-implementing the config shape. No disk — readConfig/
// writeConfig are injected.

export function setAuthKey({ readConfig, writeConfig, provider, key, label = 'default' }) {
  const cfg = readConfig();
  cfg.authProfiles = cfg.authProfiles && typeof cfg.authProfiles === 'object' ? cfg.authProfiles : {};
  cfg.authActiveProfile = cfg.authActiveProfile && typeof cfg.authActiveProfile === 'object' ? cfg.authActiveProfile : {};
  const arr = Array.isArray(cfg.authProfiles[provider]) ? cfg.authProfiles[provider].slice() : [];
  const idx = arr.findIndex((p) => p && p.label === label);
  const entry = { label, key: String(key) };
  if (idx >= 0) arr[idx] = { ...arr[idx], ...entry };
  else arr.push(entry);
  cfg.authProfiles[provider] = arr;
  cfg.authActiveProfile[provider] = label;
  writeConfig(cfg);
  return cfg;
}
