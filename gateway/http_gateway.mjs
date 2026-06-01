// HTTP/SSE realisation of the device gateway — Phase 27.
//
// The OpenClaw "gateway" is a long-lived process companion nodes connect
// to and authenticate against. lazyclaw realises that over the EXISTING
// HTTP daemon (no `ws` dependency, no hand-rolled RFC6455 framing): the
// device-auth handshake is two POSTs, authenticated routes carry the
// device's bearer token, and server-pushed events ride an SSE stream.
// The security model is unchanged from gateway/device_auth.mjs:
//
//   POST /gateway/connect/challenge {deviceId?}        -> { nonce, ts }
//     Mint a single-use, time-boxed challenge (ChallengeRegistry).
//
//   POST /gateway/connect {payload, signature, publicKey, nonce, ...}
//     verifyConnect (Ed25519 sig + identity-binding + nonce + freshness),
//     then ChallengeRegistry.consume (single-use / anti-replay). On
//     success: an APPROVED device gets its rotated bearer token; an
//     unapproved device gets a 403 `pending` receipt and a pairing
//     request is recorded for the operator to `lazyclaw nodes approve`.
//
//   GET  /gateway/whoami        (Authorization: Bearer <deviceToken>,
//                                x-device-id: <deviceId>)  -> { deviceId }
//   GET  /gateway/events        (same auth)               -> text/event-stream
//     Authenticated push channel. broadcast() fans an event to every live
//     subscriber. Event producers (e.g. remote tool-call approval) are a
//     later pass; the transport + auth are here now.
//
// These routes are mounted by daemon.mjs OUTSIDE the daemon's shared
// `auth-token` gate: device-auth is their own gate, and the only
// unauthenticated route (challenge) returns nothing but a random nonce.

import {
  PairingStore,
  deviceIdFromPublicKey,
  verifyConnect,
} from './device_auth.mjs';

// Matches the daemon's readTextBody cap (1 MiB) so the Content-Length
// pre-check and the stream reader agree on the limit.
const GATEWAY_MAX_BODY = 1_048_576;

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

/**
 * Build a gateway instance. `challengeRegistry` is created ONCE per daemon
 * process and shared across requests — a challenge minted by one request
 * is consumed by a later one, so it must outlive a single call. `nowFn`
 * is injected for deterministic tests.
 */
export function createGateway({ configDir, challengeRegistry, nowFn = Date.now } = {}) {
  if (!challengeRegistry) throw new Error('createGateway requires a challengeRegistry');
  // Each entry: { res, deviceId }. Bounded globally and per-device so an
  // authenticated device can't exhaust sockets/fds with open streams.
  const sseClients = new Set();
  const MAX_SSE_GLOBAL = 256;
  const MAX_SSE_PER_DEVICE = 8;
  const deviceStreamCount = (deviceId) => {
    let n = 0;
    for (const c of sseClients) if (c.deviceId === deviceId) n++;
    return n;
  };

  // A fresh PairingStore per op re-reads the on-disk file, so an `approve`
  // performed by the CLI in another process is visible to the daemon
  // without a restart.
  const store = () => new PairingStore(configDir);

  async function readJsonBody(req, readBody) {
    let raw;
    try { raw = await readBody(req); }
    catch { return { __tooLarge: true }; }                   // body exceeded the cap
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return null; }   // null => malformed
  }

  function authDevice(req) {
    const token = bearerToken(req);
    const deviceId = String(req.headers?.['x-device-id'] || '').trim();
    if (!token || !deviceId) return null;
    if (!store().verifyToken(deviceId, token)) return null;
    return { deviceId };
  }

  async function handle(req, res, { readBody }) {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    // ── challenge ────────────────────────────────────────────────
    if (m === 'POST' && p === '/gateway/connect/challenge') {
      const challenge = challengeRegistry.create();
      return writeJson(res, 200, challenge);
    }

    // ── connect ──────────────────────────────────────────────────
    if (m === 'POST' && p === '/gateway/connect') {
      // Reject an oversized body up front via Content-Length so we answer
      // 413 cleanly instead of the body reader destroying the socket
      // (ECONNRESET) once the cap is hit mid-stream.
      const clen = Number(req.headers?.['content-length'] || 0);
      if (Number.isFinite(clen) && clen > GATEWAY_MAX_BODY) {
        return writeJson(res, 413, { ok: false, reason: 'request body too large' });
      }
      const body = await readJsonBody(req, readBody);
      if (body && body.__tooLarge) return writeJson(res, 413, { ok: false, reason: 'request body too large' });
      if (!body) return writeJson(res, 400, { ok: false, reason: 'malformed body' });
      const { payload, signature, publicKey, nonce, platform = '', label = '' } = body;
      if (!payload || !signature || !publicKey || !nonce) {
        return writeJson(res, 400, { ok: false, reason: 'payload, signature, publicKey and nonce are required' });
      }
      let deviceId;
      try {
        deviceId = deviceIdFromPublicKey(publicKey);
      } catch {
        // Generic — don't reflect node:crypto parse internals.
        return writeJson(res, 400, { ok: false, reason: 'invalid public key' });
      }
      const now = nowFn();
      const verdict = verifyConnect({ payload, signature, publicKey, challenge: { nonce }, nowMs: now });
      if (!verdict.ok) {
        return writeJson(res, 401, { ok: false, reason: verdict.reason });
      }
      // Single-use / anti-replay: only AFTER a valid signature, and only
      // once. A replayed (payload,signature) re-presents the same nonce,
      // which consume() has already retired.
      if (!challengeRegistry.consume(nonce, now)) {
        return writeJson(res, 401, { ok: false, reason: 'challenge expired or already used' });
      }
      const st = store();
      if (st.isApproved(deviceId)) {
        return writeJson(res, 200, { ok: true, deviceId, token: st.tokenFor(deviceId) });
      }
      // Not approved — record intent once (don't pile up duplicates) and
      // tell the device to wait for the operator's approval.
      const existing = st.pendingForDevice(deviceId);
      let receipt;
      if (existing) {
        receipt = { requestId: existing.requestId };
      } else {
        try {
          receipt = st.requestPairing({ deviceId, platform, label });
        } catch (err) {
          // Pending-requests ceiling hit — shed load rather than 500.
          if (err && err.code === 'PAIRING_CAP') {
            return writeJson(res, 429, { ok: false, reason: 'too many pending pairing requests; try later' });
          }
          throw err;
        }
      }
      return writeJson(res, 403, { ok: false, status: 'pending', deviceId, requestId: receipt.requestId });
    }

    // ── whoami (token-authenticated) ─────────────────────────────
    if (m === 'GET' && p === '/gateway/whoami') {
      const ident = authDevice(req);
      if (!ident) return writeJson(res, 401, { ok: false, reason: 'invalid device token' });
      return writeJson(res, 200, { ok: true, deviceId: ident.deviceId });
    }

    // ── events (SSE, token-authenticated) ────────────────────────
    if (m === 'GET' && p === '/gateway/events') {
      const ident = authDevice(req);
      if (!ident) return writeJson(res, 401, { ok: false, reason: 'invalid device token' });
      if (sseClients.size >= MAX_SSE_GLOBAL) {
        return writeJson(res, 429, { ok: false, reason: 'event-stream capacity reached' });
      }
      if (deviceStreamCount(ident.deviceId) >= MAX_SSE_PER_DEVICE) {
        return writeJson(res, 429, { ok: false, reason: 'too many event streams for this device' });
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ deviceId: ident.deviceId })}\n\n`);
      const entry = { res, deviceId: ident.deviceId };
      sseClients.add(entry);
      const onClose = () => { sseClients.delete(entry); };
      if (typeof req.once === 'function') req.once('close', onClose);
      if (typeof res.once === 'function') res.once('close', onClose);
      return; // connection stays open
    }

    return writeJson(res, 404, { ok: false, reason: 'no such gateway route' });
  }

  // Fan an event out to every live SSE subscriber. Best-effort: a dead
  // socket is dropped, never throws into the caller.
  function broadcast(eventName, data) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const entry of sseClients) {
      try { entry.res.write(frame); } catch { sseClients.delete(entry); }
    }
    return sseClients.size;
  }

  return { handle, broadcast, sseClients };
}
