// lib/env_compat_boot.mjs — run the LAZYCLAW_ / POMPOS_ mirror before anything
// else in the process reads an environment variable.
//
// This exists as its own module purely for ordering. ESM hoists every `import` in
// a file above the statements around them, so `cli.mjs` cannot simply call
// applyEnvCompat() "first" — but it CAN make this the first import, and a module's
// body runs before the imports that follow it in the graph.
//
// The ordering is load-bearing rather than defensive: chat_window.mjs and
// config_features.mjs read POMPOS_CHAT_WINDOW_* at module-evaluation time, into
// exported consts. If the mirror ran after them, an operator who had set only the
// LAZYCLAW_ name would silently get the defaults instead of their configured values.
//
// env_compat.mjs itself stays free of side effects so it can be unit-tested
// against a plain object.
import { applyEnvCompat } from './env_compat.mjs';

applyEnvCompat();
