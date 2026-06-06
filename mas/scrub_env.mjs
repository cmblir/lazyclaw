// scrub_env.mjs — strip secret-bearing variables from an environment copy.
//
// The bash tool inherits the parent process environment so commands behave
// like a normal shell (PATH, HOME, locale, proxy settings, …). But the parent
// env also carries provider API keys and channel tokens — including anything
// loaded from <configDir>/.env by dotenv_min — and an agent's shell command is
// model-controlled (and steerable via prompt injection). Passing the raw env
// to a child lets a single `env | curl …` exfiltrate every credential.
//
// scrubEnv returns a COPY of `env` with keys that look like secrets removed,
// while keeping the operational variables a command legitimately needs. An
// explicit `allow` list opts specific keys back in for the rare command that
// genuinely needs one.

// Matches keys whose final _-segment is a secret-ish noun: FOO_API_KEY,
// ANTHROPIC_API_KEY, *_TOKEN (incl. CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN),
// *_SECRET, *_PASSWORD/PASSWD, *_CREDENTIAL(S), *_PRIVATE_KEY, *_ACCESS_KEY.
const SECRET_KEY_RE =
  /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)$/i;

export function isSecretKey(name) {
  return SECRET_KEY_RE.test(String(name || ''));
}

export function scrubEnv(env = process.env, { allow = [] } = {}) {
  const allowSet = new Set(allow);
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (allowSet.has(k)) { out[k] = v; continue; }
    if (isSecretKey(k)) continue; // drop secrets
    out[k] = v;
  }
  return out;
}
