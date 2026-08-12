// tests/f-pairing-client.test.mjs — the browser's side of the handshake.
//
// The payload this module signs is checked against the REAL verifyConnect, not
// against a second copy of the expected string: a browser that builds the
// canonical payload even slightly differently produces a signature the gateway
// rejects, and only the real verifier catches that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createPublicKey } from 'node:crypto';
import { verifyConnect, deviceIdFromPublicKey, buildSignPayload } from '../gateway/device_auth.mjs';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

function fakeStore() {
  let held = null;
  return { async get() { return held; }, async put(p) { held = p; }, async del() { held = null; }, peek() { return held; } };
}

// A recording fetch that answers by pathname, so a test states only the
// responses it cares about and the call log proves the sequence.
function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts = {}) => {
      const path = String(url).split('?')[0];
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ path, body, headers: opts.headers || {} });
      const handler = routes[path];
      if (!handler) throw new Error(`unstubbed fetch: ${path}`);
      const r = typeof handler === 'function' ? handler(body, calls.length) : handler;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
}

function deps(fetchImpl, store = fakeStore()) {
  return { fetch: fetchImpl, subtle: webcrypto.subtle, store };
}

// pairing.mjs keeps its device token in a module-level variable (deliberately
// not persisted — see the module header). A bare `import('../web/ui/pairing.mjs')`
// resolves to the SAME cached module across every test in this file, so a
// token minted by one test would leak into the next and mask exactly the
// "no session yet" cases this suite exercises. Cache-busting the specifier
// (the same idiom used by tests/f-phase0-cron.test.mjs and
// tests/phaseG-prompt-stack.test.mjs for other module-level singletons) gives
// each test its own fresh module instance instead.
let importSeq = 0;
function freshPairing() {
  return import(`../web/ui/pairing.mjs?t=${Date.now()}-${importSeq++}`);
}

test('a first-device pair yields a device token the gateway would accept', async () => {
  const nonce = 'a'.repeat(64);
  let connected = null;
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: b && b.publicKey ? deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) : '' } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => { connected = b; return { status: 200, body: { ok: true, deviceId: b.deviceId, token: 'dev_tok_1' } }; },
  });
  const { pairThisBrowser } = await freshPairing();
  const out = await pairThisBrowser(deps(f.fetch));
  assert.equal(out.ok, true);

  // The real verifier is the only judge that matters here.
  const der = Buffer.from(connected.publicKey, 'base64');
  const verdict = verifyConnect({
    payload: connected.payload,
    signature: connected.signature,
    publicKey: createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }),
    challenge: { nonce },
    nowMs: Date.now(),
  });
  // verifyConnect's success shape is { ok: true, reason: 'ok' } (see
  // gateway/device_auth.mjs) — assert on .ok, not the whole object, so this
  // doesn't pin an incidental diagnostic string that isn't part of the contract.
  assert.equal(verdict.ok, true, verdict.reason || '');
  assert.equal(connected.nonce, nonce, 'the challenge nonce must ride the body as well as the payload');
  assert.deepEqual(f.calls.map((c) => c.path),
    ['/devices/pair', '/gateway/connect/challenge', '/gateway/connect'],
    'pair first, then handshake — the connect can only mint a token once the device is approved');
});

// Feeding the produced payload's own fields back into buildSignPayload would
// pass for ANY 11-field `|`-join — a swapped field order or a wrong
// CLIENT_ID/CLIENT_MODE/PLATFORM/DEVICE_FAMILY would round-trip identically.
// The expected string is therefore built from the four constants this client is
// contracted to send, and from the deviceId derived independently from the key
// it actually presented. Only signedAtMs is read back out of the payload:
// pairing.mjs stamps Date.now() internally, so the test cannot know it.
test('the signed payload matches buildSignPayload field for field', async () => {
  const nonce = 'b'.repeat(64);
  let connected = null;
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => { connected = b; return { status: 200, body: { ok: true, deviceId: b.deviceId, token: 't' } }; },
  });
  const { pairThisBrowser } = await freshPairing();
  await pairThisBrowser(deps(f.fetch));
  const parts = connected.payload.split('|');
  assert.equal(parts.length, 11, 'buildSignPayload emits exactly 11 fields');
  const signedAtMs = Number(parts[6]);
  assert.ok(Number.isFinite(signedAtMs) && signedAtMs > 1_600_000_000_000,
    `field 7 must be the epoch-ms sign time; got ${JSON.stringify(parts[6])}`);
  const expected = buildSignPayload({
    deviceId: deviceIdFromPublicKey(Buffer.from(connected.publicKey, 'base64')),
    clientId: 'pompos-dashboard',
    clientMode: 'dashboard',
    role: '',
    scopes: [],
    signedAtMs,
    token: '',
    nonce,
    platform: 'browser',
    deviceFamily: 'dashboard',
  });
  assert.equal(connected.payload, expected);
});

test('a pending pair reports PENDING_APPROVAL with the operator instruction, and never claims success', async () => {
  const f = fakeFetch({
    // No `ok` on the 202 — daemon/routes/devices_pair.mjs deliberately omits it
    // so a consumer testing body.ok cannot read "pending" as success.
    '/devices/pair': { status: 202, body: { status: 'pending', deviceId: 'sha256:' + 'c'.repeat(64), requestId: 'pr_1', fingerprint: 'cccccccccccc' } },
  });
  const { pairThisBrowser } = await freshPairing();
  const out = await pairThisBrowser(deps(f.fetch));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PENDING_APPROVAL');
  assert.equal(out.requestId, 'pr_1');
  assert.equal(out.fingerprint, 'cccccccccccc');
  assert.match(out.error, /pompos nodes approve/, 'the operator must be told the one command that unblocks them');
  assert.deepEqual(f.calls.map((c) => c.path), ['/devices/pair'], 'a pending device must not attempt the handshake');
});

test('resolveApproval sends the DEVICE token, not the dashboard bearer token', async () => {
  const nonce = 'd'.repeat(64);
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'dev_tok_9' } }),
    '/gateway/exec/resolve': { status: 200, body: { ok: true, id: 'ap_1', approved: true } },
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  const paired = await pairThisBrowser(d);
  const out = await resolveApproval('ap_1', 'approve', d);
  assert.deepEqual(out, { ok: true, id: 'ap_1', approved: true });
  const resolveCall = f.calls.find((c) => c.path === '/gateway/exec/resolve');
  assert.equal(resolveCall.headers.Authorization, 'Bearer dev_tok_9');
  assert.equal(resolveCall.headers['x-device-id'], paired.deviceId);
  assert.deepEqual(resolveCall.body, { id: 'ap_1', decision: 'approve' });
});

test('resolving without a paired device reports NOT_PAIRED and sends no resolve at all', async () => {
  const f = fakeFetch({
    '/devices/pair': { status: 202, body: { status: 'pending', deviceId: 'sha256:' + 'e'.repeat(64), requestId: 'pr_2' } },
  });
  const { resolveApproval } = await freshPairing();
  const out = await resolveApproval('ap_2', 'approve', deps(f.fetch));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_PAIRED');
  assert.equal(f.calls.some((c) => c.path === '/gateway/exec/resolve'), false,
    'the security claim of this phase is that a bearer token alone cannot resolve — so no resolve may be attempted');
});

test('a stale device token is re-minted once, then the resolve retried', async () => {
  const nonce = 'f'.repeat(64);
  let issued = 0;
  let resolves = 0;
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: `dev_tok_${++issued}` } }),
    '/gateway/exec/resolve': () => (++resolves === 1
      ? { status: 401, body: { ok: false, reason: 'invalid device token' } }
      : { status: 200, body: { ok: true, id: 'ap_3', approved: true } }),
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  await pairThisBrowser(d);
  const out = await resolveApproval('ap_3', 'approve', d);
  assert.equal(out.ok, true);
  assert.equal(issued, 2, 'a 401 must re-mint from the non-extractable key rather than give up');
  assert.equal(resolves, 2);
});

test('a 401 that survives the re-mint reports NOT_PAIRED, never success', async () => {
  const nonce = 'a'.repeat(64);
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'stale' } }),
    '/gateway/exec/resolve': { status: 401, body: { ok: false, reason: 'invalid device token' } },
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  await pairThisBrowser(d);
  const out = await resolveApproval('ap_4', 'approve', d);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_PAIRED');
});

test('a re-pair failure other than PENDING_APPROVAL keeps its own code across the 401 retry', async () => {
  const nonce = 'a'.repeat(64);
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'tok' } }),
    '/gateway/exec/resolve': { status: 401, body: { ok: false, reason: 'invalid device token' } },
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  await pairThisBrowser(d); // establishes a live `held` token with real WebCrypto

  // Simulate this browser losing WebCrypto before the retry (e.g. the
  // dashboard got reopened over plain HTTP): resolveApproval's internal
  // re-pair attempt must fail with NO_WEBCRYPTO, not be collapsed to
  // NOT_PAIRED — a "Pair this browser" retry can never succeed for that
  // cause, so the UI must be told the real reason.
  const noCrypto = { fetch: f.fetch, subtle: undefined, store: fakeStore() };
  const out = await resolveApproval('ap_7', 'approve', noCrypto);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_WEBCRYPTO',
    'a re-pair failure other than PENDING_APPROVAL must keep its own code, not collapse to NOT_PAIRED');
});

test('a resolved-or-expired approval reports APPROVAL_GONE', async () => {
  const nonce = 'a'.repeat(64);
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'tok' } }),
    '/gateway/exec/resolve': { status: 404, body: { ok: false, reason: 'unknown or already resolved' } },
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  await pairThisBrowser(d);
  const out = await resolveApproval('ap_5', 'approve', d);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APPROVAL_GONE');
  assert.match(out.error, /already resolved|expired/i);
});

test('a read-only device reports READ_ONLY', async () => {
  const nonce = 'a'.repeat(64);
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'tok' } }),
    '/gateway/exec/resolve': { status: 403, body: { ok: false, reason: 'insufficient scope: a read-only device cannot resolve exec approvals' } },
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  await pairThisBrowser(d);
  const out = await resolveApproval('ap_6', 'approve', d);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'READ_ONLY');
});

test('no WebCrypto surfaces as NO_WEBCRYPTO with the loopback instruction', async () => {
  const f = fakeFetch({});
  const { pairThisBrowser } = await freshPairing();
  const out = await pairThisBrowser({ fetch: f.fetch, subtle: undefined, store: fakeStore() });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_WEBCRYPTO');
  assert.match(out.error, /localhost|127\.0\.0\.1/);
  assert.deepEqual(f.calls, [], 'nothing to send when no identity can exist');
});

test('unpairThisBrowser drops the local key and the held token', async () => {
  const nonce = 'a'.repeat(64);
  const store = fakeStore();
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'tok' } }),
  });
  const d = deps(f.fetch, store);
  const { pairThisBrowser, unpairThisBrowser, isPaired } = await freshPairing();
  await pairThisBrowser(d);
  assert.equal(await isPaired(d), true);
  await unpairThisBrowser(d);
  assert.equal(store.peek(), null);
  assert.equal(await isPaired(d), false);
});

// ── network failures must report, never reject ──────────────────────
// pairThisBrowser/resolveApproval both promise an {ok:false,error,code}
// envelope; a rejected fetch (offline, daemon restart mid-request) must
// never propagate past this module as an uncaught exception, or a caller
// that only awaits the promise (a click handler, say) is left with nothing.

test('a rejected fetch during /devices/pair reports PAIR_FAILED, not a thrown exception', async () => {
  const rejecting = async () => { throw new Error('network down'); };
  const { pairThisBrowser } = await freshPairing();
  const out = await pairThisBrowser(deps(rejecting));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PAIR_FAILED');
  assert.match(out.error, /network down/);
});

test('a rejected fetch during /gateway/exec/resolve reports RESOLVE_FAILED, not a thrown exception', async () => {
  const nonce = 'a'.repeat(64);
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => ({ status: 200, body: { ok: true, deviceId: b.deviceId, token: 'tok' } }),
  });
  const d = deps(f.fetch);
  const { pairThisBrowser, resolveApproval } = await freshPairing();
  await pairThisBrowser(d); // establishes `held` so resolveApproval goes straight to the resolve call

  const rejectingResolve = async (url, opts) => {
    if (String(url).includes('/gateway/exec/resolve')) throw new Error('network down');
    return f.fetch(url, opts);
  };
  const out = await resolveApproval('ap_1', 'approve', { ...d, fetch: rejectingResolve });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RESOLVE_FAILED');
  assert.match(out.error, /network down/);
});
