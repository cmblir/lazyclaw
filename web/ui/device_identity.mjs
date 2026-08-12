// web/ui/device_identity.mjs — this browser's device keypair.
//
// The private key is generated non-extractable and kept as a CryptoKey in
// IndexedDB, so no amount of JS access (an XSS, a leaked bearer token, a
// hostile extension) can read the private bytes out of the page — the most it
// can do is ask this key to sign, from this origin, while the tab is open.
// The cost is that the identity cannot be backed up or moved between
// browsers; re-pairing is the recovery path and it is cheap.
//
// This module knows nothing about HTTP. It hands out a deviceId and a
// signature; web/ui/pairing.mjs owns the protocol.

const DB_NAME = 'pompos-device';
const DB_VERSION = 1;
const STORE_NAME = 'identity';
const KEY_ID = 'device-keypair';

export class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

// ── IndexedDB store ───────────────────────────────────────────
// A CryptoKey is structured-cloneable, so IndexedDB stores the key OBJECT.
// A non-extractable key stays non-extractable across the round trip: the
// browser holds the material, the page only ever holds a handle to it.
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new IdentityError('NO_WEBCRYPTO', 'this browser has no IndexedDB, so a device identity cannot be kept'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
  });
}

function idbRun(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const out = fn(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
  });
}

export function idbStore() {
  return {
    async get() { const db = await idbOpen(); try { return (await idbRun(db, 'readonly', (s) => s.get(KEY_ID))) || null; } finally { db.close(); } },
    async put(pair) { const db = await idbOpen(); try { await idbRun(db, 'readwrite', (s) => s.put(pair, KEY_ID)); } finally { db.close(); } },
    async del() { const db = await idbOpen(); try { await idbRun(db, 'readwrite', (s) => s.delete(KEY_ID)); } finally { db.close(); } },
  };
}

// Resolved lazily: at module-eval time on a non-secure origin globalThis.crypto
// exists but .subtle does not, and we want a named error at call time, not a
// module that fails to load.
function resolveDeps(deps = {}) {
  return {
    // A caller that OWNS the 'subtle' key (even set to undefined, to assert
    // "this environment has none") must not be overridden by the real
    // global — Node itself exposes globalThis.crypto.subtle, so falling
    // back on `!== undefined` alone would silently swallow that assertion.
    subtle: 'subtle' in deps ? deps.subtle : globalThis.crypto?.subtle,
    store: deps.store || idbStore(),
  };
}

// The signing key handle for the CURRENT page. Rebuilt from the store on the
// first call after a reload; never serialised anywhere.
let cached = null;

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function derive(subtle, pair) {
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const digest = new Uint8Array(await subtle.digest('SHA-256', spki));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return { deviceId: `sha256:${hex}`, publicKeyDerBase64: bytesToBase64(spki) };
}

/**
 * The device identity for this browser profile, generating it on first use.
 * @param {{subtle?: SubtleCrypto, store?: object}} [deps]
 * @returns {Promise<{deviceId: string, publicKeyDerBase64: string}>}
 */
export async function getOrCreateIdentity(deps) {
  const { subtle, store } = resolveDeps(deps);
  if (!subtle) {
    throw new IdentityError('NO_WEBCRYPTO',
      'WebCrypto is unavailable — a browser only exposes it on a secure origin (https, or http on localhost/127.0.0.1). Open the dashboard on its loopback address to pair this browser.');
  }
  let pair = await store.get();
  if (!pair) {
    try {
      pair = await subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    } catch (err) {
      throw new IdentityError('NO_ED25519', `this browser cannot generate an Ed25519 key (${err && err.message ? err.message : err}); pair from a browser that supports Ed25519 — approvals can only be answered by a paired device`);
    }
    await store.put(pair);
  }
  cached = { subtle, pair };
  return derive(subtle, pair);
}

/**
 * Sign the exact bytes the gateway will re-derive and verify.
 * @param {Uint8Array} bytes
 * @param {{subtle?: SubtleCrypto, store?: object}} [deps]
 * @returns {Promise<Uint8Array>} 64-byte Ed25519 signature
 */
export async function sign(bytes, deps) {
  const { subtle, store } = resolveDeps(deps);
  // The module-level cache only stands in for a store lookup on the
  // zero-arg production call (one page, one real IndexedDB-backed store).
  // A caller that supplies its own deps — every test, and any future
  // multi-identity caller — gets the authoritative answer from that store
  // instead of a stale pair left behind by an unrelated identity that
  // happened to share this JS realm's crypto.subtle.
  let held = deps === undefined && cached && cached.subtle === subtle ? cached.pair : null;
  if (!held) held = await store.get();
  if (!held) {
    throw new IdentityError('NO_IDENTITY', 'no device key yet — call getOrCreateIdentity() before signing');
  }
  return new Uint8Array(await subtle.sign('Ed25519', held.privateKey, bytes));
}

/**
 * Drop this browser's key. The server-side device record is untouched —
 * revoke it with `pompos nodes revoke` if it should stop being trusted.
 * @param {{subtle?: SubtleCrypto, store?: object}} [deps]
 */
export async function forgetIdentity(deps) {
  const { store } = resolveDeps(deps);
  cached = null;
  await store.del();
}
