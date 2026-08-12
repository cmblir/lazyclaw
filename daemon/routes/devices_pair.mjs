// daemon/routes/devices_pair.mjs — POST /devices/pair.
//
// The one route the pairing flow adds. Everything after it is the gateway's
// existing, unchanged handshake: the caller still has to prove it holds the
// private key at POST /gateway/connect before any device token is minted, so
// this route never returns a token and pairing a key you do not own gains an
// attacker nothing.
//
// Why it lives on the daemon rather than in the gateway: the daemon's bearer
// gate runs in front of it (daemon.mjs), while /gateway/* is routed BEFORE
// that gate by design — so this route always gets at least as much
// protection as /gateway/* does, and strictly more whenever an operator has
// configured a bearer token (daemon.mjs's authToken is opt-in and off by
// default). With no token configured, any local process that knows the port
// can claim the bootstrap slot with its own key and become the sole
// approver — the same trust boundary the rest of the daemon already assumes
// for an unauthenticated loopback deployment.
import crypto from 'node:crypto';
import { readJson, writeJson } from './_deps.mjs';
import { withKeyedLockSync } from '../../lib/config_dir.mjs';
import { PairingStore, deviceIdFromPublicKey } from '../../gateway/device_auth.mjs';

// Loopback per the socket, never per a header: X-Forwarded-For and friends are
// attacker-controlled. These three are the forms Node reports for a loopback
// peer (IPv4, IPv6, and IPv4-mapped IPv6).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req) {
  return LOOPBACK.has(String(req?.socket?.remoteAddress || ''));
}

// The mandated envelope for anything past this point that must not report
// success. Both the lock's own reentrancy guard (a same-process bug, not a
// client error — see the catch below) and the outcome-shape assertion route
// here, so a stray future `await` inside the critical section is loud
// instead of a silently malformed response. Deliberately generic:
// withKeyedLockSync's own error message embeds the absolute config-dir
// path, which must never reach a caller.
function pairBusy(res) {
  return writeJson(res, 500, { ok: false, error: 'pairing request could not be completed', code: 'PAIR_BUSY' });
}

export async function devicesPair(c) {
  const { req, res, gwConfigDir } = c;
  let body;
  try { body = await readJson(req); }
  catch (e) { return writeJson(res, 400, { ok: false, error: `invalid JSON body: ${e.message}`, code: 'BAD_BODY' }); }

  const publicKey = body && typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
  if (!publicKey) {
    return writeJson(res, 400, { ok: false, error: 'publicKey is required (base64 DER SPKI or PEM)', code: 'BAD_BODY' });
  }
  // Capped so an unsigned, unvalidated label/platform can't be used to
  // social-engineer the operator ("MacBook Pro — kitchen") with an
  // arbitrarily long string, nor to inflate devices.json (read on every
  // gateway op) via 1000 pending rows of near-unbounded text.
  const platform = typeof body.platform === 'string' ? body.platform.slice(0, 64) : '';
  const label = typeof body.label === 'string' ? body.label.slice(0, 64) : '';

  let deviceId;
  try {
    // deviceIdFromPublicKey accepts PEM or DER; a base64 DER SPKI string is
    // decoded here so the browser can send exportKey('spki') verbatim.
    const raw = /-----BEGIN/.test(publicKey) ? publicKey : Buffer.from(publicKey, 'base64');
    // Reject a PRIVATE key outright, BEFORE createPublicKey: given a PEM
    // string it auto-detects a "PRIVATE KEY" header too and silently derives
    // the public half, which would mint an identity from an entirely
    // different secret than the one the browser is meant to hold onto.
    // (A private key's DER bytes already fail the SPKI-typed parse below on
    // their own — this check exists for the PEM branch.)
    let isPrivateKey = false;
    try { crypto.createPrivateKey(raw); isPrivateKey = true; } catch { /* good: not a private key */ }
    if (isPrivateKey) throw new Error('private key rejected');
    // Classify the key BEFORE minting an identity from it: crypto.createPublicKey
    // happily parses RSA/EC/X25519 SPKI too — none of which /gateway/connect
    // will ever authenticate (verifyConnect pins Ed25519 — device_auth.mjs).
    // Approving a device whose key can never complete that handshake would
    // burn the one-shot bootstrap slot on a device that can never actually
    // finish pairing.
    const keyObj = Buffer.isBuffer(raw)
      ? crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' })
      : crypto.createPublicKey(raw);
    if (keyObj.type !== 'public' || keyObj.asymmetricKeyType !== 'ed25519') {
      throw new Error('unsupported key');
    }
    deviceId = deviceIdFromPublicKey(keyObj);
  } catch {
    // Generic — don't reflect node:crypto parse internals back to a caller.
    return writeJson(res, 400, { ok: false, error: 'invalid public key', code: 'BAD_PUBLIC_KEY' });
  }

  // ── The critical section ───────────────────────────────────────
  // Everything from here to the end is SYNCHRONOUS on purpose. The store
  // reads devices.json in its constructor, so constructing it before the
  // body await would let two concurrent requests both hold a stale empty
  // roster, both believe they are first, and the second _persist() erase the
  // first device. With no await inside, the event loop cannot interleave.
  //
  // The lock key is deliberately NOT store.path: PairingStore.approve()
  // already holds withKeyedLockSync(this.path, …) and that helper throws on a
  // re-entrant section. A distinct key still turns a future stray await into
  // a loud failure instead of a silent double-approve.
  let outcome;
  try {
    outcome = withKeyedLockSync(`${gwConfigDir}#pair-bootstrap`, () => {
      const store = new PairingStore(gwConfigDir);
      if (store.isApproved(deviceId)) return { status: 'approved', deviceId };

      const existing = store.pendingForDevice(deviceId);
      const requestId = existing
        ? existing.requestId
        : store.requestPairing({ deviceId, platform, label, role: '', scopes: [] }).requestId;

      // The bootstrap rule: auto-approve only while NO device has EVER been
      // approved on this install, and only over loopback. Stopping at the first
      // device is what keeps a stolen bearer token from minting a second
      // approver.
      //
      // The marker is an approved REQUEST row, not the device roster:
      // revoke() deletes the device record, so `devicesList().length === 0`
      // reopened the slot every time the roster went empty — and the Devices
      // panel's own copy walks the operator into exactly that ("Revoke the old
      // record with `pompos nodes revoke`"), after which whichever loopback
      // process reached this route first became the sole approver, browser or
      // not. An approved request row is durable: _prunePending() ages out only
      // rows still in 'pending'. Recovery for a fully revoked install is
      // `pompos nodes approve <requestId>`, not a second free bootstrap.
      const everApproved = Object.values(store._data.requests)
        .some((r) => r && r.status === 'approved');
      if (!everApproved && isLoopback(req)) {
        store.approve(requestId);
        return { status: 'approved', deviceId };
      }
      return { status: 'pending', deviceId, requestId, fingerprint: deviceId.slice(7, 19) };
    });
  } catch (err) {
    if (err && err.code === 'PAIRING_CAP') {
      return writeJson(res, 429, { ok: false, error: 'too many pending pairing requests; try later', code: 'PAIRING_CAP' });
    }
    // Anything else here (e.g. withKeyedLockSync's reentrancy guard) is a
    // same-process bug, not a client error — never report success, and
    // never let the daemon's generic 500 handler echo the raw error
    // (whose message embeds an absolute config-dir path) to the caller.
    return pairBusy(res);
  }

  // Defend the response contract: if a future edit slips an `await` into the
  // critical section above, `outcome` becomes a Promise instead of the
  // synchronous result, and `outcome.status` would silently be `undefined`
  // — this turns that into a loud failure instead of a malformed
  // `202 {"ok":true}` with no status/deviceId/requestId.
  if (!outcome || typeof outcome.status !== 'string') {
    return pairBusy(res);
  }

  // No `ok` on the 202: a pending device can resolve nothing, so a consumer
  // that checks `body.ok` must not read it as success. `status` is the field
  // that carries the outcome (web/ui/pairing.mjs branches on it).
  return outcome.status === 'approved'
    ? writeJson(res, 200, { ok: true, ...outcome })
    : writeJson(res, 202, { ...outcome });
}
