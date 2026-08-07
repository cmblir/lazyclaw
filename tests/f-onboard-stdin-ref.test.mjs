// tests/f-onboard-stdin-ref.test.mjs — pins that cmdOnboard re-references
// process.stdin before it reads from it.
//
// This is the SECOND instance of one bug class. tui/pickers.mjs's _arrowMenu
// unrefs process.stdin in its cleanup (deliberately, so `pompos setup` can
// exit instead of hanging). libuv's unref is sticky: neither resume() nor
// attaching a listener re-references the handle, and — verified against the
// real node:readline — `readline.createInterface()` calls input.resume() but
// never input.ref(). So any reader that follows a picker must ref() explicitly.
//
// cmdOnboard runs _pickProviderInteractive() (which ends in an _arrowMenu) and
// then builds its own bare readline interface. Two ordinary paths then await
// rl.question() on the unreferenced handle, and the process exits 0 with the
// prompt on screen and the answer never read:
//
//   1. the user backs out of the picker (Esc / q) -> picked is null -> the
//      `if (!flags.provider)` prompt runs;
//   2. the user takes "▷ Use the provider's own default model" — the
//      pre-selected, recommended option for keyless claude-cli / codex-cli /
//      gemini-cli — which yields an empty model, so `if (picked.model && …)`
//      is false and the `if (!flags.model)` prompt runs.
//
// cmdOnboard takes no injectable deps and its prompts need a real TTY stdin, so
// driving it end-to-end from a unit test would mean racing real terminal state.
// The property that matters is purely the ORDER of two statements, so a
// source-level assertion is the honest way to pin it — same reasoning and same
// shape as tests/f-daemon-shutdown-pidfile-order.test.mjs.
//
// tui/prompt_back.mjs and tui/pickers.mjs's _quickPrompt / _quickPromptSecret
// already pair resume() with ref() for exactly this reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'commands', 'setup.mjs'), 'utf8');

// Narrow to cmdOnboard so the assertions cannot be satisfied by an unrelated
// resume()/ref() pair elsewhere in this large file, and strip comments so a
// mention of a call inside an explanatory comment is not mistaken for the call
// itself (the comment above the fix names readline.createInterface).
function onboardBody() {
  const start = SRC.indexOf('export async function cmdOnboard');
  assert.ok(start > -1, 'cmdOnboard not found in commands/setup.mjs');
  const next = SRC.indexOf('\nexport ', start + 1);
  const body = SRC.slice(start, next > -1 ? next : SRC.length);
  return body
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

test('cmdOnboard re-references stdin before creating its readline interface', () => {
  const body = onboardBody();
  const ref = body.search(/process\.stdin\.ref\s*\(/);
  const rl = body.indexOf('readline.createInterface');
  assert.ok(rl > -1, 'expected cmdOnboard to build a readline interface');
  assert.ok(
    ref > -1,
    'cmdOnboard must call process.stdin.ref() — _pickProviderInteractive ends in an '
    + '_arrowMenu whose cleanup unrefs stdin, and readline.createInterface resumes but '
    + 'does not re-reference the handle, so rl.question() resolves never and the process '
    + 'exits 0 with the prompt on screen',
  );
  assert.ok(
    ref < rl,
    'process.stdin.ref() must come BEFORE readline.createInterface — refing after the '
    + 'interface exists does not help a question() that has already been awaited',
  );
});

test('node:readline resumes its input but never re-references it (the reason the ref is needed)', () => {
  const s = new EventEmitter();
  s.isTTY = true;
  let resumed = false;
  let refd = false;
  s.resume = () => { resumed = true; return s; };
  s.pause = () => s;
  s.ref = () => { refd = true; return s; };
  s.setRawMode = () => s;
  const rl = readline.createInterface({ input: s, output: { write() {} } });
  rl.close();
  assert.equal(resumed, true, 'createInterface is expected to resume its input');
  assert.equal(refd, false, 'if node ever starts ref-ing here, the guard in cmdOnboard becomes redundant');
});
