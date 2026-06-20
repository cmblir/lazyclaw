// tests/f-coding-env-scrub.test.mjs — python_exec/node_exec spawned children
// with env:process.env (every secret) while their descriptions claimed a
// "sandboxed subprocess". A prompt-injected `print(os.environ)` exfiltrated
// every key. Mirror bash.mjs: scrub secrets from the child env, and stop
// claiming a sandbox the tool does not provide.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../mas/tools/coding.mjs';

const node_exec = TOOLS.find((t) => t.name === 'node_exec');
const python_exec = TOOLS.find((t) => t.name === 'python_exec');

test('node_exec strips secret-named env vars from the child process', async () => {
  process.env.SUPER_SECRET_TOKEN = 'leakme-9999';
  try {
    const r = await node_exec.exec({ code: "process.stdout.write(process.env.SUPER_SECRET_TOKEN || 'STRIPPED')" }, {});
    assert.equal(r.ok, true, r.error || r.stderr);
    assert.ok(!r.stdout.includes('leakme-9999'), 'secret env must not reach the child');
    assert.match(r.stdout, /STRIPPED/);
  } finally {
    delete process.env.SUPER_SECRET_TOKEN;
  }
});

test('coding exec tool descriptions do not falsely claim a sandbox', () => {
  for (const t of [python_exec, node_exec]) {
    assert.doesNotMatch(t.description, /sandbox/i, `${t.name} must not claim sandboxing it does not provide`);
  }
});
