// HTTP/SSE realisation of the device gateway — Phase 27.
//
// The OpenClaw "gateway" is a long-lived process companion nodes connect
// to and authenticate against. pompos realises that over the EXISTING
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
//     request is recorded for the operator to `pompos nodes approve`.
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
// The daemon's in-process event bus, which the dashboard's SSE route subscribes
// to. createGateway is constructed by daemon.mjs, so this reaches that bus; in a
// one-shot process with no subscriber emit() is a harmless no-op that buffers and
// drops (see mas/events.mjs's header).
import { emit as emitEvent } from '../mas/events.mjs';

// Gateway events the dashboard is allowed to see.
//
// broadcast() fans out to device-authenticated SSE clients; the daemon's bus
// feeds every open dashboard. Those are different audiences, so the crossing is
// an explicit allowlist rather than a blanket mirror — a future gateway event has
// to opt in deliberately instead of landing on every dashboard by default. It
// also keeps the `tick` heartbeat, which is pure keep-alive noise, off the bus.
const DASHBOARD_MIRRORED = new Set(['exec.approval.requested', 'exec.approval.resolved']);

// Device roles allowed to resolve an exec approval — an ALLOWLIST, not a
// denylist, because the role string is chosen by the device itself (it rides
// the signed connect payload). Denying only an explicit 'read-only' meant any
// near-miss ('Read-Only', 'read_only', 'read-only ') or invented role ('admin')
// was waved through with FULL approver authority while `pompos nodes pending`
// and the Devices panel showed the operator a harmless-looking observer.
//
// These four are the whole device-role vocabulary this codebase issues: '' is a
// legacy record and the bootstrap route's placeholder, 'owner' and 'node' are
// what a companion node signs (see the device-auth and gateway specs), and
// 'approver' is the explicit approver. 'read-only' is the one observer role and
// is deliberately absent. Anything else — a typo, an invented role, or a
// near-miss stored before the connect route normalized roles — is refused
// rather than treated as full authority.
const RESOLVE_ROLES = new Set(['', 'owner', 'node', 'approver']);

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
  // lower-trust device, revoke it (`pompos nodes revoke`) rather than
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
      const { payload, signature, nonce, platform = '', label = '' } = body;
      // Guarded the same way daemon/routes/devices_pair.mjs guards the
      // identical field: a non-string is coerced to '' here so it falls
      // into the very next check as a plain "required" 400, rather than
      // reaching Buffer.from() below with (e.g.) a number or object and
      // throwing a raw TypeError that escapes uncaught to daemon.mjs's
      // outer catch as a 500 reflecting Node's internal error message.
      const publicKeyIn = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
      if (!payload || !signature || !publicKeyIn || !nonce) {
        return writeJson(res, 400, { ok: false, reason: 'payload, signature, publicKey and nonce are required' });
      }
      // publicKey arrives over JSON as a base64 DER SPKI string (a browser's
      // exportKey('spki') output, base64-encoded for transport — see
      // web/ui/device_identity.mjs) or as a PEM string from other callers.
      // Mirrors daemon/routes/devices_pair.mjs's own normalization: without
      // it, deviceIdFromPublicKey/verifyConnect below try to parse the raw
      // base64 text as PEM and fail every real (non-test-mocked) caller.
      const publicKey = /-----BEGIN/.test(publicKeyIn) ? publicKeyIn : Buffer.from(publicKeyIn, 'base64');
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
      // role + scopes come from the SIGNATURE-VERIFIED payload (tamper-
      // evident), not the unsigned body fields, so a client can't forge its
      // own capabilities. parsePayload is safe here — verifyConnect passed.
      // Computed unconditionally (not just for a brand-new request) so a
      // request that was pre-created WITHOUT a signed payload (e.g. the
      // daemon's POST /devices/pair bootstrap route, which cannot see one
      // and always records role:'') gets re-stamped with the device's real
      // capability the moment it completes an actual signed connect —
      // otherwise that capability is silently discarded forever.
      //
      // NORMALIZED here, at the single ingest point: the role is persisted
      // verbatim (PairingStore.requestPairing) and compared verbatim by the
      // exec-resolve gate, and the device picks its own string — so without
      // this, 'Read-Only' / 'read-only ' / 'READ-ONLY' each showed the operator
      // a harmless observer in `pompos nodes pending` while sailing past that
      // gate with full approver authority. Every writer below takes the role
      // from this one variable, and nothing outside gateway/ calls
      // requestPairing, so normalizing once here covers the whole surface.
      let role = '';
      let scopes = [];
      try {
        const parsed = parsePayload(payload);
        if (parsed) {
          role = String(parsed.role || '').trim().toLowerCase();
          const rawScopes = typeof parsed.scopes === 'string' && parsed.scopes
            ? parsed.scopes.split(',')
            : (Array.isArray(parsed.scopes) ? parsed.scopes : []);
          scopes = rawScopes.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
        }
      } catch { /* fall back to no capability — default device */ }

      // Not approved — record intent once (don't pile up duplicates) and
      // tell the device to wait for the operator's approval.
      const existing = st.pendingForDevice(deviceId);
      let receipt;
      if (existing) {
        // Fill-in-once, NEVER widen: only replace an EMPTY stored role/scopes
        // with the signed payload's. Overwriting an already-set role would
        // open a privilege-escalation window — the device holds the private
        // key, so it could reconnect with role:'' AFTER the operator reviews
        // "read-only" in `pompos nodes pending` but BEFORE they approve, and
        // silently downgrade the stored role to '' (which the exec-resolve
        // gate treats as full authority, since it denies only an explicit
        // "read-only"). This also blocks widening to some OTHER non-empty
        // role the operator never saw. The bootstrap route's role:'' placeholder
        // still gets filled from the first signed connect, which is all
        // finding 2 required.
        const nextRole = existing.role ? existing.role : role;
        const nextScopes = Array.isArray(existing.scopes) && existing.scopes.length ? existing.scopes : scopes;
        st.restampPending(existing.requestId, { role: nextRole, scopes: nextScopes });
        receipt = { requestId: existing.requestId };
      } else {
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
      // Capability gate, fail-CLOSED (RESOLVE_ROLES above): a read-only device
      // may observe (whoami/events/pending) but MUST NOT resolve an exec
      // approval — the one mutating gateway action. Only a role this code
      // actually recognises passes; an unrecognised one is refused instead of
      // being treated as full authority. Backward-compatible for the records
      // that exist: legacy/bootstrap ('') and 'approver' both still pass.
      if (!RESOLVE_ROLES.has(ident.role)) {
        return writeJson(res, 403, {
          ok: false,
          reason: ident.role === 'read-only'
            ? 'insufficient scope: a read-only device cannot resolve exec approvals'
            // Deliberately does not echo the role back: it is device-chosen text.
            : 'insufficient scope: this device role cannot resolve exec approvals',
        });
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
    if (DASHBOARD_MIRRORED.has(eventName)) {
      // The same payload GET /approvals already serves the dashboard, so this
      // exposes nothing new — it only lets the sidebar badge move while the user
      // is on another panel. emit() never throws into its caller by design.
      emitEvent(eventName, data ?? {});
    }
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
