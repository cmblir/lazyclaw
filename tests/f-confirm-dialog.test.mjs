// tests/f-confirm-dialog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

function stubFetchSequence(responses) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push(opts?.body ? JSON.parse(opts.body) : null);
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return calls;
}

test('a safe command runs without asking anything', async () => {
  stubFetchSequence([{ status: 200, body: { ok: true, lines: ['ok'] } }]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let asked = 0;
  const out = await runSlashConfirmed('/team list', { confirm: async () => { asked += 1; return true; } });
  assert.equal(out.ok, true);
  assert.equal(asked, 0);
});

test('an accepted confirmation retries the same line with the token', async () => {
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
    { status: 200, body: { ok: true, lines: ['removed'] } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let seenPrompt = null;
  const out = await runSlashConfirmed('/team remove crew', {
    confirm: async (p) => { seenPrompt = p; return true; },
  });
  assert.equal(seenPrompt, 'Remove team crew?', 'the user sees the blast radius, not a generic "are you sure"');
  assert.deepEqual(out, { ok: true, lines: ['removed'] });
  assert.deepEqual(calls[1], { line: '/team remove crew', confirm: 'c_1' });
});

test('a declined confirmation does NOT retry and reports cancellation', async () => {
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  const out = await runSlashConfirmed('/team remove crew', { confirm: async () => false });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CANCELLED');
  assert.equal(calls.length, 1, 'nothing is sent after a decline');
});

test('a second confirmation is not asked twice in a row', async () => {
  // If the server asks again after a redemption something is wrong; surface it
  // rather than looping.
  stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'p', token: 'c_1' } },
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'p', token: 'c_2' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let asked = 0;
  const out = await runSlashConfirmed('/team remove crew', { confirm: async () => { asked += 1; return true; } });
  assert.equal(asked, 1, 'ask once, then stop');
  assert.equal(out.ok, false);
});
