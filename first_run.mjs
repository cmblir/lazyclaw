// first_run.mjs — decide what onboarding the chat entrypoint runs.
//
//   'setup' — genuine fresh install (no provider, interactive): run the full
//             5-step guided setup (provider+model, workspace, skills) instead
//             of only the provider picker the Ink path used to run.
//   'pick'  — explicit `chat --pick`: just re-pick provider/model.
//   'none'  — provider already configured, or non-interactive (automation).
//
// Pure so it unit-tests without a TTY.
export function firstRunMode({ hasProvider, flagPick, isTTY }) {
  if (!isTTY) return 'none';
  if (flagPick) return 'pick';
  if (!hasProvider) return 'setup';
  return 'none';
}

// A blank or 'mock' provider is a placeholder, not a real configured choice:
// the mock provider returns canned replies and v5.3.2 stopped treating it as a
// usable default. Treat both as "not configured" so the very first run always
// lands in setup, and only a genuine saved provider skips it afterwards.
const PLACEHOLDER_PROVIDERS = new Set(['', 'mock']);
export function hasConfiguredProvider(provider) {
  return !PLACEHOLDER_PROVIDERS.has(String(provider ?? '').trim().toLowerCase());
}
