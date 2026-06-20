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

// Matches keys whose final _-segment is a secret-ish noun. Now includes bare
// *_KEY / *_KEY_ID so the previously-missed STRIPE_SECRET_KEY, SUPABASE_KEY,
// ENCRYPTION_KEY, AWS_ACCESS_KEY_ID are caught — while the suffix anchoring
// still leaves KEYBOARD / TOKENIZER / MONKEY / BASE_URL alone.
const SECRET_KEY_RE =
  /(^|_)(API_?KEYS?|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|KEY|KEY_ID|AUTH_TOKEN|SESSION_TOKEN)$/i;

// Names that carry credentials but aren't caught by the suffix-noun rule —
// connection strings (value is a URL with embedded creds) and the ssh-agent
// socket (a child with it can use the agent's keys).
const SECRET_NAME_SET = new Set([
  'SSH_AUTH_SOCK', 'DATABASE_URL', 'DATABASE_URI', 'DB_URL', 'DB_URI', 'DSN',
  'CONNECTION_STRING', 'PGPASSWORD', 'MYSQL_PWD', 'REDIS_URL', 'MONGODB_URI', 'MONGO_URL',
]);

// A value that is a credential-bearing URL (scheme://user:password@host) leaks
// a secret regardless of the variable's name (e.g. a benign-looking *_URL).
const URL_CRED_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

export function isSecretKey(name) {
  const k = String(name || '');
  return SECRET_KEY_RE.test(k) || SECRET_NAME_SET.has(k.toUpperCase());
}

export function scrubEnv(env = process.env, { allow = [] } = {}) {
  const allowSet = new Set(allow);
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (allowSet.has(k)) { out[k] = v; continue; }
    if (isSecretKey(k)) continue;                 // drop by name
    if (typeof v === 'string' && URL_CRED_RE.test(v)) continue; // drop creds embedded in a URL value
    out[k] = v;
  }
  return out;
}
