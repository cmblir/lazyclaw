#!/usr/bin/env node
// Quota-free stand-in for the `gemini` CLI (@google/gemini-cli), used by the
// gemini_cli provider tests so sendMessage() exercises a REAL spawn + JSON
// parse without spending a Google login turn. It ignores the real gemini
// argument semantics and emits one canned JSON document on stdout matching the
// live `--output-format json` shape produced by gemini-cli's JsonFormatter:
//
//   { session_id, response?, stats?: { models: {...} }, error?: { type, message } }
//
// Modes (selected by a sentinel in the prompt the provider builds, since the
// caller controls the message text):
//   FAILMETERED : exit 0 with an `error` object AND a populated `stats` block
//                 (a failed-but-metered turn — the provider must still bill it)
//   default     : a clean success turn with response text + stats

const argv = process.argv.join(' ');

// gemini-cli always emits a single pretty-printed JSON document on stdout.
function emit(obj) { process.stdout.write(JSON.stringify(obj, null, 2)); }

const stats = {
  models: {
    'gemini-2.5-pro': {
      tokens: { prompt: 120, candidates: 40, thoughts: 10, cached: 20 },
    },
  },
};

if (argv.includes('FAILMETERED')) {
  // A failed turn that still consumed tokens: gemini-cli exits 0 with an
  // `error` object but the SAME JSON still carries the partial `stats`.
  emit({
    session_id: 'fake-session',
    response: '',
    stats,
    error: { type: 'ApiError', message: 'gemini upstream rejected the failed turn' },
  });
  process.exit(0);
}

// Clean success turn.
emit({ session_id: 'fake-session', response: 'ok', stats });
process.exit(0);
