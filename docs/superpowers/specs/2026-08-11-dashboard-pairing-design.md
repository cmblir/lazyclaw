# Dashboard Pairing & Approval — Design

**Goal:** the dashboard becomes a paired device, so an operator can answer an approval request from the browser instead of the terminal.

**Why this shape.** Phase 2 left one step of its own done bar failing: the Approvals panel's buttons are hardcoded `disabled`, because resolving an approval is gated on an Ed25519-paired device and a browser is not one. Two ways out were on the table — declare the token-bearing browser an approver, or make the browser a real paired device. The second was chosen: approval is the heaviest authority in this system, and collapsing it into "whoever holds the bearer token" would erase a distinction the pairing machinery exists to draw.

## Decisions locked during brainstorming

| Axis | Decision |
|---|---|
| Key storage | A non-extractable Ed25519 `CryptoKey` generated with WebCrypto and kept in IndexedDB. JS cannot read the private bytes, so XSS or a leaked bearer token cannot impersonate the device. The cost — no backup, no transfer between browsers — is paid by re-pairing, which is cheap. |
| Bootstrap | Loopback auto-approve **only while no device is paired at all**. That resolves the chicken-and-egg (the first device has no approver) with zero friction, and stops there. |
| Every later device | `pending`, approved by an already-paired device or by `pompos nodes approve`. A stolen bearer token therefore cannot silently enrol a second approver. |
| Existing security model | Unchanged. `gateway/device_auth.mjs`'s handshake, identity binding, nonce ledger and token rotation are reused as-is, not re-implemented. |

The bootstrap rule is the load-bearing one. Without the "only while no device is paired" clause, loopback auto-approve would make the non-extractable key pointless: an attacker with the bearer token could not steal the existing device's identity, but could mint a fresh approver of their own. The clause is what makes the two decisions coherent rather than cancelling.

## What already exists (reused, not rebuilt)

- `gateway/device_auth.mjs` — `deviceIdFromPublicKey` (`sha256:<hex>` of the DER SPKI bytes), `createChallenge`, `buildSignPayload`, `parsePayload`, `verifyConnect`, `ChallengeRegistry`, and `PairingStore` with `requestPairing`, `approve(requestId)`, `isApproved`, `tokenFor`, `verifyToken`, `revoke`, `rotate`, `pending`, `pendingForDevice`, `devicesList`, `deviceInfo`.
- `gateway/http_gateway.mjs` — the handshake as two POSTs on the same daemon: `POST /gateway/connect/challenge` → `{nonce, ts}`, then `POST /gateway/connect` with `{payload, signature, publicKey, nonce}`. A device's token arrives on connect and is never printed to a terminal.
- `GET /devices` (`daemon/routes/gateway_views.mjs`) and `GET /approvals` — both read-only today.
- `pompos nodes pending|approve|revoke` (`commands/auth_nodes.mjs`) — the CLI approver.

Nothing above changes shape. This phase adds a browser-side identity and the two routes the browser needs to act.

## Architecture

**Browser side — `web/ui/device_identity.mjs`**

One module owning the device identity:

- `getOrCreateIdentity()` → `{ deviceId, publicKeyDer }`. Generates a non-extractable Ed25519 keypair on first call, stores the `CryptoKey` pair in IndexedDB under a fixed key, and derives `deviceId` the same way the server does — SHA-256 of the exported SPKI DER. The PUBLIC key is extractable; only the private key is not.
- `sign(payloadBytes)` → signature bytes, via `crypto.subtle.sign('Ed25519', privateKey, …)`.
- `forgetIdentity()` → deletes the stored pair, for an explicit "unpair this browser" action.

**Verified before writing this spec**, since the whole design rests on it: a key generated with `crypto.subtle.generateKey('Ed25519', false, …)` yields `privateKey.extractable === false` and `exportKey('pkcs8', privateKey)` throws `InvalidAccessException`; `sign('Ed25519', …)` produces 64 bytes; and the browser's `SHA-256` of the exported SPKI matches `deviceIdFromPublicKey`'s output for the same key, byte for byte.

`deviceId` must be computed from the same bytes the server hashes. The server accepts PEM or DER and normalises to DER SPKI; the browser exports `spki` directly, so both hash identical input. A test pins that a key exported from WebCrypto and hashed in the browser yields the same id `deviceIdFromPublicKey` produces for the same key.

**Browser side — `web/ui/pairing.mjs`**

Drives the handshake against the existing routes: request a challenge, build the payload with `buildSignPayload`'s shape, sign it, POST `/gateway/connect`, and keep the returned device token separately from the dashboard's bearer token — they authenticate different things and must not be conflated.

**Server side — two new routes**

```
POST /devices/pair        { publicKey, platform, label }
  -> { status: 'approved', deviceId }        first device on loopback
  -> { status: 'pending', requestId, deviceId, fingerprint }   otherwise
POST /approvals/:id/resolve   { decision: 'approve'|'deny' }
  -> { ok: true, id, decision }
```

`POST /devices/pair` calls `requestPairing`, then applies the bootstrap rule: if `devicesList()` is empty AND the request arrived over loopback, call `approve(requestId)` immediately and say so. Otherwise leave it pending. The loopback test must inspect the socket's remote address, not a header — `X-Forwarded-For` is attacker-controlled.

`POST /approvals/:id/resolve` requires a paired device: the request carries the device token, `verifyToken(deviceId, token, now)` must pass, and only then does the approval resolve. A bearer token alone is not sufficient — that is the whole point of the phase.

**Approvals panel** loses its `disabled` attributes and gains the two buttons wired to the resolve route, plus a "pair this browser" affordance when the browser is not yet a paired device. A `NOT_PAIRED` response renders as an actionable prompt to pair rather than a bare error.

## The bootstrap race

Two browsers hitting `POST /devices/pair` simultaneously on a fresh install could both see an empty `devicesList()` and both auto-approve. `PairingStore`'s writes go through `withKeyedLockSync`, but the read-then-decide is ours. The check and the approve must happen inside one critical section keyed on the store, and a test must drive two concurrent pair requests against an empty store and assert exactly one is approved.

## Error envelopes

The resolve route reuses the daemon's existing shape rather than inventing one: `{ok:false, error, code}` with `NOT_PAIRED` (no device token, or unknown device), `DEVICE_REVOKED`, `TOKEN_EXPIRED`, and `APPROVAL_GONE` (already resolved or expired). Each names what the operator must do next; a resolve that cannot happen must never report success — the phase before this one found a dozen instances of exactly that, and the same rule applies here.

## Testing

- `deviceId` agreement between browser export and `deviceIdFromPublicKey`
- non-extractability: the stored private key rejects `exportKey`
- bootstrap: first loopback request auto-approves; the second is pending; a non-loopback first request is pending
- the concurrent-bootstrap race: exactly one approval
- resolve: succeeds with a valid device token; `NOT_PAIRED` without one; `NOT_PAIRED` for a revoked device; `APPROVAL_GONE` for an already-resolved id
- a bearer token WITHOUT a device token cannot resolve — asserted explicitly, since it is the security claim
- E2E: pair the browser, then complete the approval step that phase 2's done bar could not, removing the `expect.soft`

## Non-goals

Multi-operator roles, per-device scopes beyond what `PairingStore` already records, key backup or transfer, and approving from a device that is not the dashboard. Revocation stays a CLI action (`pompos nodes revoke`); the dashboard only lists devices.

## File map

- create: `web/ui/device_identity.mjs`, `web/ui/pairing.mjs`, `daemon/routes/devices_pair.mjs`, `daemon/routes/approvals_resolve.mjs`
- modify: `daemon/route_table.mjs` (+2 routes), `web/ui/panels/approvals.mjs`, `web/ui/panels/devices.mjs`
- test: `tests/f-device-identity.test.mjs`, `tests/f-devices-pair.test.mjs`, `tests/f-approvals-resolve.test.mjs`, and the phase-2 E2E's approval step
