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

import crypto from 'node:crypto';
import {
  PairingStore,
  deviceIdFromPublicKey,
  verifyConnect,
  parsePayload,
} from './device_auth.mjs';
import { redactSecrets } from '../mas/redact.mjs';

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
export function createGateway({ configDir, challengeRegistry, nowFn = Date.now, heartbeatMs = 0 } = {}) {
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

  // ── exec-approval producer ───────────────────────────────────────
  // A trusted in-process caller (the daemon's POST /exec/request, which
  // sits behind the daemon auth-token gate) calls requestApproval(); that
  // broadcasts `exec.approval.requested` to every subscribed device and
  // returns a Promise that settles when a device POSTs
  // /gateway/exec/resolve (or on timeout). This is the remote
  // human-in-the-loop gate for sensitive tool calls.
  const approvals = new Map(); // id -> { detail, resolveFn, timer, createdAt }
  const MAX_APPROVALS = 256;
  const APPROVAL_TTL_MS = 5 * 60 * 1000;

  // What the device is shown about a pending approval. Args may carry
  // secrets (e.g. a bash command with a token), so the summary is redacted
  // and capped before it leaves the process. `tool` and `agentId` are both
  // identifiers, not free text, so a 100-char bound is generous but still
  // keeps a caller-controlled value from riding this view out unbounded.
  function approvalView(detail = {}) {
    const summary = redactSecrets(String(detail.summary ?? detail.args ?? '')).slice(0, 500);
    return {
      tool: String(detail.tool || '').slice(0, 100),
      agentId: String(detail.agentId || '').slice(0, 100),
      summary,
    };
  }

  function requestApproval(detail = {}, { timeoutMs = APPROVAL_TTL_MS } = {}) {
    // Bound the table — deny-and-evict the oldest pending if we're full so
    // an approval flood can't grow memory without limit.
    if (approvals.size >= MAX_APPROVALS) {
      const oldest = approvals.keys().next().value;
      if (oldest !== undefined) resolveApproval(oldest, false, 'system:capacity');
    }
    const id = 'ap_' + crypto.randomBytes(9).toString('hex');
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    // Clamp both ends: a caller can't pin an HTTP socket + entry for an
    // arbitrary (e.g. multi-day) duration, nor poll faster than 1s.
    const ttl = Math.min(APPROVAL_TTL_MS, Math.max(1000, timeoutMs || APPROVAL_TTL_MS));
    const timer = setTimeout(() => {
      if (approvals.has(id)) {
        approvals.delete(id);
        resolveFn({ id, approved: false, reason: 'timeout' });
        broadcast('exec.approval.resolved', { id, approved: false, reason: 'timeout' });
      }
    }, ttl);
    if (typeof timer.unref === 'function') timer.unref();
    approvals.set(id, { detail, resolveFn, timer, createdAt: nowFn() });
    broadcast('exec.approval.requested', { id, ...approvalView(detail) });
    return { id, promise };
  }

  // Trust model: every APPROVED device is uniformly trusted — any of them
  // may resolve any pending approval and list pending ids. There is no
  // per-device scoping by design (a paired device is an operator surface).
  // Approval ids are unguessable (crypto.randomBytes), so only an
  // already-trusted, authenticated device can act. If you pair a
  // lower-trust device, revoke it (`lazyclaw nodes revoke`) rather than
  // relying on approval scoping.
  function resolveApproval(id, decision, by = '') {
    const a = approvals.get(id);
    if (!a) return { ok: false, reason: 'unknown or already resolved' };
    clearTimeout(a.timer);
    approvals.delete(id);
    const approved = decision === true || decision === 'approve' || decision === 'allow';
    a.resolveFn({ id, approved, by, reason: approved ? 'approved' : 'denied' });
    broadcast('exec.approval.resolved', { id, approved, by });
    return { ok: true, id, approved };
  }

  function pendingApprovals() {
    return [...approvals.entries()].map(([id, a]) => ({ id, createdAt: a.createdAt, ...approvalView(a.detail) }));
  }

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
    const st = store();
    // Inject nowFn so an EXPIRED token (device TTL) is rejected across every
    // authenticated route, not just freshly after issue.
    if (!st.verifyToken(deviceId, token, nowFn())) return null;
    const info = st.deviceInfo(deviceId);
    return { deviceId, role: info?.role || '', scopes: Array.isArray(info?.scopes) ? info.scopes : [] };
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
        // role + scopes come from the SIGNATURE-VERIFIED payload (tamper-
        // evident), not the unsigned body fields, so a client can't forge its
        // own capabilities. parsePayload is safe here — verifyConnect passed.
        let role = '';
        let scopes = [];
        try {
          const parsed = parsePayload(payload);
          if (parsed) {
            role = String(parsed.role || '');
            scopes = typeof parsed.scopes === 'string' && parsed.scopes
              ? parsed.scopes.split(',').filter(Boolean)
              : (Array.isArray(parsed.scopes) ? parsed.scopes : []);
          }
        } catch { /* fall back to no capability — default device */ }
        try {
          receipt = st.requestPairing({ deviceId, platform, label, role, scopes });
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

    // ── exec approval: device resolves a pending request ─────────
    if (m === 'POST' && p === '/gateway/exec/resolve') {
      const ident = authDevice(req);
      if (!ident) return writeJson(res, 401, { ok: false, reason: 'invalid device token' });
      // Capability gate: a read-only device may observe (whoami/events/pending)
      // but MUST NOT resolve an exec approval (the one mutating gateway action).
      // Backward-compatible: only an EXPLICITLY read-only role is denied; legacy
      // devices (role '') and approvers keep the prior behaviour.
      if (ident.role === 'read-only') {
        return writeJson(res, 403, { ok: false, reason: 'insufficient scope: a read-only device cannot resolve exec approvals' });
      }
      const body = await readJsonBody(req, readBody);
      if (body && body.__tooLarge) return writeJson(res, 413, { ok: false, reason: 'request body too large' });
      if (!body || !body.id) return writeJson(res, 400, { ok: false, reason: 'id and decision are required' });
      const r = resolveApproval(body.id, body.decision, ident.deviceId);
      return writeJson(res, r.ok ? 200 : 404, r);
    }

    // ── exec approval: device lists what's awaiting a decision ───
    if (m === 'GET' && p === '/gateway/exec/pending') {
      const ident = authDevice(req);
      if (!ident) return writeJson(res, 401, { ok: false, reason: 'invalid device token' });
      return writeJson(res, 200, { pending: pendingApprovals() });
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

  // Optional keep-alive: periodic `tick` event so SSE proxies don't idle
  // out the stream and subscribers can prove the channel is live. Opt-in
  // (heartbeatMs>0) and unref'd so it never holds the process open or
  // leaks in unit tests that don't ask for it.
  let heartbeat = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => { broadcast('tick', { ts: nowFn() }); }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }
  function close() { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } }

  return { handle, broadcast, sseClients, requestApproval, resolveApproval, pendingApprovals, close };
}
