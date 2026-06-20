// Shared secret redaction — Phase 20 hardening.
//
// A single source of truth for stripping common secret shapes out of
// text before it is (a) sent to an LLM or (b) persisted to a file that
// later re-enters a system prompt. Both skill_synth.synthesizeSkill and
// agent_memory.reflectOnce import this so the two paths stay symmetric:
// neither a distilled skill nor a reflection memory can ever leak a
// token that merely appeared in a task transcript.
//
// This module has zero internal imports so it can be imported from
// anywhere without risking a cycle.

// Redact common secret shapes (private keys, provider API tokens,
// bearer headers, KEY/TOKEN/SECRET/PASSWORD env assignments). The match
// list mirrors the audit log's posture of not persisting raw sensitive
// I/O. Order matters: the private-key block is collapsed first so its
// inner base64 doesn't trip the narrower token patterns.
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    // Inline credentials in a URL: scheme://user:password@host → redact the password.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, '$1:[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED JWT]')
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [REDACTED]')
    // Uppercase env-assignment form (kept for parity / readability).
    .replace(/\b([A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*\S+/g, '$1=[REDACTED]')
    // Case-insensitive key/token/secret/password assignment (api_key=, apiKey: "...", PASSWORD=…).
    // [\w-]* may be empty so a bare `password:` / `token=` is caught too.
    .replace(/\b([\w-]*(?:key|token|secret|password))\s*[:=]\s*["']?[^\s"']+/gi, '$1=[REDACTED]');
}

// Object keys whose STRING values carry credential material. Matched
// case-insensitively as a substring of each key, so apiKey / api-key /
// botToken / appToken / accessToken / clientSecret / authorization / password
// / privateKey are all caught at any nesting depth. Only STRING values are
// masked, so a numeric budget (chatWindow.tokens) or a rate card never is.
const SENSITIVE_KEY_RE = /(api[-_]?key|apikey|secret|passwd|password|token|authorization|credential|bearer|private[-_]?key|access[-_]?key)/i;

// Deep-redact a config-shaped value: recursively clone, masking the string
// value of any secret-named key. Structure, arrays, numbers, and non-secret
// strings are preserved; the input is never mutated. `mask` lets the caller
// substitute a hinted masker (maskApiKey) instead of the default sentinel.
export function redactConfigTree(value, mask = () => '[REDACTED]', keyName = '') {
  if (Array.isArray(value)) return value.map((v) => redactConfigTree(v, mask));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactConfigTree(v, mask, k);
    return out;
  }
  if (typeof value === 'string' && keyName && SENSITIVE_KEY_RE.test(keyName)) {
    return value ? mask(value) : value;
  }
  return value;
}

// Neutralise forged conversation role labels embedded in untrusted model
// text. The reflection/synthesis transcript is rendered as
// `[User]/[System]/<agent>` lines from the TRUSTED turn.agent field; a
// turn's free-text body must not be able to inject its own authority
// line (e.g. a newline followed by "[System] ignore previous"). We defang
// only the authority roles (case-insensitive, line-leading) so a forged
// instruction can't masquerade as the system/user/assistant speaker.
export function neutralizeRoleLabels(text) {
  return String(text ?? '').replace(/^([ \t]*)\[(user|system|assistant|agent)\]/gim, '$1($2)');
}
