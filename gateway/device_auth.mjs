// WS gateway device-authentication state machine — PURE logic, no sockets.
//
// Transport is decided elsewhere: the daemon stays localhost-bound and any
// remote exposure is the user's own tunnel (Tailscale / Cloudflare) plus TLS
// and an auth-token. This module owns only the device-identity, challenge,
// canonical-payload, signature-verification and pairing-token state machine.
//
// Everything here is unit-testable with node:crypto alone:
//   - Ed25519 keys via crypto.generateKeyPairSync('ed25519')
//   - Ed25519 sign / verify with the `null` algorithm (the only valid choice
//     for Ed25519 in node:crypto — the digest is built into the scheme)
//
// Wall-clock is never read inside the verification path: callers inject
// `nowMs`. That keeps verifyConnect deterministic and lets tests drive the
// skew window without faking timers.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const GATEWAY_DIRNAME = 'gateway';
const DEVICES_FILENAME = 'devices.json';

// Canonical sign-payload format tag. Bumping this string invalidates every
// signature produced by an older client, which is the intended migration
// lever — old payloads simply stop verifying.
const PAYLOAD_VERSION = 'v3';
const FIELD_SEP = '|';

export const DEFAULT_MAX_SKEW_MS = 120_000;

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function gatewayDir(configDir = defaultConfigDir()) {
  return path.join(configDir, GATEWAY_DIRNAME);
}

export function devicesPath(configDir = defaultConfigDir()) {
  return path.join(gatewayDir(configDir), DEVICES_FILENAME);
}

// Coerce any accepted public-key representation to its DER SPKI bytes.
// Accepts: a PEM string, a DER Buffer/Uint8Array, or a node:crypto
// KeyObject. The DER SPKI byte sequence is the canonical identity surface —
// fingerprinting it (rather than the PEM text) means whitespace / line-ending
// differences in a PEM never change a device id.
function toSpkiDer(publicKeyPemOrDer) {
  if (publicKeyPemOrDer == null) {
    throw new Error('public key is required');
  }
  // Already a KeyObject.
  if (typeof publicKeyPemOrDer === 'object'
      && typeof publicKeyPemOrDer.export === 'function'
      && publicKeyPemOrDer.type === 'public') {
    return publicKeyPemOrDer.export({ type: 'spki', format: 'der' });
  }
  // Raw DER bytes.
  if (Buffer.isBuffer(publicKeyPemOrDer) || publicKeyPemOrDer instanceof Uint8Array) {
    const der = Buffer.from(publicKeyPemOrDer);
    // Re-import + re-export so a non-SPKI DER blob is rejected loudly and the
    // bytes are normalised to canonical SPKI form.
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.export({ type: 'spki', format: 'der' });
  }
  // PEM string.
  if (typeof publicKeyPemOrDer === 'string') {
    const key = crypto.createPublicKey(publicKeyPemOrDer);
    return key.export({ type: 'spki', format: 'der' });
  }
  throw new Error('unsupported public key representation');
}

// Coerce to a KeyObject usable by crypto.verify.
function toPublicKeyObject(publicKey) {
  if (typeof publicKey === 'object'
      && typeof publicKey.export === 'function'
      && publicKey.type === 'public') {
    return publicKey;
  }
  if (Buffer.isBuffer(publicKey) || publicKey instanceof Uint8Array) {
    return crypto.createPublicKey({ key: Buffer.from(publicKey), format: 'der', type: 'spki' });
  }
  if (typeof publicKey === 'string') {
    return crypto.createPublicKey(publicKey);
  }
  throw new Error('unsupported public key representation');
}

/**
 * Stable device identity: `sha256:<hex>` of the DER SPKI public-key bytes.
 * Deterministic for a given key, independent of PEM vs DER input.
 *
 * @param {string|Buffer|Uint8Array|crypto.KeyObject} publicKeyPemOrDer
 * @returns {string}
 */
export function deviceIdFromPublicKey(publicKeyPemOrDer) {
  const der = toSpkiDer(publicKeyPemOrDer);
  const hex = crypto.createHash('sha256').update(der).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Mint a one-shot connection challenge. The nonce is 32 random bytes
 * (hex-encoded → 64 chars); `ts` is the current epoch-ms at mint time so a
 * caller can age out unredeemed challenges.
 *
 * @returns {{ nonce: string, ts: number }}
 */
export function createChallenge() {
  return {
    nonce: crypto.randomBytes(32).toString('hex'),
    ts: Date.now(),
  };
}

// ChallengeRegistry (the single-use anti-replay ledger) lives in its own module
// now — re-exported here so daemon.mjs and existing importers/tests are
// unchanged. createChallenge + DEFAULT_MAX_SKEW_MS stay above for verifyConnect.
export { ChallengeRegistry } from './challenge_registry.mjs';

// Canonicalise scopes to a single deterministic token so two clients that
// list the same scopes in a different order still produce an identical
// signed payload. Sorted + comma-joined.
function canonScopes(scopes) {
  if (scopes == null) return '';
  const arr = Array.isArray(scopes) ? scopes : [scopes];
  return arr.map((s) => String(s)).sort().join(',');
}

// Replace the field separator inside a value so a malicious field can't
// inject extra logical fields into the canonical string ("|" smuggling).
function safeField(value) {
  return String(value ?? '').split(FIELD_SEP).join('%7C');
}

/**
 * Build the canonical string a client signs and the gateway re-derives to
 * verify. Field order is fixed and version-tagged; scopes are order-normalised.
 *
 * Layout:
 *   v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes>|<signedAtMs>|<token>|<nonce>|<platform>|<deviceFamily>
 *
 * @param {{
 *   deviceId: string, clientId: string, clientMode: string, role: string,
 *   scopes: string[]|string, signedAtMs: number, token: string, nonce: string,
 *   platform: string, deviceFamily: string,
 * }} fields
 * @returns {string}
 */
export function buildSignPayload({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce,
  platform,
  deviceFamily,
} = {}) {
  const parts = [
    PAYLOAD_VERSION,
    safeField(deviceId),
    safeField(clientId),
    safeField(clientMode),
    safeField(role),
    safeField(canonScopes(scopes)),
    safeField(signedAtMs),
    safeField(token),
    safeField(nonce),
    safeField(platform),
    safeField(deviceFamily),
  ];
  return parts.join(FIELD_SEP);
}

// Pull the signedAtMs / nonce out of a canonical payload string. Positional —
// must stay in lock-step with buildSignPayload's field order. Returns null
// for a malformed / wrong-version payload so the caller can reject cleanly
// rather than throwing.
function parsePayload(payload) {
  if (typeof payload !== 'string') return null;
  const parts = payload.split(FIELD_SEP);
  if (parts.length !== 11) return null;
  if (parts[0] !== PAYLOAD_VERSION) return null;
  return {
    version: parts[0],
    deviceId: parts[1],
    clientId: parts[2],
    clientMode: parts[3],
    role: parts[4],
    scopes: parts[5],
    signedAtMs: Number(parts[6]),
    token: parts[7],
    nonce: parts[8],
    platform: parts[9],
    deviceFamily: parts[10],
  };
}

/**
 * Verify a connect attempt. Four independent gates, all of which must pass:
 *   1. Ed25519 signature over the exact payload bytes is valid for publicKey.
 *   2. The publicKey hashes to the deviceId the payload CLAIMS
 *      (identity binding — a valid signature alone only proves the holder of
 *      *some* key signed these bytes; without this gate an attacker could sign
 *      a payload claiming a victim's deviceId with their own key and pass).
 *   3. The payload's embedded nonce equals the live challenge's nonce
 *      (replay binding — a signature is useless against a different challenge).
 *   4. The payload's signedAtMs is within ±maxSkewMs of the injected nowMs
 *      (freshness — neither stale nor implausibly future).
 *
 * `nowMs` is injected, never read from the wall-clock here, so the function
 * is pure and deterministic.
 *
 * IMPORTANT (anti-replay): this function is intentionally pure — it does NOT
 * consume the challenge. Comparing the payload nonce to challenge.nonce only
 * binds the signature to THIS challenge; it does not stop the SAME
 * (payload,signature) pair from verifying twice. Callers MUST drive a
 * single-use ChallengeRegistry and call registry.consume(nonce, nowMs) exactly
 * once per accepted connect, treating a false return as a replay/expiry reject.
 *
 * @param {{
 *   payload: string, signature: string, publicKey: any,
 *   challenge: { nonce: string, ts?: number },
 *   maxSkewMs?: number, nowMs: number,
 * }} args
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyConnect({
  payload,
  signature,
  publicKey,
  challenge,
  maxSkewMs = DEFAULT_MAX_SKEW_MS,
  nowMs,
} = {}) {
  if (typeof payload !== 'string' || payload.length === 0) {
    return { ok: false, reason: 'missing payload' };
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: 'missing signature' };
  }
  if (!challenge || typeof challenge.nonce !== 'string' || challenge.nonce.length === 0) {
    return { ok: false, reason: 'missing challenge' };
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'missing nowMs' };
  }

  const parsed = parsePayload(payload);
  if (!parsed) {
    return { ok: false, reason: 'malformed payload' };
  }

  // Gate 1 — signature. Ed25519 verify uses the `null` algorithm. We do this
  // BEFORE trusting any field inside the payload, since only a valid signature
  // proves the payload bytes are authentic.
  let sigOk = false;
  let derivedDeviceId;
  try {
    const keyObj = toPublicKeyObject(publicKey);
    // Pin the scheme: crypto.verify(null, …) would otherwise silently
    // accept RSA / EC signatures too. Device identity is Ed25519-only.
    if (keyObj.asymmetricKeyType !== 'ed25519') {
      return { ok: false, reason: 'unsupported key type (ed25519 only)' };
    }
    const sigBytes = Buffer.from(signature, 'base64');
    sigOk = crypto.verify(null, Buffer.from(payload), keyObj, sigBytes);
    // Derive the canonical device id from the SAME key we just verified with,
    // so Gate 2 can bind it to the payload's claimed identity.
    derivedDeviceId = deviceIdFromPublicKey(keyObj);
  } catch {
    // Generic reason — don't reflect node:crypto internals to the caller.
    return { ok: false, reason: 'signature verification failed' };
  }
  if (!sigOk) {
    return { ok: false, reason: 'bad signature' };
  }

  // Gate 2 — identity binding. The deviceId the payload CLAIMS must be the one
  // derived from the public key that produced the signature. Without this, a
  // valid signature over a payload naming a VICTIM's deviceId (signed with the
  // ATTACKER's own key, presenting the ATTACKER's own pubkey) would pass.
  // Exact, constant-string compare — both sides are `sha256:<hex>`.
  if (parsed.deviceId !== derivedDeviceId) {
    return { ok: false, reason: 'device id mismatch' };
  }

  // Gate 3 — nonce binds the signature to THIS challenge (anti-replay).
  if (parsed.nonce !== challenge.nonce) {
    return { ok: false, reason: 'nonce mismatch' };
  }

  // Gate 4 — freshness. signedAtMs must sit within ±maxSkewMs of nowMs.
  if (!Number.isFinite(parsed.signedAtMs)) {
    return { ok: false, reason: 'missing signedAtMs' };
  }
  const skew = Math.abs(nowMs - parsed.signedAtMs);
  if (skew > maxSkewMs) {
    const dir = parsed.signedAtMs > nowMs ? 'future' : 'stale';
    return { ok: false, reason: `signature ${dir}: skew ${skew}ms exceeds ${maxSkewMs}ms` };
  }

  return { ok: true, reason: 'ok' };
}

function nowIso() {
  return new Date().toISOString();
}

function freshToken() {
  return crypto.randomBytes(32).toString('hex');
}

function freshRequestId() {
  return 'pr_' + crypto.randomBytes(12).toString('hex');
}

// devices.json holds plaintext bearer tokens, so it must be owner-only on
// disk. We set restrictive modes on create AND re-assert them with chmod after
// the rename, because the active umask can clear bits at mkdir/open time and a
// pre-existing file/dir keeps its old (possibly looser) mode otherwise.
const DEVICES_DIR_MODE = 0o700;
const DEVICES_FILE_MODE = 0o600;

// Bounds on the pending-requests table (an unauthenticated attacker minting
// fresh keypairs could otherwise grow it without limit).
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
const MAX_PENDING_REQUESTS = 1000;

// Thrown when the pending-requests ceiling is hit. The caller (gateway
// connect handler) maps this to a 429 rather than a 500.
export class PairingCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PairingCapError';
    this.code = 'PAIRING_CAP';
  }
}

function writeAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DEVICES_DIR_MODE });
  fs.chmodSync(dir, DEVICES_DIR_MODE);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: DEVICES_FILE_MODE });
  fs.chmodSync(tmp, DEVICES_FILE_MODE);
  fs.renameSync(tmp, filePath);
  // rename preserves the source mode, but re-assert in case the destination
  // pre-existed with a looser mode on some filesystems.
  fs.chmodSync(filePath, DEVICES_FILE_MODE);
}

/**
 * JSON-file-backed pairing + token store under <configDir>/gateway/devices.json.
 *
 * Security model:
 *   - A pairing REQUEST never yields a token. It only records intent in a
 *     `pending` state. The owner must explicitly approve() it.
 *   - approve() mints a fresh 32-byte token and ROTATES it on every call, so
 *     re-pairing a device always invalidates its previous token.
 *   - A device id that was never approved has no token (tokenFor → null,
 *     isApproved → false).
 *   - revoke() removes the approval and token.
 *
 * On-disk shape:
 *   {
 *     version: 1,
 *     requests: { <requestId>: { requestId, deviceId, platform, label, status, createdAt } },
 *     devices:  { <deviceId>:  { deviceId, platform, label, token, approvedAt } }
 *   }
 */
export class PairingStore {
  constructor(configDir = defaultConfigDir()) {
    this.configDir = configDir;
    this.path = devicesPath(configDir);
    this._data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        requests: parsed.requests && typeof parsed.requests === 'object' ? parsed.requests : {},
        devices: parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
      };
    } catch {
      // Missing or unreadable → empty store.
      return { version: 1, requests: {}, devices: {} };
    }
  }

  _persist() {
    writeAtomic(this.path, this._data);
  }

  // Drop pending requests older than the TTL. Approved/other-status records
  // are kept (they are the device roster, not the abuse surface). Mutates
  // _data in place; the caller persists.
  _prunePending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, r] of Object.entries(this._data.requests)) {
      if (r && r.status === 'pending') {
        const created = Date.parse(r.createdAt || '') || 0;
        if (created < cutoff) delete this._data.requests[id];
      }
    }
  }

  /**
   * Record a pairing request for a device. Returns a pending receipt.
   * NEVER returns a token — approval is a separate, explicit step.
   *
   * @param {{ deviceId: string, platform?: string, label?: string }} args
   * @returns {{ requestId: string, status: 'pending' }}
   */
  requestPairing({ deviceId, platform = '', label = '' } = {}) {
    if (!deviceId || typeof deviceId !== 'string') {
      throw new Error('requestPairing requires a deviceId');
    }
    // Bound the on-disk requests table: age out stale pending requests, then
    // refuse once a hard ceiling is hit. Without this, an attacker minting a
    // fresh keypair (hence a fresh deviceId) per connect could grow
    // devices.json without bound (each unapproved connect persists a row).
    this._prunePending();
    const pendingCount = Object.values(this._data.requests).filter((r) => r && r.status === 'pending').length;
    if (pendingCount >= MAX_PENDING_REQUESTS) {
      throw new PairingCapError(`too many pending pairing requests (cap ${MAX_PENDING_REQUESTS}); approve or wait for expiry`);
    }
    const requestId = freshRequestId();
    this._data.requests[requestId] = {
      requestId,
      deviceId,
      platform: String(platform || ''),
      label: String(label || ''),
      status: 'pending',
      createdAt: nowIso(),
    };
    this._persist();
    // Deliberately narrow return: pending receipt only, no token.
    return { requestId, status: 'pending' };
  }

  /**
   * Approve a pending request and mint a FRESH token for its device. This is
   * one-shot per request: a request can only move pending → approved exactly
   * once. Re-approving an already-approved (or otherwise non-pending) request
   * throws, so a stale/replayed approve cannot silently rotate a live token.
   *
   * To rotate a device's token, submit a NEW requestPairing() and approve
   * that fresh (pending) request.
   *
   * @param {string} requestId
   * @returns {{ deviceId: string, token: string }}
   */
  approve(requestId, { ttlMs, nowMs = Date.now() } = {}) {
    const req = this._data.requests[requestId];
    if (!req) {
      throw new Error(`unknown pairing request: ${requestId}`);
    }
    if (req.status !== 'pending') {
      throw new Error(`request not pending: ${requestId} (status=${req.status})`);
    }
    const token = freshToken();
    const dev = {
      deviceId: req.deviceId,
      platform: req.platform || '',
      label: req.label || '',
      token,
      approvedAt: nowIso(),
    };
    // Optional TTL: stamp an absolute expiry only when a positive ttlMs is
    // given. Omitting it keeps the legacy never-expires record.
    if (Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(nowMs)) {
      dev.expiresAt = nowMs + ttlMs;
    }
    this._data.devices[req.deviceId] = dev;
    req.status = 'approved';
    req.approvedAt = nowIso();
    this._persist();
    return { deviceId: req.deviceId, token, ...(dev.expiresAt ? { expiresAt: dev.expiresAt } : {}) };
  }

  /**
   * Whether a device has a live (non-revoked) token.
   * @param {string} deviceId
   * @returns {boolean}
   */
  isApproved(deviceId) {
    const dev = this._data.devices[deviceId];
    return !!(dev && typeof dev.token === 'string' && dev.token.length > 0);
  }

  /**
   * The live token for a device, or null when the device was never approved
   * or has been revoked.
   * @param {string} deviceId
   * @returns {string|null}
   */
  tokenFor(deviceId) {
    const dev = this._data.devices[deviceId];
    return dev && typeof dev.token === 'string' && dev.token.length > 0 ? dev.token : null;
  }

  /**
   * Constant-time check that `presentedToken` matches the live token for
   * `deviceId`. Uses crypto.timingSafeEqual so a remote attacker cannot recover
   * the token byte-by-byte from response timing.
   *
   * timingSafeEqual throws on length mismatch, so we short-circuit to false
   * when the lengths differ. The length of a bearer token is not itself a
   * secret, so leaking only "wrong length" via the short-circuit is acceptable
   * and unavoidable. Unknown device / missing token / non-string input all
   * return false without throwing.
   *
   * @param {string} deviceId
   * @param {string} presentedToken
   * @returns {boolean}
   */
  verifyToken(deviceId, presentedToken, nowMs) {
    const dev = this._data.devices[deviceId];
    const stored = dev && typeof dev.token === 'string' && dev.token.length > 0 ? dev.token : null;
    if (typeof stored !== 'string' || stored.length === 0) return false;
    if (typeof presentedToken !== 'string' || presentedToken.length === 0) return false;
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(presentedToken, 'utf8');
    if (a.length !== b.length) return false; // length mismatch — cannot timingSafeEqual
    // Constant-time compare FIRST, expiry AFTER — so response timing can't leak
    // "expired" vs "wrong token". TTL is only enforced when both the record has
    // an expiresAt AND the caller injects a nowMs (legacy callers/records skip).
    if (!crypto.timingSafeEqual(a, b)) return false;
    if (typeof dev.expiresAt === 'number' && Number.isFinite(nowMs) && nowMs >= dev.expiresAt) return false;
    return true;
  }

  /**
   * Revoke a device: drop its approval and token. Idempotent.
   * @param {string} deviceId
   * @returns {{ deviceId: string, revoked: boolean }}
   */
  revoke(deviceId) {
    const existed = !!this._data.devices[deviceId];
    delete this._data.devices[deviceId];
    this._persist();
    return { deviceId, revoked: existed };
  }

  /**
   * Re-issue a fresh token for an already-approved device WITHOUT a new pairing
   * handshake. The old token stops authenticating immediately; non-secret
   * metadata (platform/label/role/scopes) is preserved. A positive ttlMs stamps
   * a fresh expiresAt; omitting it clears any prior expiry (never-expires).
   * Throws when the device is unknown or was never approved.
   * @returns {{ deviceId: string, token: string, expiresAt?: number }}
   */
  rotate(deviceId, { ttlMs, nowMs = Date.now() } = {}) {
    const dev = this._data.devices[deviceId];
    if (!dev || typeof dev.token !== 'string' || dev.token.length === 0) {
      throw new Error(`cannot rotate: no approved device ${deviceId}`);
    }
    dev.token = freshToken();
    dev.rotatedAt = nowIso();
    if (Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(nowMs)) dev.expiresAt = nowMs + ttlMs;
    else delete dev.expiresAt;
    this._persist();
    return { deviceId, token: dev.token, ...(dev.expiresAt ? { expiresAt: dev.expiresAt } : {}) };
  }

  /**
   * Non-secret view of a device record (NEVER includes the token) — for the
   * gateway authz layer (role/scopes) and the `nodes` CLI. null when unknown.
   * @returns {{ deviceId, platform, label, role, scopes, expiresAt, approvedAt } | null}
   */
  deviceInfo(deviceId) {
    const dev = this._data.devices[deviceId];
    if (!dev) return null;
    return {
      deviceId: dev.deviceId,
      platform: dev.platform || '',
      label: dev.label || '',
      role: dev.role || '',
      scopes: Array.isArray(dev.scopes) ? dev.scopes : [],
      expiresAt: dev.expiresAt,
      approvedAt: dev.approvedAt,
    };
  }

  /**
   * All pending pairing requests (awaiting an explicit approve()), newest
   * first. Tokens are never part of a request record, so this is safe to
   * surface in a CLI listing.
   * @returns {Array<{requestId,deviceId,platform,label,status,createdAt}>}
   */
  pending() {
    return Object.values(this._data.requests)
      .filter((r) => r && r.status === 'pending')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /**
   * The existing pending request for a device, or null. Lets the connect
   * handler avoid piling up a fresh request on every unapproved reconnect.
   * @param {string} deviceId
   * @returns {object|null}
   */
  pendingForDevice(deviceId) {
    return Object.values(this._data.requests)
      .find((r) => r && r.status === 'pending' && r.deviceId === deviceId) || null;
  }

  /**
   * Approved devices with the token MASKED — for a CLI/dashboard listing
   * that must never echo a live bearer token.
   * @returns {Array<{deviceId,platform,label,approvedAt,tokenMasked}>}
   */
  devicesList() {
    return Object.values(this._data.devices).map((d) => ({
      deviceId: d.deviceId,
      platform: d.platform || '',
      label: d.label || '',
      approvedAt: d.approvedAt || '',
      tokenMasked: d.token ? `${String(d.token).slice(0, 6)}…${String(d.token).slice(-4)}` : '',
    }));
  }
}
