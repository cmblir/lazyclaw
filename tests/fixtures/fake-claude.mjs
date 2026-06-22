#!/usr/bin/env node
// Quota-free stand-in for the `claude` CLI, used only by the benchmark-harness
// tests so spawnAndMeasure() exercises a REAL spawn + stream-json parse without
// spending a subscription turn. It ignores the real argument semantics and just
// emits a canned stream-json turn matching the live shapes (claude 2.1.185):
// system/init, per-character text deltas, an `assistant` usage event (the
// truthful per-turn usage), then a `result` event (cost/duration/turns; zero
// usage, as the live CLI does under --include-partial-messages).
//
// One-shot mode (the `-p` path): emit one turn for the text "ok" and exit.
// Stream mode (`--input-format stream-json`): emit one "echo" turn per stdin
// line and stay alive — mirrors providers/claude_cli_session.mjs.

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function oneTurn(text) {
  emit({ type: 'system', subtype: 'init' });
  for (const ch of text) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } });
  }
  emit({ type: 'assistant', message: { usage: {
    input_tokens: 2, cache_creation_input_tokens: 3189, cache_read_input_tokens: 0, output_tokens: text.length,
  } } });
  emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123,
    duration_ms: 111, duration_api_ms: 99, num_turns: 1, usage: { input_tokens: 0 } });
}

if (!process.argv.includes('--input-format')) {
  oneTurn('ok');
  process.exit(0);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try { JSON.parse(line); oneTurn('echo'); } catch { /* ignore non-JSON */ }
  }
});
