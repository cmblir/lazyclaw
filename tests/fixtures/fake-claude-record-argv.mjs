#!/usr/bin/env node
// Recording stand-in for the `claude` CLI: writes its own argv (as JSON) to the
// path in POMPOS_ARGV_OUT, then emits one canned stream-json turn and exits.
// Used to prove that runAgentTurn threads an explicit permissionMode all the way
// into the spawned claude's --permission-mode argument.

import { writeFileSync } from 'node:fs';

const out = process.env.POMPOS_ARGV_OUT;
if (out) {
  try { writeFileSync(out, JSON.stringify(process.argv.slice(2))); } catch { /* best-effort */ }
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
emit({ type: 'system', subtype: 'init' });
for (const ch of 'ok') {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } });
}
emit({ type: 'assistant', message: { usage: { input_tokens: 2, output_tokens: 2 } } });
emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 0 } });
process.exit(0);
