# Dashboard Pairing & Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the dashboard becomes a real Ed25519-paired device, so an operator resolves an approval from the browser instead of the terminal.

**Architecture:** the browser generates a non-extractable Ed25519 keypair in IndexedDB and derives its `deviceId` the same way the server does. One new bearer-gated daemon route (`POST /devices/pair`) applies the bootstrap rule — auto-approve only the FIRST device and only over loopback — and everything after that reuses the gateway's existing, unchanged handshake (`POST /gateway/connect/challenge` → `POST /gateway/connect`) and its existing device-gated resolve route (`POST /gateway/exec/resolve`). No command code and no crypto is re-implemented.

**Tech Stack:** zero-build native ES modules in `web/` (no bundler, no npm dependency may be added), Node's `node:test` runner, Playwright for E2E, WebCrypto Ed25519 + IndexedDB in the browser, `node:crypto` on the server.

## Global Constraints

- No new npm dependencies. `web/` ships as source; every browser module is a native ES module loaded by URL.
- Every committed `.mjs` file must be ≤ 500 lines. `gateway/device_auth.mjs` sits on the size ratchet at a **664-line ceiling and is currently 646 lines** (`scripts/lint-file-size.mjs`). Never raise a ceiling and never add an `ALLOW` entry — split the file instead. This plan adds **zero** lines to `gateway/device_auth.mjs`.
- `deviceId` format is `sha256:<64 hex chars>` — SHA-256 over the DER SPKI bytes of the public key, produced by `deviceIdFromPublicKey` in `gateway/device_auth.mjs`. The browser must produce byte-identical input.
- The loopback test reads `req.socket?.remoteAddress` and NEVER a header. `X-Forwarded-For` is attacker-controlled. The three loopback values that occur are `'127.0.0.1'`, `'::1'`, and `'::ffff:127.0.0.1'`.
- A resolve that cannot happen must never report success. Every failure path returns an explicit failure the UI renders; no silent no-op, no optimistic refresh.
- Error envelope for the new daemon route and the browser resolve helper: `{ ok: false, error: <string>, code: <string> }`. A 401 from the daemon's bearer gate is `{ error: 'unauthorized' }` with **no `ok` field** — consumers must test truthiness, never `=== false`.
- Commit messages: `<type>(<scope>): <subject>`, English, no Claude attribution lines, no `Co-Authored-By`.
- Comments and docstrings in English.

## Deviations from the approved spec (`docs/superpowers/specs/2026-08-11-dashboard-pairing-design.md`)

Three, each forced by something in the existing source. Implement the plan, not the spec, where they differ.

1. **No `POST /approvals/:id/resolve`.** `POST /gateway/exec/resolve` (`gateway/http_gateway.mjs:277`) already does exactly what that route would do: `authDevice(req)` → `verifyToken(deviceId, token, now)` → a role gate refusing `read-only` → `resolveApproval(id, decision, deviceId)` → 200/404. Adding a daemon-side twin would duplicate the Ed25519 gate and create a second place for it to drift — the precise hazard `daemon/routes/gateway_views.mjs`'s own comment warns about. The browser calls the gateway route directly; `/gateway/*` is routed before the daemon's bearer gate (`daemon.mjs:268`), so a same-origin browser reaches it.
2. **`DEVICE_REVOKED` and `TOKEN_EXPIRED` are not returned.** `PairingStore.revoke()` deletes the device record, so a revoked device is indistinguishable from one that never paired; and an expired token is re-minted by re-running the handshake, which then answers `pending` if the device is gone. Both collapse into `NOT_PAIRED`, which is also what the spec's own Testing section asks for ("`NOT_PAIRED` for a revoked device"). Shipping a code that can never be produced would be a lie in the contract.
3. **The device token is never persisted.** It lives in a module-level variable and is re-minted on demand. The spec only required it be kept separate from the dashboard bearer token; not storing it at all is strictly stronger, since the non-extractable key can always mint a fresh one.

## Facts already verified — do not re-derive

- In Playwright's bundled Chromium (HeadlessChrome/148) on a `http://127.0.0.1:<port>` origin: `crypto.subtle.generateKey('Ed25519', false, ['sign','verify'])` succeeds, `privateKey.extractable === false`, `exportKey('pkcs8', privateKey)` throws `InvalidAccessError`, `exportKey('spki', publicKey)` is 44 bytes, `sign('Ed25519', …)` is 64 bytes, `indexedDB` is defined, `isSecureContext === true`.
- `crypto.subtle` is **undefined** in a non-secure context (verified on `about:blank`). A plain-`http` non-loopback origin is non-secure per the W3C secure-contexts rule, so the identity module must degrade with an actionable message instead of throwing a `TypeError`.
- Node 24's `crypto.subtle` supports Ed25519, so the identity module is unit-testable under `node --test` with an injected key store.
- `withKeyedLockSync(key, fn)` (`lib/config_dir.mjs:90`) is **not re-entrant** — it *throws* on an overlapping section for the same key rather than queueing. `PairingStore.approve()` already wraps its body in `withKeyedLockSync(this.path, …)`, so a route must never nest another section on `this.path`.

## Exact signatures this plan builds on

```js
// gateway/device_auth.mjs
deviceIdFromPublicKey(publicKeyPemOrDer) -> 'sha256:<hex>'
buildSignPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) -> string
verifyConnect({ payload, signature, publicKey, challenge, maxSkewMs, nowMs }) -> { ok: true } | { ok: false, reason }
new PairingStore(configDir)                       // ._load()s devices.json in the constructor
  .requestPairing({ deviceId, platform, label, role, scopes }) -> { requestId, status: 'pending' }
  .approve(requestId, { ttlMs, nowMs }) -> { deviceId, token, expiresAt? }   // throws on unknown / non-pending
  .pendingForDevice(deviceId) -> { requestId, … } | undefined
  .isApproved(deviceId) -> boolean
  .devicesList() -> [{ deviceId, platform, label, approvedAt, tokenMasked }]
  .verifyToken(deviceId, presentedToken, nowMs) -> boolean

// gateway/http_gateway.mjs — createGateway() returns
{ handle, broadcast, sseClients, requestApproval, resolveApproval, pendingApprovals, close }
resolveApproval(id, decision, by = '') -> { ok: true, id, approved } | { ok: false, reason: 'unknown or already resolved' }
requestApproval(detail, { timeoutMs }) -> { id, promise }   // promise resolves { id, approved, by, reason }
```

The gateway handshake, unchanged:

```
POST /gateway/connect/challenge                                  -> 200 { nonce, ts }
POST /gateway/connect { payload, signature, publicKey, nonce, platform, label }
    -> 200 { ok: true, deviceId, token }        device already approved
    -> 403 { ok: false, status: 'pending', deviceId, requestId }
POST /gateway/exec/resolve { id, decision }
    headers: Authorization: Bearer <DEVICE token>, x-device-id: <deviceId>
    -> 200 { ok: true, id, approved } | 401 invalid device token | 403 read-only | 404 { ok:false, reason }
```

## File structure

| File | Responsibility |
|---|---|
| create `web/ui/device_identity.mjs` | The device keypair only: generate/load from IndexedDB, derive `deviceId`, sign bytes, forget. Knows nothing about HTTP. |
| create `web/ui/pairing.mjs` | The protocol: pair → challenge → sign → connect → hold the token in memory → `resolveApproval`. Knows nothing about the DOM. |
| create `daemon/routes/devices_pair.mjs` | `POST /devices/pair` — the bootstrap rule and nothing else. |
| create `tests/f-device-identity.test.mjs` | Identity unit tests, including `deviceId` agreement with the server helper. |
| create `tests/f-devices-pair.test.mjs` | Bootstrap, loopback, idempotency, concurrency. |
| create `tests/f-pairing-client.test.mjs` | The browser protocol against the real `verifyConnect`, with an injected `fetch`. |
| modify `daemon/route_table.mjs` | +1 route entry. |
| modify `web/ui/panels/approvals.mjs` | Enable the buttons, resolve, render every failure; replace the read-only banner. |
| modify `web/ui/panels/gateway.mjs` | "Pair this browser" / "Forget this browser's key". |
| modify `web/ui/api.mjs` | Correct the "ALL requests route through here" comment — `/gateway/*` deliberately does not. |
| modify `daemon/routes/gateway_views.mjs` | Its header comment claims resolving from the dashboard is future work. It no longer is. |
| modify `tests/phaseI-dashboard-operations.spec.ts` | Raise a real approval, resolve it from the browser, drop `expect.soft`. |
| modify `README.md`, `CHANGELOG.md` | The pairing flow is a user-facing feature. |

---

### Task 1: Browser device identity

**Files:**
- Create: `web/ui/device_identity.mjs`
- Test: `tests/f-device-identity.test.mjs`

**Interfaces:**
- Consumes: `deviceIdFromPublicKey` from `gateway/device_auth.mjs` (test only — the browser module must never import server code).
- Produces:
  ```js
  // Every function takes an optional deps object so it is testable under node --test.
  // deps = { subtle = globalThis.crypto?.subtle, store = idbStore() }
  getOrCreateIdentity(deps?) -> Promise<{ deviceId: string, publicKeyDerBase64: string }>
  sign(bytes: Uint8Array, deps?) -> Promise<Uint8Array>   // 64 bytes
  forgetIdentity(deps?) -> Promise<void>
  IdentityError                                            // class, carries .code
  // store interface: { get(): Promise<{publicKey,privateKey}|null>, put(pair): Promise<void>, del(): Promise<void> }
  ```
  `IdentityError` codes: `NO_WEBCRYPTO` (no secure context / no `crypto.subtle`), `NO_ED25519` (the browser has WebCrypto but refuses Ed25519), `NO_IDENTITY` (`sign` called before `getOrCreateIdentity`).

- [ ] **Step 1: Write the failing test**

Create `tests/f-device-identity.test.mjs`:

```js
// tests/f-device-identity.test.mjs — the browser's device keypair.
//
// Runs under node --test against Node's own crypto.subtle (which supports
// Ed25519) with a Map-backed stand-in for IndexedDB, so the protocol-level
// facts are pinned without a browser. The browser-only facts — that
// crypto.subtle exists at all, and that IndexedDB survives a reload — are
// covered by tests/phaseI-dashboard-operations.spec.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { deviceIdFromPublicKey } from '../gateway/device_auth.mjs';
import { getOrCreateIdentity, sign, forgetIdentity, IdentityError } from '../web/ui/device_identity.mjs';

// The smallest thing that satisfies the store contract. A real CryptoKey is
// held by reference, exactly as IndexedDB's structured clone would hold it.
function fakeStore() {
  let held = null;
  return {
    async get() { return held; },
    async put(pair) { held = pair; },
    async del() { held = null; },
    peek() { return held; },
  };
}

function deps(store = fakeStore()) {
  return { subtle: webcrypto.subtle, store };
}

test('the deviceId the browser derives is the one the server derives', async () => {
  const d = deps();
  const { deviceId, publicKeyDerBase64 } = await getOrCreateIdentity(d);
  assert.match(deviceId, /^sha256:[0-9a-f]{64}$/);
  const der = Buffer.from(publicKeyDerBase64, 'base64');
  assert.equal(deviceId, deviceIdFromPublicKey(der),
    'the browser must hash the same DER SPKI bytes the server hashes, or pairing binds the wrong identity');
});

test('a second call reuses the stored key instead of minting a new identity', async () => {
  const d = deps();
  const first = await getOrCreateIdentity(d);
  const second = await getOrCreateIdentity(d);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.publicKeyDerBase64, first.publicKeyDerBase64);
});

test('the stored private key cannot be exported', async () => {
  const store = fakeStore();
  await getOrCreateIdentity(deps(store));
  const { privateKey } = store.peek();
  assert.equal(privateKey.extractable, false);
  await assert.rejects(() => webcrypto.subtle.exportKey('pkcs8', privateKey),
    'a key an attacker can export is a key an attacker can impersonate');
});

test('sign produces a 64-byte signature the public key verifies', async () => {
  const store = fakeStore();
  const d = deps(store);
  await getOrCreateIdentity(d);
  const bytes = new TextEncoder().encode('canonical|payload|string');
  const sig = await sign(bytes, d);
  assert.equal(sig.length, 64);
  const ok = await webcrypto.subtle.verify('Ed25519', store.peek().publicKey, sig, bytes);
  assert.equal(ok, true);
});

test('sign before getOrCreateIdentity fails loudly instead of signing with nothing', async () => {
  const d = deps();
  await assert.rejects(() => sign(new Uint8Array([1]), d), (e) => e instanceof IdentityError && e.code === 'NO_IDENTITY');
});

test('forgetIdentity drops the pair, and the next call mints a different identity', async () => {
  const store = fakeStore();
  const d = deps(store);
  const before = await getOrCreateIdentity(d);
  await forgetIdentity(d);
  assert.equal(store.peek(), null);
  const after = await getOrCreateIdentity(d);
  assert.notEqual(after.deviceId, before.deviceId);
});

test('no WebCrypto reports NO_WEBCRYPTO rather than throwing a TypeError', async () => {
  await assert.rejects(
    () => getOrCreateIdentity({ subtle: undefined, store: fakeStore() }),
    (e) => e instanceof IdentityError && e.code === 'NO_WEBCRYPTO',
    'a dashboard served over plain http on a LAN address has no crypto.subtle at all; the operator must be told why, not shown a stack trace',
  );
});

test('a browser that refuses Ed25519 reports NO_ED25519', async () => {
  const subtle = { generateKey: async () => { throw new DOMException('Unrecognized name.', 'NotSupportedError'); } };
  await assert.rejects(
    () => getOrCreateIdentity({ subtle, store: fakeStore() }),
    (e) => e instanceof IdentityError && e.code === 'NO_ED25519',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/f-device-identity.test.mjs`
Expected: FAIL — `Cannot find module '.../web/ui/device_identity.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `web/ui/device_identity.mjs`:

```js
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
    subtle: deps.subtle !== undefined ? deps.subtle : globalThis.crypto?.subtle,
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
      throw new IdentityError('NO_ED25519', `this browser cannot generate an Ed25519 key (${err && err.message ? err.message : err}); pair from a browser that supports it, or approve with \`pompos nodes approve\``);
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
  let held = cached && cached.subtle === subtle ? cached.pair : null;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/f-device-identity.test.mjs`
Expected: PASS, 8/8.

- [ ] **Step 5: Prove the deviceId test has teeth**

Temporarily change `derive()` to hash the raw `spki` after slicing off its first byte (`spki.slice(1)`), re-run, and confirm the first test FAILS with a deviceId mismatch. Restore the correct code and re-run to green. A test that agrees with the server by accident is worthless.

- [ ] **Step 6: Commit**

```bash
git add web/ui/device_identity.mjs tests/f-device-identity.test.mjs
git commit -m "feat(dashboard): non-extractable Ed25519 device identity in the browser

The dashboard needs a device identity of its own before it can resolve an
approval — approval is the heaviest authority in this system and stays gated
on a paired device, not on whoever holds the bearer token. The private key is
generated non-extractable and kept in IndexedDB, so an XSS or a stolen bearer
token can ask it to sign but can never carry it away. deviceId is SHA-256 over
the exported DER SPKI, the same bytes deviceIdFromPublicKey hashes."
```

---

### Task 2: `POST /devices/pair` — the bootstrap rule

**Files:**
- Create: `daemon/routes/devices_pair.mjs`
- Modify: `daemon/route_table.mjs` (add one entry beside `GET /devices`)
- Test: `tests/f-devices-pair.test.mjs`

**Interfaces:**
- Consumes: `PairingStore` (`requestPairing`, `approve`, `isApproved`, `pendingForDevice`, `devicesList`), `deviceIdFromPublicKey`, and `readJson` / `writeJson` from `daemon/routes/_deps.mjs`. The route ctx `c` carries `{ req, res, gwConfigDir }`.
- Produces: the route's response envelopes, consumed by Task 3:
  ```
  200 { ok: true,  status: 'approved', deviceId }
  202 { ok: true,  status: 'pending',  deviceId, requestId, fingerprint }
  400 { ok: false, error, code: 'BAD_PUBLIC_KEY' | 'BAD_BODY' }
  429 { ok: false, error, code: 'PAIRING_CAP' }
  ```
  `fingerprint` is `deviceId.slice(7, 19)` — the first 12 hex characters of the hash, so an operator can eyeball-match the request against the full id `pompos nodes pending` prints.

**Two things the implementer must get exactly right.**

*(a) Construct the `PairingStore` AFTER awaiting the body, never before.* `new PairingStore(dir)` reads `devices.json` in its constructor. If two concurrent pair requests both construct their store before either writes, both hold stale empty data, both believe they are first, and the second `_persist()` overwrites the first device out of existence. Reading the body first, then doing load → check → approve → persist with **no `await` between them**, makes interleaving impossible: the event loop cannot switch inside synchronous code.

*(b) Do not nest a lock on `store.path`.* `PairingStore.approve()` already wraps its body in `withKeyedLockSync(this.path, …)`, and that helper *throws* on an overlapping section for the same key. Wrap the synchronous block in `withKeyedLockSync(gwConfigDir + '#pair-bootstrap', …)` — a distinct key, so it never nests with `approve()`'s, and it turns any future `await` slipped into the middle into a loud 500 instead of a silent double-approve.

- [ ] **Step 1: Write the failing test**

Create `tests/f-devices-pair.test.mjs`:

```js
// tests/f-devices-pair.test.mjs — POST /devices/pair and the bootstrap rule.
//
// The rule under test: loopback auto-approve ONLY while no device is paired
// at all. Without the "only while none" clause the non-extractable browser key
// would be pointless — an attacker holding the bearer token could not steal
// the paired device's identity, but could mint a fresh approver of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { PairingStore, deviceIdFromPublicKey } from '../gateway/device_auth.mjs';
import { devicesPair } from '../daemon/routes/devices_pair.mjs';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-pair-'));
  return d;
}

function freshKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { der, base64: der.toString('base64'), deviceId: deviceIdFromPublicKey(der) };
}

// Minimal req/res stand-ins. `remoteAddress` is the ONLY loopback signal the
// route may read — a header would be attacker-controlled.
function fakeReq(body, remoteAddress = '127.0.0.1') {
  const raw = JSON.stringify(body);
  return {
    method: 'POST',
    url: '/devices/pair',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw); },
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(raw));
      if (ev === 'end') fn();
      return this;
    },
  };
}

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
  };
}

async function call(gwConfigDir, body, remoteAddress) {
  const req = fakeReq(body, remoteAddress);
  const res = fakeRes();
  await devicesPair({ req, res, gwConfigDir });
  return res;
}

test('the FIRST device on loopback is approved with no operator action', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const res = await call(dir, { publicKey: k.base64, platform: 'browser', label: 'dashboard' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, status: 'approved', deviceId: k.deviceId });
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), true);
});

test('the SECOND device on loopback is pending — the bootstrap slot is used once', async () => {
  const dir = tmpDir();
  const first = freshKey();
  const second = freshKey();
  await call(dir, { publicKey: first.base64, platform: 'browser', label: 'one' });
  const res = await call(dir, { publicKey: second.base64, platform: 'browser', label: 'two' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.deviceId, second.deviceId);
  assert.match(res.body.requestId, /.+/);
  assert.equal(res.body.fingerprint, second.deviceId.slice(7, 19));
  const store = new PairingStore(dir);
  assert.equal(store.isApproved(second.deviceId), false);
  assert.equal(store.isApproved(first.deviceId), true, 'approving nobody must not un-approve the device that is already paired');
});

test('a NON-loopback first device is pending — loopback is the whole bootstrap condition', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const res = await call(dir, { publicKey: k.base64, platform: 'browser', label: 'lan' }, '192.168.1.24');
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'pending');
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), false);
});

test('a forwarded-for header cannot forge loopback', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const req = fakeReq({ publicKey: k.base64 }, '192.168.1.24');
  req.headers['x-forwarded-for'] = '127.0.0.1';
  req.headers['x-real-ip'] = '127.0.0.1';
  const res = fakeRes();
  await devicesPair({ req, res, gwConfigDir: dir });
  assert.equal(res.statusCode, 202, 'the socket address is the only trustworthy signal');
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), false);
});

for (const remote of ['::1', '::ffff:127.0.0.1']) {
  test(`IPv6 loopback ${remote} counts as loopback`, async () => {
    const dir = tmpDir();
    const k = freshKey();
    const res = await call(dir, { publicKey: k.base64 }, remote);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'approved');
  });
}

test('re-pairing an already-approved device is idempotent and mints no second request', async () => {
  const dir = tmpDir();
  const k = freshKey();
  await call(dir, { publicKey: k.base64 });
  const res = await call(dir, { publicKey: k.base64 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(new PairingStore(dir).pending().length, 0);
});

test('a repeated pending request reuses its requestId', async () => {
  const dir = tmpDir();
  await call(dir, { publicKey: freshKey().base64 });          // consume the bootstrap slot
  const k = freshKey();
  const a = await call(dir, { publicKey: k.base64 });
  const b = await call(dir, { publicKey: k.base64 });
  assert.equal(a.body.requestId, b.body.requestId, 'a reload must not pile up duplicate pending requests');
  assert.equal(new PairingStore(dir).pending().length, 1);
});

test('a malformed public key is a named 400, not a 500', async () => {
  const dir = tmpDir();
  const res = await call(dir, { publicKey: 'not-a-key' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_PUBLIC_KEY');
  assert.equal(res.body.ok, false);
});

test('a missing public key is a named 400', async () => {
  const dir = tmpDir();
  const res = await call(dir, { platform: 'browser' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_BODY');
});

test('two concurrent first-pair requests approve EXACTLY ONE device', async () => {
  const dir = tmpDir();
  const a = freshKey();
  const b = freshKey();
  const [ra, rb] = await Promise.all([
    call(dir, { publicKey: a.base64, label: 'a' }),
    call(dir, { publicKey: b.base64, label: 'b' }),
  ]);
  const statuses = [ra.body.status, rb.body.status].sort();
  assert.deepEqual(statuses, ['approved', 'pending'],
    'both browsers seeing an empty roster and both auto-approving would mint two approvers from one bootstrap slot');
  assert.equal(new PairingStore(dir).devicesList().length, 1,
    'and the loser must still be on disk as a pending request, not have overwritten the winner');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/f-devices-pair.test.mjs`
Expected: FAIL — `Cannot find module '.../daemon/routes/devices_pair.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `daemon/routes/devices_pair.mjs`:

```js
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
```

- [ ] **Step 4: Add the route**

In `daemon/route_table.mjs`, add the import beside the existing `gatewayViews` import:

```js
import * as devicesPairRoute from './routes/devices_pair.mjs';
```

and the entry immediately after the `GET /devices` line (order is only load-bearing for the exclusion-based predicates further up; this exact-match entry is safe there):

```js
  { m: (c) => c.route === 'POST /devices/pair', h: devicesPairRoute.devicesPair },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/f-devices-pair.test.mjs`
Expected: PASS, 11/11.

- [ ] **Step 6: Prove the concurrency test has teeth**

Temporarily move `const store = new PairingStore(gwConfigDir);` above `let body;` (i.e. construct it before the body await) and re-run. Expected: the concurrent test FAILS — either two `approved` statuses, or `devicesList().length === 1` with the wrong device on disk. Restore the correct order and re-run to green.

- [ ] **Step 7: Verify the route is reachable and gated**

Run:

```bash
node --test tests/f-slash-routes.test.mjs tests/f-dashboard-auth.test.mjs
node scripts/lint-file-size.mjs
```

Expected: PASS — the existing route-table and auth-gate suites still pass, and the size gate is clean.

- [ ] **Step 8: Commit**

```bash
git add daemon/routes/devices_pair.mjs daemon/route_table.mjs tests/f-devices-pair.test.mjs
git commit -m "feat(daemon): POST /devices/pair with first-device-only loopback auto-approve

Resolves the chicken-and-egg in device pairing: the first device has no
approver, so a loopback request is auto-approved while the roster is empty and
never after. Every later device stays pending, so a stolen bearer token cannot
silently enrol a second approver.

The route returns no token — the caller still proves possession of the private
key at POST /gateway/connect. It sits on the daemon, behind the bearer gate,
precisely because /gateway/* is routed in front of that gate.

The store is constructed after the body await and the check-then-approve runs
in one synchronous block, so two concurrent first-pair requests cannot both
read an empty roster; a test drives that race and asserts exactly one
approval."
```

---

### Task 3: The browser pairing protocol

**Files:**
- Create: `web/ui/pairing.mjs`
- Modify: `web/ui/api.mjs` (correct the comment at the top of the file)
- Test: `tests/f-pairing-client.test.mjs`

**Interfaces:**
- Consumes: `getOrCreateIdentity`, `sign`, `forgetIdentity`, `IdentityError` from `web/ui/device_identity.mjs` (Task 1); `POST /devices/pair`'s envelopes (Task 2); the gateway handshake routes.
- Produces, for Task 4:
  ```js
  pairThisBrowser(deps?) -> Promise<{ ok: true, deviceId } | { ok: false, error, code, deviceId?, requestId?, fingerprint? }>
  resolveApproval(id, decision, deps?) -> Promise<{ ok: true, id, approved } | { ok: false, error, code }>
     // decision: 'approve' | 'deny'
  isPaired(deps?) -> Promise<boolean>        // cheap: does this browser hold a live device token
  unpairThisBrowser(deps?) -> Promise<void>  // forget the local key + token; server record untouched
  ```
  Failure codes: `NOT_PAIRED`, `PENDING_APPROVAL`, `READ_ONLY`, `APPROVAL_GONE`, `NO_WEBCRYPTO`, `NO_ED25519`, `PAIR_FAILED`, `RESOLVE_FAILED`.

**Why this module calls `globalThis.fetch` directly.** `web/ui/api.mjs`'s `apiRaw` attaches `Authorization: Bearer <dashboard token>`. On `/gateway/*` that header must instead carry the **device** token — a different credential authenticating a different thing — so routing these calls through `api()` would send the wrong one. `POST /devices/pair` is an ordinary daemon route and DOES go through `api()`.

**The signed payload.** `buildSignPayload` joins 11 `|`-separated fields in a fixed order; the browser must reproduce that string exactly or `verifyConnect` rejects it. Reimplement it in the browser (it is 12 lines and importing server code into `web/` is not possible) and let the test verify the result against the real `verifyConnect` rather than against a copy of the expectation.

- [ ] **Step 1: Write the failing test**

Create `tests/f-pairing-client.test.mjs`:

```js
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

test('a first-device pair yields a device token the gateway would accept', async () => {
  const nonce = 'a'.repeat(64);
  let connected = null;
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: b && b.publicKey ? deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) : '' } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => { connected = b; return { status: 200, body: { ok: true, deviceId: b.deviceId, token: 'dev_tok_1' } }; },
  });
  const { pairThisBrowser } = await import('../web/ui/pairing.mjs');
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
  assert.deepEqual(verdict, { ok: true }, verdict.reason || '');
  assert.equal(connected.nonce, nonce, 'the challenge nonce must ride the body as well as the payload');
  assert.deepEqual(f.calls.map((c) => c.path),
    ['/devices/pair', '/gateway/connect/challenge', '/gateway/connect'],
    'pair first, then handshake — the connect can only mint a token once the device is approved');
});

test('the signed payload matches buildSignPayload field for field', async () => {
  const nonce = 'b'.repeat(64);
  let connected = null;
  const f = fakeFetch({
    '/devices/pair': (b) => ({ status: 200, body: { ok: true, status: 'approved', deviceId: deviceIdFromPublicKey(Buffer.from(b.publicKey, 'base64')) } }),
    '/gateway/connect/challenge': { status: 200, body: { nonce, ts: Date.now() } },
    '/gateway/connect': (b) => { connected = b; return { status: 200, body: { ok: true, deviceId: b.deviceId, token: 't' } }; },
  });
  const { pairThisBrowser } = await import('../web/ui/pairing.mjs');
  await pairThisBrowser(deps(f.fetch));
  const parts = connected.payload.split('|');
  assert.equal(parts.length, 11, 'buildSignPayload emits exactly 11 fields');
  const rebuilt = buildSignPayload({
    deviceId: parts[1], clientId: parts[2], clientMode: parts[3], role: parts[4],
    scopes: parts[5] ? parts[5].split(',') : [], signedAtMs: parts[6], token: parts[7],
    nonce: parts[8], platform: parts[9], deviceFamily: parts[10],
  });
  assert.equal(connected.payload, rebuilt);
});

test('a pending pair reports PENDING_APPROVAL with the operator instruction, and never claims success', async () => {
  const f = fakeFetch({
    '/devices/pair': { status: 202, body: { ok: true, status: 'pending', deviceId: 'sha256:' + 'c'.repeat(64), requestId: 'pr_1', fingerprint: 'cccccccccccc' } },
  });
  const { pairThisBrowser } = await import('../web/ui/pairing.mjs');
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
  const { pairThisBrowser, resolveApproval } = await import('../web/ui/pairing.mjs');
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
    '/devices/pair': { status: 202, body: { ok: true, status: 'pending', deviceId: 'sha256:' + 'e'.repeat(64), requestId: 'pr_2' } },
  });
  const { resolveApproval } = await import('../web/ui/pairing.mjs');
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
  const { pairThisBrowser, resolveApproval } = await import('../web/ui/pairing.mjs');
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
  const { pairThisBrowser, resolveApproval } = await import('../web/ui/pairing.mjs');
  await pairThisBrowser(d);
  const out = await resolveApproval('ap_4', 'approve', d);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_PAIRED');
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
  const { pairThisBrowser, resolveApproval } = await import('../web/ui/pairing.mjs');
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
  const { pairThisBrowser, resolveApproval } = await import('../web/ui/pairing.mjs');
  await pairThisBrowser(d);
  const out = await resolveApproval('ap_6', 'approve', d);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'READ_ONLY');
});

test('no WebCrypto surfaces as NO_WEBCRYPTO with the loopback instruction', async () => {
  const f = fakeFetch({});
  const { pairThisBrowser } = await import('../web/ui/pairing.mjs');
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
  const { pairThisBrowser, unpairThisBrowser, isPaired } = await import('../web/ui/pairing.mjs');
  await pairThisBrowser(d);
  assert.equal(await isPaired(d), true);
  await unpairThisBrowser(d);
  assert.equal(store.peek(), null);
  assert.equal(await isPaired(d), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/f-pairing-client.test.mjs`
Expected: FAIL — `Cannot find module '.../web/ui/pairing.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `web/ui/pairing.mjs`:

```js
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
const PAYLOAD_VERSION = 'v1';
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
    subtle: deps.subtle !== undefined ? deps.subtle : globalThis.crypto?.subtle,
    store: deps.store,
  };
}

function idDeps(d) {
  return { subtle: d.subtle, ...(d.store ? { store: d.store } : {}) };
}

async function postJson(d, path, body, headers = {}) {
  const r = await d.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed || {} };
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
  if (conn.status === 200 && conn.body.token) {
    held = { deviceId: identity.deviceId, token: conn.body.token };
    return { ok: true, deviceId: identity.deviceId };
  }
  if (conn.status === 403 && conn.body.status === 'pending') {
    return {
      ok: false, code: 'PENDING_APPROVAL', deviceId: identity.deviceId, requestId: conn.body.requestId,
      error: 'this browser is waiting to be approved — run `pompos nodes approve <requestId>`, or approve it from an already-paired device',
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
  if (pair.status === 202 && pair.body.status === 'pending') {
    return {
      ok: false, code: 'PENDING_APPROVAL', deviceId: pair.body.deviceId, requestId: pair.body.requestId,
      fingerprint: pair.body.fingerprint,
      error: `this browser is waiting to be approved (${pair.body.fingerprint || pair.body.deviceId}) — run \`pompos nodes approve ${pair.body.requestId || ''}\`, or approve it from an already-paired device`,
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
    if (!paired.ok) return { ok: false, error: paired.error, code: paired.code === 'PENDING_APPROVAL' ? 'NOT_PAIRED' : paired.code };
  }
  const send = () => postJson(d, '/gateway/exec/resolve', { id, decision }, {
    Authorization: `Bearer ${held.token}`, 'x-device-id': held.deviceId,
  });

  let r = await send();
  if (r.status === 401) {
    // The token expired or was rotated. Re-mint from the key we still hold and
    // try exactly once more; a second 401 means this device is no longer
    // trusted (revoked), which is NOT_PAIRED from the operator's side.
    held = null;
    const again = await pairThisBrowser(deps);
    if (!again.ok) return { ok: false, error: again.error, code: 'NOT_PAIRED' };
    r = await send();
    if (r.status === 401) {
      return { ok: false, code: 'NOT_PAIRED', error: 'this browser is no longer a paired device — pair it again, or approve from the terminal with `pompos nodes`' };
    }
  }
  if (r.status === 200 && r.body.ok) return { ok: true, id: r.body.id, approved: !!r.body.approved };
  return resolveFailure(r.status, r.body);
}
```

- [ ] **Step 4: Correct the api.mjs comment**

`web/ui/api.mjs`'s `apiRaw` comment claims "ALL dashboard requests route through this ... so none bypass the auth gate". That is no longer true, and the exception is deliberate. Extend the comment (do not change any code):

```js
// Single auth-aware fetch primitive: adds the bearer token via withAuth,
// prompts for a token + retries once on 401, returns the raw Response.
// Every request to a DAEMON route goes through here (api/apiSoft + the direct
// export/delete/test/POST call sites) so none bypasses the auth gate. The one
// deliberate exception is web/ui/pairing.mjs's /gateway/* calls: those are
// routed in front of the daemon's bearer gate and their Authorization header
// carries the DEVICE token, so sending the dashboard token there would be the
// wrong credential. Uses globalThis.fetch so this is the only place that
// touches fetch directly.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/f-pairing-client.test.mjs`
Expected: PASS, 11/11. The first test is the one that matters — it proves the browser's payload satisfies the real verifier.

- [ ] **Step 6: Prove the payload test has teeth**

Temporarily swap two adjacent fields in `buildPayload` (e.g. `safe(PLATFORM)` and `safe(DEVICE_FAMILY)`), re-run, and confirm the first test FAILS with `verifyConnect`'s own reason. Restore and re-run to green.

- [ ] **Step 7: Commit**

```bash
git add web/ui/pairing.mjs web/ui/api.mjs tests/f-pairing-client.test.mjs
git commit -m "feat(dashboard): pair the browser and resolve approvals as a device

Drives the existing gateway handshake from the browser: pair, take a challenge,
sign it with the non-extractable key, and collect a device token. The token is
never persisted — it is held in memory and re-minted from the key when missing
or rejected, so there is no long-lived credential at rest and a revoked device
simply stops being able to mint one.

Every failure path is named and returned: a pending device reports the exact
pompos nodes command that unblocks it, a surviving 401 reports NOT_PAIRED, and
resolving without a paired device sends no resolve at all rather than pretend
an agent was unblocked."
```

---

### Task 4: Wire the panels

**Files:**
- Modify: `web/ui/panels/approvals.mjs` (replace the read-only banner; enable Approve/Deny)
- Modify: `web/ui/panels/gateway.mjs` (pair / forget this browser)
- Modify: `daemon/routes/gateway_views.mjs` (its header comment is now stale)
- Test: `tests/f-approvals-panel-resolve.test.mjs`

**Interfaces:**
- Consumes: `pairThisBrowser`, `resolveApproval`, `unpairThisBrowser` from `web/ui/pairing.mjs` (Task 3); `el`, `phead`, `chip`, `banner` from `web/ui/dom.mjs`; `api` from `web/ui/api.mjs`.
- Produces: `export function _decide(tr, a, id, decision, deps)` from `web/ui/panels/approvals.mjs` — the click handler's body, exported so the failure rendering is testable without a browser. Returns `Promise<void>`; it mutates the row.

**Behaviour, three outcomes and no others.** On success: disable both buttons, mark the row resolved, and let the existing SSE `exec.approval.resolved` refresh drop it. On failure: re-enable the buttons and show the `error` in the row's action cell — never remove the row, because the agent is still blocked. On `NOT_PAIRED`: the same, plus a "Pair this browser" button in the message so the fix is one click away.

- [ ] **Step 1: Write the failing test**

Create `tests/f-approvals-panel-resolve.test.mjs`:

```js
// tests/f-approvals-panel-resolve.test.mjs — the row's three outcomes.
//
// The failure paths matter more than the success one: a resolve that could not
// happen must leave the row actionable and say why. A row that disappears on
// failure tells the operator an agent was unblocked when it is still waiting —
// the exact defect class this project keeps producing.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

// The smallest DOM that dom.mjs's el() needs — same approach as
// tests/f-panel-write-guard.test.mjs (no jsdom in this repo).
class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = new Map();
    this.textContent = ''; this.className = ''; this.disabled = false;
    this.style = { cssText: '', setProperty() {} }; this.listeners = new Map();
  }
  append(...kids) { for (const k of kids) if (k != null) this.children.push(k); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(t, fn) { this.listeners.set(t, fn); }
  replaceChildren(...kids) { this.children = kids.filter((k) => k != null); }
  querySelector(sel) {
    const want = /\[data-f="([^"]+)"\]/.exec(sel);
    const hit = (n) => (want ? n.attrs && n.attrs.get('data-f') === want[1] : false);
    const walk = (n) => {
      for (const k of n.children || []) { if (hit(k)) return k; const deep = walk(k); if (deep) return deep; }
      return null;
    };
    return walk(this);
  }
  get text() {
    const own = this.textContent || '';
    return own + (this.children || []).map((k) => (typeof k === 'string' ? k : (k && k.text) || '')).join('');
  }
}
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = t; return n; },
};

function row() {
  const tr = new FakeNode('tr');
  const cell = new FakeNode('td');
  cell.setAttribute('data-f', 'actions');
  tr.append(cell);
  return tr;
}

test('a successful approve disables the buttons and never re-enables them', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  await _decide(tr, { id: 'ap_1' }, 'ap_1', 'approve', {
    resolveApproval: async () => ({ ok: true, id: 'ap_1', approved: true }),
  });
  const cell = tr.querySelector('[data-f="actions"]');
  assert.match(cell.text, /approved/i);
  const buttons = cell.children.filter((c) => c.tagName === 'button');
  assert.equal(buttons.every((b) => b.disabled === true || b.getAttribute('disabled')), true);
});

test('a failed resolve shows the error and leaves the row actionable', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  await _decide(tr, { id: 'ap_2' }, 'ap_2', 'approve', {
    resolveApproval: async () => ({ ok: false, code: 'APPROVAL_GONE', error: 'that approval is already resolved or has expired' }),
  });
  const cell = tr.querySelector('[data-f="actions"]');
  assert.match(cell.text, /already resolved or has expired/);
  const buttons = cell.children.filter((c) => c.tagName === 'button' && /Approve|Deny/.test(c.text));
  assert.ok(buttons.length >= 2, 'the operator must still be able to try again');
  assert.equal(buttons.some((b) => b.disabled === true), false);
});

test('NOT_PAIRED offers pairing inline instead of a bare error', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  let paired = 0;
  await _decide(tr, { id: 'ap_3' }, 'ap_3', 'approve', {
    resolveApproval: async () => ({ ok: false, code: 'NOT_PAIRED', error: 'this browser is not a paired device' }),
    pairThisBrowser: async () => { paired += 1; return { ok: true, deviceId: 'sha256:x' }; },
  });
  const cell = tr.querySelector('[data-f="actions"]');
  const pairBtn = cell.children.find((c) => c.tagName === 'button' && /Pair this browser/i.test(c.text));
  assert.ok(pairBtn, 'the one action that fixes NOT_PAIRED must be one click away');
  await pairBtn.listeners.get('click')({ preventDefault() {} });
  assert.equal(paired, 1);
});

test('a thrown resolve is reported, not swallowed', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  await _decide(tr, { id: 'ap_4' }, 'ap_4', 'deny', {
    resolveApproval: async () => { throw new Error('network down'); },
  });
  assert.match(tr.querySelector('[data-f="actions"]').text, /network down/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/f-approvals-panel-resolve.test.mjs`
Expected: FAIL — `_decide` is not exported from `web/ui/panels/approvals.mjs`.

- [ ] **Step 3: Rewrite the panel's banner and row**

In `web/ui/panels/approvals.mjs`:

Replace the module header comment:

```js
// web/ui/panels/approvals.mjs — pending approvals for gated agent actions.
// Resolving one is gated on a paired device's Ed25519 token; this browser
// becomes one via web/ui/pairing.mjs, which mints a device token from a
// non-extractable key kept in IndexedDB. A bearer token alone still cannot
// resolve anything — that is the point of the gate.
```

Add the import:

```js
import { resolveApproval as resolveViaDevice, pairThisBrowser } from '../pairing.mjs';
```

Replace the `banner('warn', …)` block in `render()` with:

```js
  host.append(banner('info', 'i', el('b', { text: 'Approving from here pairs this browser. ' }),
    'The first decision generates an Ed25519 key for this browser and pairs it as a device; ',
    'the private key never leaves the browser and cannot be exported. ',
    'You can also approve with ', el('code', { text: 'pompos nodes' }), '.'));
```

Replace `createRow`'s action cell and add the handler. The whole cell is rebuilt by `_decide`, so `renderActions` is the single place its contents are defined:

```js
// The action cell, rebuilt in place by _decide so success, failure and the
// not-paired prompt all render through one function.
function renderActions(cell, a, { message = '', pair = false, done = '' } = {}) {
  const kids = [];
  if (done) {
    kids.push(chip(done, done === 'approved' ? 'ok' : 'warn'));
    for (const label of ['Approve', 'Deny']) {
      kids.push(el('button', { class: 'btn btn-secondary', type: 'button', disabled: true, text: label }));
    }
  } else {
    for (const [label, decision] of [['Approve', 'approve'], ['Deny', 'deny']]) {
      const b = el('button', { class: 'btn btn-secondary', type: 'button', text: label });
      b.addEventListener('click', () => { _decide(cell.parentNode || cell, a, a.id, decision); });
      kids.push(b);
    }
  }
  if (message) kids.push(el('div', { class: 'err-inline', text: message }));
  if (pair) {
    const b = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Pair this browser' });
    b.addEventListener('click', async () => {
      const out = await pairThisBrowser();
      renderActions(cell, a, out.ok ? {} : { message: out.error, pair: out.code !== 'PENDING_APPROVAL' });
    });
    kids.push(b);
  }
  cell.replaceChildren(...kids);
}

/**
 * Answer one approval. Exported for tests; `deps` swaps the two network calls.
 * Three outcomes and no others: resolved (buttons stay disabled, SSE drops the
 * row), failed (buttons come back plus the reason — the agent is STILL blocked,
 * so the row must not vanish), or not paired (the same, plus a pair button).
 */
export async function _decide(tr, a, id, decision, deps = {}) {
  const resolve = deps.resolveApproval || resolveViaDevice;
  const pair = deps.pairThisBrowser || pairThisBrowser;
  const cell = tr.querySelector('[data-f="actions"]');
  if (!cell) return;
  cell.replaceChildren(el('span', { class: 'muted', text: decision === 'approve' ? 'Approving…' : 'Denying…' }));
  let out;
  try { out = await resolve(id, decision); }
  catch (e) { out = { ok: false, code: 'RESOLVE_FAILED', error: e && e.message ? e.message : String(e) }; }
  if (out && out.ok) {
    renderActionsWith(cell, a, pair, { done: out.approved ? 'approved' : 'denied' });
    return;
  }
  renderActionsWith(cell, a, pair, { message: out.error || 'the decision could not be delivered', pair: out.code === 'NOT_PAIRED' });
}

// renderActions with the pair function injected, so _decide's tests can swap it.
function renderActionsWith(cell, a, pairFn, opts) {
  const prev = pairThisBrowserRef;
  pairThisBrowserRef = pairFn;
  try { renderActions(cell, a, opts); } finally { pairThisBrowserRef = prev; }
}
let pairThisBrowserRef = pairThisBrowser;
```

Then in `renderActions`, call `pairThisBrowserRef()` rather than `pairThisBrowser()`.

In `createRow`, replace the two hardcoded-`disabled` buttons with the live cell:

```js
function createRow(a) {
  const tr = el('tr', { '--i': a.i, 'data-approval': a.id },
    el('td', {}, el('code', { text: a.tool || '' })),
    el('td', {}, a.agentId || ''),
    el('td', { class: 'mono' }, a.summary || ''),
    el('td', { 'data-f': 'remaining' }),
    el('td', { 'data-f': 'actions' }));
  updateRemaining(tr, a);
  renderActions(tr.querySelector('[data-f="actions"]'), a);
  return tr;
}
```

- [ ] **Step 4: Run the panel tests to verify they pass**

Run: `node --test tests/f-approvals-panel-resolve.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 5: Add the pair controls to the devices panel**

In `web/ui/panels/gateway.mjs`, add the import and a control row under the existing `note-inline` block:

```js
import { pairThisBrowser, unpairThisBrowser } from '../pairing.mjs';
```

```js
  // This browser can be a device too. Pairing is idempotent, so the button is
  // safe to press twice; forgetting only drops the LOCAL key — the server-side
  // record stays until `pompos nodes revoke` removes it.
  const status = el('span', { class: 'muted', text: '' });
  const pairBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Pair this browser' });
  pairBtn.addEventListener('click', async () => {
    status.replaceChildren(el('span', { class: 'muted', text: 'Pairing…' }));
    const out = await pairThisBrowser();
    status.replaceChildren(out.ok
      ? chip('paired: ' + out.deviceId.slice(7, 19), 'ok')
      : el('span', { class: 'err-inline', text: out.error }));
  });
  const forgetBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: "Forget this browser's key" });
  forgetBtn.addEventListener('click', async () => {
    await unpairThisBrowser();
    status.replaceChildren(el('span', { class: 'muted', text: "this browser's key is gone; pairing again makes a new device. Revoke the old record with `pompos nodes revoke`." }));
  });
  host.append(el('div', { class: 'row-actions' }, pairBtn, forgetBtn, status));
```

- [ ] **Step 6: Correct the stale comment in gateway_views.mjs**

Replace the "Read-only on purpose … future work" paragraph in `daemon/routes/gateway_views.mjs`'s header with:

```js
// Read-only on purpose, and it stays that way. resolveApproval() is an
// in-process function, so a daemon route could call it — and would thereby
// bypass the Ed25519 device gate that protects it over HTTP. The dashboard
// resolves approvals as a properly paired device instead, through the
// gateway's own POST /gateway/exec/resolve (see web/ui/pairing.mjs); there is
// deliberately no daemon-side twin of that route to drift from it.
```

- [ ] **Step 7: Run the full unit suite**

Run:

```bash
node --test tests/*.test.mjs 2>&1 | tail -20
node scripts/lint-file-size.mjs
```

Expected: the same pass count as before this task plus the new tests; zero failures; the size gate clean. If `f-dashboard-pack-contents.test.mjs` fails, the two new `web/ui/*.mjs` files need adding to whatever manifest it checks — do that.

- [ ] **Step 8: Commit**

```bash
git add web/ui/panels/approvals.mjs web/ui/panels/gateway.mjs daemon/routes/gateway_views.mjs tests/f-approvals-panel-resolve.test.mjs
git commit -m "feat(dashboard): resolve approvals from the browser

The Approvals panel's buttons were hardcoded disabled because resolving is
gated on a paired device. They now work: the first decision pairs this browser
and mints a device token, and the decision goes to the gateway's own
device-gated resolve route.

Failure is rendered, never hidden. A resolve that could not happen leaves the
row actionable with the reason attached, because the agent is still blocked; a
NOT_PAIRED failure offers pairing inline instead of a bare error."
```

---

### Task 5: The E2E approval step, unblocked

**Files:**
- Modify: `tests/phaseI-dashboard-operations.spec.ts` (the step-3 block near line 285, and the caveat paragraph in the file banner near line 65)

**Interfaces:**
- Consumes: everything from Tasks 1-4, plus `POST /exec/request` (`daemon/routes/conversation_bridge.mjs`) — the bearer-gated route that raises a real gateway approval and long-polls for the decision, returning `{ id, approved, by, reason }`.

**What changes and why.** Phase 2's step 3 was attempted with `expect.soft` for three source-confirmed reasons. Two are now fixed (the device gate, the disabled buttons). The third is not and is out of scope: the task/team loop's own approval hook (`tui/slash_dispatcher.mjs`'s `_makeInkApprove`) and the gateway's exec-approval registry are still unconnected systems, so no task tick will ever populate this panel. So the scenario raises the approval the way the daemon's own approval path does — `POST /exec/request`, fired without awaiting — then answers it from the browser and asserts the waiting requester was actually released. That is a stronger assertion than the original: it proves request → SSE → panel → browser decision → requester unblocked, end to end.

- [ ] **Step 1: Replace the step-3 block**

Replace the block from `// 3. Answer the approval request inline` through the closing brace of `if (await approval.count()) { … }` with:

```ts
    // 3. Answer a real approval request from the browser. The approval is
    // raised through POST /exec/request — the daemon's own approval path,
    // which long-polls until a paired device decides — because the task/team
    // loop's approval hook and the gateway's exec-approval registry are still
    // two unconnected systems (see the file banner). Nothing is stubbed: the
    // decision travels browser → device token → gateway → the waiting
    // requester, and the requester's own answer is what this step asserts.
    const pending = fetch(`http://127.0.0.1:${port}/exec/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ tool: 'bash', args: { cmd: 'rm -rf ./build' }, agentId: 'dev', summary: 'delete the build directory' }),
    }).then((r) => r.json());

    await nav(page, 'approvals');
    const approval = page.locator('[data-approval]').first();
    await expect(approval).toBeVisible({ timeout: 10_000 });
    await expect(approval).toContainText('delete the build directory');

    const approveBtn = approval.getByRole('button', { name: 'Approve', exact: true });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();

    // The requester is released with the decision AND the identity that made
    // it — `by` is the paired deviceId, which is the proof the browser acted
    // as a device rather than as a bearer-token holder.
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.by).toMatch(/^sha256:[0-9a-f]{64}$/);

    // And the browser really is on the device roster now.
    await nav(page, 'gateway');
    await expect(page.locator('#host')).toContainText(decision.by.slice(0, 19), { timeout: 5_000 });
```

If the spec file does not already hold the daemon port and auth token in variables named `port` / `AUTH_TOKEN`, use whatever it does name them — read the file's daemon-startup block and match it exactly rather than introducing new names.

- [ ] **Step 2: Rewrite the file banner's approval caveat**

Replace the "The Approvals panel cannot answer an approval request from the browser, for three independent reasons …" paragraph (near line 65) with:

```ts
//   - The Approvals panel CAN now answer an approval request: this browser
//     pairs itself as an Ed25519 device (web/ui/pairing.mjs) and posts the
//     decision to the gateway's own device-gated resolve route. Two of the
//     three former blockers are gone (the device gate, and the hardcoded
//     `disabled` buttons). The third remains and is why step 3 raises its own
//     approval: the task/team loop's approval hook (tui/slash_dispatcher.mjs's
//     _makeInkApprove, used by /task tick) and the gateway's exec-approval
//     registry (what GET /approvals and this panel show) are still entirely
//     unconnected, so no task turn in this scenario can populate the panel.
//     Step 3 therefore raises a real approval through POST /exec/request — the
//     daemon's own approval path — and asserts the long-polling requester is
//     released with the paired deviceId as `by`. Nothing is soft-asserted.
```

- [ ] **Step 3: Run the scenario**

Run: `npx playwright test tests/phaseI-dashboard-operations.spec.ts --reporter=line`
Expected: PASS with no soft failures. If the approval row does not appear, check the SSE `exec.approval.requested` broadcast reached the page (the panel's module-level `subscribe` refreshes the badge; the panel's own `load()` polls `GET /approvals`) — the fix is a `load()` on that event, not a longer timeout.

- [ ] **Step 4: Run the whole Playwright suite for collateral damage**

Run: `npx playwright test --reporter=line 2>&1 | tail -25`
Expected: the pre-existing pass count, with the previously-failing approval step now passing. The known load-dependent flakes are `cold-start: pompos version <= 400ms`, `recall on 10k rows`, `E1 concurrency`, `v53-slash-exit`/Editor, and phase6 SIGINT — re-run any of those individually before treating it as a regression.

- [ ] **Step 5: Commit**

```bash
git add tests/phaseI-dashboard-operations.spec.ts
git commit -m "test(e2e): the approval step now passes for real

Phase 2 left this step failing with expect.soft for three source-confirmed
reasons. Two are fixed by the pairing flow. The third — the task loop's
approval hook and the gateway's approval registry being unconnected — is out of
scope, so the scenario raises its own approval through POST /exec/request, the
daemon's own approval path, and answers it from the browser.

The assertion is stronger than the original: it checks the long-polling
requester was released and that `by` is the paired deviceId, which is what
proves the browser acted as a device and not as a bearer-token holder."
```

---

### Task 6: Document the flow

**Files:**
- Modify: `README.md` (the dashboard section)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1-5.

Per §5.5 of the project's engineering directives this is a user-facing feature — a new route, a new browser capability, and a new operator action — so the README must change.

- [ ] **Step 1: Add the README subsection**

Find the dashboard section in `README.md` and add, matching the surrounding heading level and prose style:

```markdown
### Approving from the dashboard

Resolving an approval requires a paired device, not just the dashboard's auth
token. The browser can be that device: the first time you press **Approve** (or
the **Pair this browser** button on the Devices panel) it generates an Ed25519
keypair, keeps the private half in the browser as a non-extractable key, and
pairs itself with the daemon.

- The **first** device is approved automatically when it pairs over loopback —
  otherwise there would be no one to approve it.
- Every device after that is `pending` until an already-paired device or
  `pompos nodes approve <requestId>` approves it.
- The private key cannot be exported, backed up, or moved to another browser.
  Pairing again from a new browser is the recovery path; drop the old record
  with `pompos nodes revoke <deviceId>`.
- WebCrypto only exists on a secure origin, so pairing works on
  `http://localhost` / `http://127.0.0.1` and over HTTPS. On a plain-HTTP LAN
  address the panel says so and points you at `pompos nodes`.
```

- [ ] **Step 2: Add the CHANGELOG entry**

Under the `Unreleased` heading (Keep a Changelog format, English):

```markdown
### Added
- The dashboard can pair itself as an Ed25519 device and resolve exec approvals
  from the browser. `POST /devices/pair` approves the first device
  automatically over loopback and leaves every later one pending, so a stolen
  auth token cannot enrol a second approver. The browser's private key is
  non-extractable and never leaves the browser; its device token is held in
  memory and re-minted on demand rather than stored.
```

- [ ] **Step 3: Verify the docs match the code**

Re-read both edits against `daemon/routes/devices_pair.mjs` and `web/ui/pairing.mjs`. Every claim must be one the code makes true — check specifically: loopback-only, first-device-only, non-extractable, token not persisted, and the secure-origin requirement.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: how the dashboard pairs itself and approves"
```

---

## Self-review

**Spec coverage.** `web/ui/device_identity.mjs` → T1. `web/ui/pairing.mjs` → T3. `POST /devices/pair` and the bootstrap rule → T2. The resolve route → reused, deviation 1, wired in T3/T4. Panel changes and the `NOT_PAIRED` prompt → T4. The bootstrap race → T2 step 6 (with the load-ordering fix that is the actual cause). Every test the spec's Testing section lists has a home: deviceId agreement (T1), non-extractability (T1), the three bootstrap cases (T2), the concurrent race (T2), resolve success / `NOT_PAIRED` / revoked / `APPROVAL_GONE` (T3), "a bearer token WITHOUT a device token cannot resolve" (T3, asserted as *no resolve request is sent at all*), E2E (T5). Non-goals respected: no roles, no scopes, no key backup, revocation stays CLI.

**Deviations recorded** at the top: no `POST /approvals/:id/resolve`, no `DEVICE_REVOKED`/`TOKEN_EXPIRED`, no persisted device token. Each has a source-level reason.

**Type consistency.** `getOrCreateIdentity` returns `{deviceId, publicKeyDerBase64}` everywhere it appears; `sign` takes and returns `Uint8Array` and is base64-encoded only at the call site; `pairThisBrowser`/`resolveApproval` return the `{ok:true,…}` / `{ok:false,error,code}` pair uniformly; the store contract is `{get,put,del}` in the module, the fake, and the doc block alike; `fingerprint` is `deviceId.slice(7, 19)` in the route, the route test, and the panel.

**One thing the implementer of Task 4 must watch.** `renderActions` reads `pairThisBrowserRef`, which `renderActionsWith` swaps for the duration of a synchronous call. That is deliberate — it is the smallest way to make the pair button injectable without threading a deps object through every call site — but it only works because `renderActions` is synchronous. Do not make it async.
