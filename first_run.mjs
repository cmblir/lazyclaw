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
