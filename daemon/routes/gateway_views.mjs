// daemon/routes/gateway_views.mjs — read-only windows onto the device gateway.
//
// These are deliberately NOT under /gateway/. daemon.mjs routes every request
// whose path starts with `/gateway/` to the device gateway's own handler,
// which would 404 anything the route table added there. They sit behind the
// daemon's normal auth-token gate instead.
//
// Read-only on purpose. resolveApproval() is an in-process function, so a
// daemon route could call it — and would thereby bypass the Ed25519 device
// gate that protects it over HTTP. Making the dashboard a properly paired
// device is future work; until then this surface observes and does not act.
import { writeJson } from './_deps.mjs';
import { PairingStore } from '../../gateway/device_auth.mjs';

export async function approvalsList(c) {
  const { gateway, res } = c;
  const pending = (gateway && typeof gateway.pendingApprovals === 'function')
    ? gateway.pendingApprovals()
    : [];
  // pendingApprovals() already returns approvalView()'s redacted, capped
  // summary — do not enrich it here.
  return writeJson(res, 200, { pending });
}

// Pairing requests never carry a token (PairingStore.requestPairing never
// mints one), so a request record is safe to forward field-by-field.
function publicRequest(r) {
  return {
    requestId: r.requestId,
    deviceId: r.deviceId,
    platform: r.platform || '',
    label: r.label || '',
    role: r.role || '',
    status: r.status,
    createdAt: r.createdAt,
  };
}

// devices.json holds plaintext bearer tokens. devicesList() returns exactly
// { deviceId, platform, label, approvedAt, tokenMasked } — no role, scopes,
// or expiresAt; those live only on deviceInfo(deviceId). Each entry is
// merged with its deviceInfo() so the dashboard can show role, but only the
// named fields are taken from it (never spread wholesale) so a field added
// to the store later does not silently start shipping to every client.
// tokenMasked is forwarded as-is from devicesList() — it is already the
// token's first 6 / last 4 characters, meant for an operator to correlate a
// device with a token they hold; it is not the token itself.
function publicDevice(d, info) {
  return {
    deviceId: d.deviceId,
    platform: d.platform || '',
    label: d.label || '',
    role: (info && info.role) || '',
    scopes: Array.isArray(info && info.scopes) ? info.scopes : [],
    approvedAt: d.approvedAt || null,
    expiresAt: (info && info.expiresAt) || null,
    tokenMasked: d.tokenMasked || '',
  };
}

export async function devicesList(c) {
  const { gwConfigDir, gateway, res } = c;
  const store = new PairingStore(gwConfigDir);
  const streams = (gateway && gateway.sseClients) ? gateway.sseClients.size : 0;
  return writeJson(res, 200, {
    requests: store.pending().map(publicRequest),
    devices: store.devicesList().map((d) => publicDevice(d, store.deviceInfo(d.deviceId))),
    sse: { open: streams, maxGlobal: 256, maxPerDevice: 8 },
  });
}
