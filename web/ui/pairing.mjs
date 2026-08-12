// web/ui/pairing.mjs — the dashboard's side of device pairing.
//
// Three calls, in this order, and the order is load-bearing:
//   1. POST /devices/pair          — bearer-gated; approves the FIRST device
//                                    on loopback, otherwise records intent.
//   2. POST /gateway/connect/challenge  — a single-use nonce.
//   3. POST /gateway/connect       — the signed proof; only an APPROVED
//                                    device gets a token back.
// Step 3 is what actually proves possession of the private key, which is why
// step 1 can safely take an unsigned public key.
//
// The device token is deliberately NOT persisted. It lives in the module
// variable below and is re-minted from the non-extractable key whenever it is
// missing or rejected — so there is no long-lived credential at rest for an
// XSS to lift, and a revoked device simply stops being able to mint one.
import { getOrCreateIdentity, sign, forgetIdentity, IdentityError } from './device_identity.mjs';

const CLIENT_ID = 'pompos-dashboard';
const CLIENT_MODE = 'dashboard';
const PLATFORM = 'browser';
const DEVICE_FAMILY = 'dashboard';
// buildSignPayload's version tag and separator (gateway/device_auth.mjs). If
// the server ever bumps PAYLOAD_VERSION, tests/f-pairing-client.test.mjs fails
// against the real verifyConnect — which is the point of testing it that way.
const PAYLOAD_VERSION = 'v3';
const FIELD_SEP = '|';

// In-memory only. { deviceId, token } once the handshake has run in this page.
let held = null;

function label() {
  try { return `dashboard @ ${location.host}`; } catch { return 'dashboard'; }
}

// /gateway/* is routed BEFORE the daemon's bearer gate (daemon.mjs) and its
// Authorization header carries the DEVICE token, not the dashboard token — so
// these calls must NOT go through web/ui/api.mjs's withAuth().
function resolveDeps(deps = {}) {
  return {
    fetch: deps.fetch || globalThis.fetch.bind(globalThis),
    // A caller that OWNS the 'subtle' key (even set to undefined, to assert
    // "this environment has none") must not be overridden by the real
    // global — mirrors device_identity.mjs's own resolveDeps for the same
    // reason: Node itself exposes globalThis.crypto.subtle, so falling back
    // on `!== undefined` alone would silently swallow that assertion.
    subtle: 'subtle' in deps ? deps.subtle : globalThis.crypto?.subtle,
    store: deps.store,
  };
}

function idDeps(d) {
  return { subtle: d.subtle, ...(d.store ? { store: d.store } : {}) };
}

async function postJson(d, path, body, headers = {}) {
  let r;
  try {
    r = await d.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A rejected fetch (offline, daemon restart mid-request) must not throw
    // past this module — pairThisBrowser/resolveApproval each promise an
    // {ok:false,...} envelope and may never reject. Status 0 is a sentinel
    // every call site's existing `status !== 200`/`status === xxx` branches
    // already treat as "not the success case"; networkFailure() below reads
    // `networkError` to report the real reason instead of a generic HTTP 0.
    return { status: 0, body: {}, networkError: err && err.message ? err.message : String(err) };
  }
  let parsed = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed || {} };
}

// A postJson() result whose fetch itself failed. Never let a network blip
// surface as anything but this envelope shape.
function networkFailure(r, code) {
  return { ok: false, code, error: `the gateway could not be reached: ${r.networkError}` };
}

// Mirrors buildSignPayload in gateway/device_auth.mjs: 11 `|`-joined fields,
// scopes canonicalised (sorted, comma-joined) and each field's own separators
// escaped so a value cannot smuggle extra logical fields. Verified against the
// real verifyConnect in tests/f-pairing-client.test.mjs.
function buildPayload({ deviceId, signedAtMs, nonce }) {
  const safe = (v) => String(v ?? '').split(FIELD_SEP).join('%7C');
  return [
    PAYLOAD_VERSION, safe(deviceId), safe(CLIENT_ID), safe(CLIENT_MODE),
    safe(''), safe(''), safe(signedAtMs), safe(''), safe(nonce),
    safe(PLATFORM), safe(DEVICE_FAMILY),
  ].join(FIELD_SEP);
}

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function identityFailure(err) {
  if (err instanceof IdentityError) return { ok: false, error: err.message, code: err.code };
  return { ok: false, error: err && err.message ? err.message : String(err), code: 'PAIR_FAILED' };
}

// The handshake, assuming the device is already approved. Returns the token or
// a failure — never a partial success.
async function mintToken(d, identity) {
  const ch = await postJson(d, '/gateway/connect/challenge', {});
  if (ch.networkError) return networkFailure(ch, 'PAIR_FAILED');
  const nonce = ch.body && typeof ch.body.nonce === 'string' ? ch.body.nonce : '';
  if (!nonce) return { ok: false, error: 'the gateway issued no challenge nonce', code: 'PAIR_FAILED' };

  const payload = buildPayload({ deviceId: identity.deviceId, signedAtMs: Date.now(), nonce });
  let signature;
  try {
    signature = bytesToBase64(await sign(new TextEncoder().encode(payload), idDeps(d)));
  } catch (err) { return identityFailure(err); }

  const conn = await postJson(d, '/gateway/connect', {
    payload, signature, publicKey: identity.publicKeyDerBase64, nonce,
    deviceId: identity.deviceId, platform: PLATFORM, label: label(),
  });
  if (conn.networkError) return networkFailure(conn, 'PAIR_FAILED');
  if (conn.status === 200 && conn.body.token) {
    held = { deviceId: identity.deviceId, token: conn.body.token };
    return { ok: true, deviceId: identity.deviceId };
  }
  if (conn.status === 403 && conn.body.status === 'pending') {
    return {
      ok: false, code: 'PENDING_APPROVAL', deviceId: identity.deviceId, requestId: conn.body.requestId,
      // The id is in hand — print it, the way pairThisBrowser already does,
      // rather than leaving the operator to guess what `<requestId>` means.
      error: `this browser is waiting to be approved — run \`pompos nodes approve ${conn.body.requestId || ''}\` in a terminal`,
    };
  }
  return { ok: false, error: conn.body.reason || `the gateway refused the handshake (HTTP ${conn.status})`, code: 'PAIR_FAILED' };
}

/**
 * Make this browser a paired device: request pairing, then run the handshake.
 * @param {object} [deps]
 * @returns {Promise<{ok: true, deviceId: string} | {ok: false, error: string, code: string, deviceId?: string, requestId?: string, fingerprint?: string}>}
 */
export async function pairThisBrowser(deps) {
  const d = resolveDeps(deps);
  let identity;
  try { identity = await getOrCreateIdentity(idDeps(d)); }
  catch (err) { return identityFailure(err); }

  const pair = await postJson(d, '/devices/pair', {
    publicKey: identity.publicKeyDerBase64, platform: PLATFORM, label: label(),
  });
  if (pair.networkError) return networkFailure(pair, 'PAIR_FAILED');
  if (pair.status === 202 && pair.body.status === 'pending') {
    return {
      ok: false, code: 'PENDING_APPROVAL', deviceId: pair.body.deviceId, requestId: pair.body.requestId,
      fingerprint: pair.body.fingerprint,
      error: `this browser is waiting to be approved (${pair.body.fingerprint || pair.body.deviceId}) — run \`pompos nodes approve ${pair.body.requestId || ''}\` in a terminal`,
    };
  }
  if (pair.status !== 200) {
    return { ok: false, error: pair.body.error || `pairing was refused (HTTP ${pair.status})`, code: pair.body.code || 'PAIR_FAILED' };
  }
  return mintToken(d, identity);
}

/** Whether this page currently holds a device token. */
export async function isPaired(deps) {
  return !!(held && held.token);
}

/** Forget this browser's key and token. The server record is untouched. */
export async function unpairThisBrowser(deps) {
  const d = resolveDeps(deps);
  held = null;
  await forgetIdentity(idDeps(d));
}

// A failed pairThisBrowser() call reports its own precise cause (e.g.
// NO_WEBCRYPTO, NO_ED25519, PAIR_FAILED); only PENDING_APPROVAL is folded
// into NOT_PAIRED here, since "waiting for an operator to approve" and "not
// paired at all" both mean resolveApproval cannot proceed. Every other code
// must survive unchanged: Task 4's UI offers a "Pair this browser" retry
// specifically on NOT_PAIRED, and that retry can never succeed for e.g.
// NO_WEBCRYPTO (no secure-origin WebCrypto at all) — collapsing that into
// NOT_PAIRED would dangle the operator on a button that cannot work.
function pairFailureCode(paired) {
  return paired.code === 'PENDING_APPROVAL' ? 'NOT_PAIRED' : paired.code;
}

function resolveFailure(status, body) {
  if (status === 403) {
    return { ok: false, code: 'READ_ONLY', error: body.reason || 'this device is read-only and cannot resolve approvals' };
  }
  if (status === 404) {
    return { ok: false, code: 'APPROVAL_GONE', error: 'that approval is already resolved or has expired' };
  }
  return { ok: false, code: 'RESOLVE_FAILED', error: body.reason || `the gateway refused the decision (HTTP ${status})` };
}

/**
 * Answer a pending exec approval as this paired device.
 * @param {string} id
 * @param {'approve'|'deny'} decision
 * @param {object} [deps]
 * @returns {Promise<{ok: true, id: string, approved: boolean} | {ok: false, error: string, code: string}>}
 */
export async function resolveApproval(id, decision, deps) {
  const d = resolveDeps(deps);
  if (!held) {
    const paired = await pairThisBrowser(deps);
    // A failed pair is the answer. Never fall through to a resolve that
    // cannot be authenticated — reporting anything but this failure would
    // tell the operator an agent was unblocked when it is still waiting.
    if (!paired.ok) return { ok: false, error: paired.error, code: pairFailureCode(paired) };
  }
  const send = () => postJson(d, '/gateway/exec/resolve', { id, decision }, {
    Authorization: `Bearer ${held.token}`, 'x-device-id': held.deviceId,
  });

  let r = await send();
  if (r.networkError) return networkFailure(r, 'RESOLVE_FAILED');
  if (r.status === 401) {
    // The token expired or was rotated. Re-mint from the key we still hold and
    // try exactly once more; a second 401 means this device is no longer
    // trusted (revoked), which is NOT_PAIRED from the operator's side.
    held = null;
    const again = await pairThisBrowser(deps);
    if (!again.ok) return { ok: false, error: again.error, code: pairFailureCode(again) };
    r = await send();
    if (r.networkError) return networkFailure(r, 'RESOLVE_FAILED');
    if (r.status === 401) {
      // NOT the CLI: `pompos nodes` approves a device pairing REQUEST, not an
      // exec approval — the only thing that can ever resolve one of those is
      // a paired device (this browser, once it re-pairs).
      return { ok: false, code: 'NOT_PAIRED', error: 'this browser is no longer a paired device — pair it again to mint a new device token' };
    }
  }
  if (r.status === 200 && r.body.ok) return { ok: true, id: r.body.id, approved: !!r.body.approved };
  return resolveFailure(r.status, r.body);
}
