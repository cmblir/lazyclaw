// web/ui/panels/gateway.mjs — paired devices for the companion-node gateway.
// Read-only: approve/revoke/rotate happen via `pompos nodes`, never here —
// see daemon/routes/gateway_views.mjs for why.
import { el, phead, chip, table, kvlist } from '../dom.mjs';
import { api } from '../api.mjs';
import { pairThisBrowser, unpairThisBrowser } from '../pairing.mjs';

const REQUEST_COLS = [
  { key: 'deviceId', label: 'Device' },
  { key: 'platform', label: 'Platform' },
  { key: 'label', label: 'Label' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
  { key: 'createdAt', label: 'Requested' },
];

const DEVICE_COLS = [
  { key: 'deviceId', label: 'Device' },
  { key: 'platform', label: 'Platform' },
  { key: 'label', label: 'Label' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
  { key: 'approvedAt', label: 'Approved' },
];

function requestRow(r) {
  return {
    deviceId: el('code', { text: r.deviceId }),
    platform: r.platform || '—',
    label: r.label || '—',
    role: r.role || '—',
    status: chip(r.status || 'pending', 'warn'),
    createdAt: String(r.createdAt || '').slice(0, 19),
  };
}

// A device's paired/expired state is never colour-alone — the chip always
// carries the word too. Deliberately no tokenMasked column here: deviceId is
// already the canonical identifier, so a masked token would add exposure
// without adding a way to tell devices apart. The field stays in the route's
// JSON response (see daemon/routes/gateway_views.mjs) — the brief's own test
// pins its width — it just is not rendered.
function deviceRow(d) {
  const expired = typeof d.expiresAt === 'number' && Date.now() >= d.expiresAt;
  return {
    deviceId: el('code', { text: d.deviceId }),
    platform: d.platform || '—',
    label: d.label || '—',
    role: d.role || '—',
    status: expired ? chip('expired', 'err') : chip('paired', 'ok'),
    approvedAt: String(d.approvedAt || '').slice(0, 19),
  };
}

export async function render(host) {
  host.append(phead('Devices', 'Devices paired to this gateway, and requests waiting on pompos nodes approve.'));

  host.append(el('div', { class: 'note-inline' },
    el('b', { text: 'Two things are called “gateway”. ' }),
    'The device gateway runs ', el('em', { text: 'inside' }), ' this daemon (',
    el('code', { text: 'createGateway()' }), ', routed before the shared auth-token gate). ',
    el('code', { text: 'commands/gateway.mjs' }),
    ' is a separate long-lived process that runs the channels behind its own pidfile.'));

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

  let shown = el('div', { class: 'empty', text: 'Loading…' });
  host.append(shown);

  try {
    const data = await api('/devices');
    const requests = Array.isArray(data.requests) ? data.requests : [];
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const sse = data.sse || { open: 0, maxGlobal: 0, maxPerDevice: 0 };
    const frac = sse.maxGlobal ? Math.max(0, Math.min(1, sse.open / sse.maxGlobal)) : 0;

    const body = el('div', {},
      el('h3', { class: 'dim', style: 'margin:8px 0 4px;', text: 'Pending pairing requests' }),
      requests.length
        ? table(REQUEST_COLS, requests.map(requestRow))
        : el('div', { class: 'empty' }, 'No pairing requests waiting. Pair one with ', el('code', { text: 'pompos nodes pair' }), '.'),

      el('h3', { class: 'dim', style: 'margin:14px 0 4px;', text: 'Paired devices' }),
      devices.length
        ? table(DEVICE_COLS, devices.map(deviceRow))
        : el('div', { class: 'empty', text: 'No devices paired yet.' }),

      el('h3', { class: 'dim', style: 'margin:14px 0 4px;', text: 'Event-stream capacity' }),
      el('div', { class: 'card' },
        kvlist([
          ['Open streams', `${sse.open} / ${sse.maxGlobal}`],
          ['Per-device cap', String(sse.maxPerDevice)],
        ]),
        el('div', { class: 'meter' }, el('i', { class: frac > 0.85 ? 'warn' : '', style: `transform: scaleX(${frac})` }))));

    shown.replaceWith(body);
    shown = body;
  } catch (e) {
    const errNode = el('div', { class: 'empty', text: 'Error: ' + e.message });
    shown.replaceWith(errNode);
    shown = errNode;
  }
}
