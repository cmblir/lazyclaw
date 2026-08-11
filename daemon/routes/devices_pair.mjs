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
// that gate by design. Putting the bootstrap auto-approve behind the bearer
// gate means the first-device slot cannot be claimed by any loopback process
// that merely knows the port.
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

export async function devicesPair(c) {
  const { req, res, gwConfigDir } = c;
  let body;
  try { body = await readJson(req); }
  catch (e) { return writeJson(res, 400, { ok: false, error: `invalid JSON body: ${e.message}`, code: 'BAD_BODY' }); }

  const publicKey = body && typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
  if (!publicKey) {
    return writeJson(res, 400, { ok: false, error: 'publicKey is required (base64 DER SPKI or PEM)', code: 'BAD_BODY' });
  }
  const platform = typeof body.platform === 'string' ? body.platform : '';
  const label = typeof body.label === 'string' ? body.label : '';

  let deviceId;
  try {
    // deviceIdFromPublicKey accepts PEM or DER; a base64 DER SPKI string is
    // decoded here so the browser can send exportKey('spki') verbatim.
    deviceId = deviceIdFromPublicKey(/-----BEGIN/.test(publicKey) ? publicKey : Buffer.from(publicKey, 'base64'));
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

      // The bootstrap rule: auto-approve only while NO device is paired at
      // all, and only over loopback. Stopping at the first device is what
      // keeps a stolen bearer token from minting a second approver.
      if (store.devicesList().length === 0 && isLoopback(req)) {
        store.approve(requestId);
        return { status: 'approved', deviceId };
      }
      return { status: 'pending', deviceId, requestId, fingerprint: deviceId.slice(7, 19) };
    });
  } catch (err) {
    if (err && err.code === 'PAIRING_CAP') {
      return writeJson(res, 429, { ok: false, error: 'too many pending pairing requests; try later', code: 'PAIRING_CAP' });
    }
    throw err;
  }

  return outcome.status === 'approved'
    ? writeJson(res, 200, { ok: true, ...outcome })
    : writeJson(res, 202, { ok: true, ...outcome });
}
