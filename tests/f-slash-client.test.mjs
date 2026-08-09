// tests/f-slash-client.test.mjs — the browser half of the single write path.
//
// runSlash must return the envelope for EVERY outcome, including failures
// the daemon worked to produce — a caller told "it worked" (or told nothing
// at all, via a throw) when it didn't is the defect class this whole phase
// kept finding. Covers: 200, 409 confirmation, confirm-token replay, 400,
// a non-JSON body, a network failure, and an unrecognised future code —
// none of those should throw or get flattened into a different envelope.
import test from 'node:test';
import assert from 'node:assert/strict';

// api.mjs reads localStorage at call time; a stub is enough for these.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

test('runSlash posts the line and returns the envelope', async () => {
  const calls = stubFetch(200, { ok: true, lines: ['done'] });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/team add crew');
  assert.deepEqual(out, { ok: true, lines: ['done'] });
  assert.match(calls[0].url, /\/slash$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].body, { line: '/team add crew' });
});

test('a 409 confirmation is returned, not thrown', async () => {
  stubFetch(409, { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_x' });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/team remove crew');
  assert.equal(out.code, 'CONFIRM_REQUIRED', 'the caller decides whether to ask the user');
  assert.equal(out.token, 'c_x');
});

test('a confirm token is sent back with the same line', async () => {
  const calls = stubFetch(200, { ok: true, lines: ['removed'] });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  await runSlash('/team remove crew', { confirm: 'c_x' });
  assert.deepEqual(calls[0].body, { line: '/team remove crew', confirm: 'c_x' });
});

test('a 400 error is returned as an envelope too', async () => {
  stubFetch(400, { ok: false, error: 'unknown slash command: /nope', code: 'SLASH_ERR' });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/nope');
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown slash command/);
});

test('a non-JSON response still yields an envelope rather than throwing', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/status');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SLASH_ERR');
});

test('a network failure still yields an envelope rather than throwing', async () => {
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/status');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SLASH_ERR');
  assert.match(out.error, /fetch failed/);
});

test('an unrecognised future code passes through with its fields intact', async () => {
  // The route forwards any failure code unchanged (daemon/routes/slash.mjs) —
  // a client that normalised or dropped an unknown code would silently hide
  // a real daemon-side outcome from the caller.
  stubFetch(400, { ok: false, error: 'quota exceeded', code: 'RATE_LIMITED', retryAfter: 30 });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/loop say hi');
  assert.deepEqual(out, { ok: false, error: 'quota exceeded', code: 'RATE_LIMITED', retryAfter: 30 });
});

test('fetchCommands returns the list', async () => {
  stubFetch(200, [{ name: '/help', description: 'show help' }]);
  const { fetchCommands } = await import('../web/ui/slash_client.mjs');
  assert.deepEqual(await fetchCommands(), [{ name: '/help', description: 'show help' }]);
});
