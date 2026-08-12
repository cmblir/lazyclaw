// tests/f-gateway-panel.test.mjs — the Devices panel's own behaviour.
//
// This panel had zero automated coverage while carrying the pair/forget click
// guards, the paired-state chip, and the empty-state copy that told operators
// to run a `pompos nodes` subcommand which does not exist. Everything here goes
// through the real render() with the two pairing calls injected (the same `deps`
// convention web/ui/panels/approvals.mjs's _decide uses), because the real ones
// need WebCrypto plus IndexedDB.
//
// Smallest possible DOM stub — there is no jsdom in this repo (same approach as
// tests/f-panel-write-guard.test.mjs and tests/f-approvals-panel-resolve.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = new Map();
    this.textContent = ''; this.className = ''; this.disabled = false;
    this.style = { cssText: '', setProperty() {} }; this.listeners = new Map();
    this.parent = null;
  }
  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      if (k && typeof k === 'object') k.parent = this;
      this.children.push(k);
    }
  }
  // dom.mjs's el() only ever calls setAttribute, but the real DOM reflects the
  // boolean `disabled` attribute onto the IDL property — without this, a
  // disabled-state assertion could never fail.
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'disabled') this.disabled = true; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); if (k === 'disabled') this.disabled = false; }
  addEventListener(t, fn) { this.listeners.set(t, fn); }
  replaceChildren(...kids) {
    this.children = kids.filter((k) => k != null);
    for (const k of this.children) if (k && typeof k === 'object') k.parent = this;
  }
  replaceWith(node) {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) { this.parent.children[i] = node; node.parent = this.parent; }
    this.parent = null;
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

// GET /devices, counted so a "did the panel reload after pairing?" assertion is
// possible at all. `payload` is a function so a test can change what the route
// returns between the first load and the reload.
function stubDevices(payload) {
  const state = { calls: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/devices')) {
      state.calls += 1;
      return { ok: true, status: 200, json: async () => payload(state.calls) };
    }
    throw new Error(`unstubbed fetch: ${u}`);
  };
  return state;
}

const EMPTY = { requests: [], devices: [], sse: { open: 0, maxGlobal: 8, maxPerDevice: 2 } };

// The buttons live in render()'s `row-actions` div, alongside the status span.
function findButton(host, re) {
  for (const child of host.children) {
    if (!child || !Array.isArray(child.children)) continue;
    const hit = child.children.find((c) => c && c.tagName === 'button' && re.test(c.text));
    if (hit) return hit;
  }
  return null;
}
function statusSpan(host) {
  for (const child of host.children) {
    if (!child || !Array.isArray(child.children)) continue;
    if (child.children.some((c) => c && c.tagName === 'button')) {
      return child.children.find((c) => c && c.tagName === 'span');
    }
  }
  return null;
}

test('a successful pair renders the paired chip AND reloads the device list', async () => {
  const paired = { deviceId: 'sha256:abcdef0123456789', platform: 'browser', label: 'dashboard', role: '', approvedAt: '2026-08-11T10:00:00.000Z' };
  // First load: nothing paired. After the pair, the route reports the device —
  // so a panel that does not reload keeps showing "No devices paired yet."
  const state = stubDevices((n) => (n === 1 ? EMPTY : { ...EMPTY, devices: [paired] }));
  const { render } = await import('../web/ui/panels/gateway.mjs');
  const host = new FakeNode('div');
  await render(host, { pairThisBrowser: async () => ({ ok: true, deviceId: paired.deviceId }) });
  assert.equal(state.calls, 1, 'the initial load happens once');
  assert.match(host.text, /No devices paired yet/);

  const pairBtn = findButton(host, /Pair this browser/);
  assert.ok(pairBtn, 'the pair button must exist');
  await pairBtn.listeners.get('click')({ preventDefault() {} });

  assert.equal(state.calls, 2, 'a successful pair must re-read /devices, not leave the stale tables up');
  assert.match(statusSpan(host).text, /paired: abcdef012345/);
  assert.doesNotMatch(host.text, /No devices paired yet/,
    'the panel must not claim "No devices paired yet." next to "paired: <fp>"');
  assert.match(host.text, /sha256:abcdef0123456789/, 'the freshly paired device must appear in the table');
  assert.equal(pairBtn.disabled, false, 'the button is re-enabled once the request settles');
});

test('a failed pair renders the reason and re-enables the button', async () => {
  const state = stubDevices(() => EMPTY);
  const { render } = await import('../web/ui/panels/gateway.mjs');
  const host = new FakeNode('div');
  await render(host, {
    pairThisBrowser: async () => ({ ok: false, code: 'NO_WEBCRYPTO', error: 'WebCrypto is unavailable on this origin' }),
  });
  const pairBtn = findButton(host, /Pair this browser/);
  await pairBtn.listeners.get('click')({ preventDefault() {} });

  assert.match(statusSpan(host).text, /WebCrypto is unavailable on this origin/);
  const announced = statusSpan(host).children
    .find((c) => c && typeof c.getAttribute === 'function' && c.getAttribute('aria-live') === 'polite');
  assert.ok(announced, 'a failure must be announced to a screen reader, not only shown');
  assert.equal(pairBtn.disabled, false, 'a failed pair must leave the operator able to retry');
  assert.ok(state.calls >= 1);
});

test('a pair that THROWS is reported, not swallowed, and still re-enables the button', async () => {
  stubDevices(() => EMPTY);
  const { render } = await import('../web/ui/panels/gateway.mjs');
  const host = new FakeNode('div');
  await render(host, { pairThisBrowser: async () => { throw new Error('indexedDB is unavailable'); } });
  const pairBtn = findButton(host, /Pair this browser/);
  await pairBtn.listeners.get('click')({ preventDefault() {} });
  assert.match(statusSpan(host).text, /indexedDB is unavailable/);
  assert.equal(pairBtn.disabled, false);
});

test('forgetting this browser renders its message and reloads', async () => {
  const state = stubDevices(() => EMPTY);
  const { render } = await import('../web/ui/panels/gateway.mjs');
  const host = new FakeNode('div');
  let forgotten = 0;
  await render(host, { unpairThisBrowser: async () => { forgotten += 1; } });
  const forgetBtn = findButton(host, /Forget this browser's key/);
  assert.ok(forgetBtn, 'the forget button must exist');
  await forgetBtn.listeners.get('click')({ preventDefault() {} });

  assert.equal(forgotten, 1);
  assert.match(statusSpan(host).text, /this browser's key is gone/);
  // Revoking is still CLI-only, and after this branch's one-shot bootstrap fix
  // the replacement key comes up pending — the copy must say both.
  assert.match(statusSpan(host).text, /pompos nodes revoke/);
  assert.match(statusSpan(host).text, /pompos nodes approve/);
  assert.equal(forgetBtn.disabled, false);
  assert.equal(state.calls, 2, 'the tables must reflect the forget, not the pre-forget state');
});

test('the empty-state copy names no CLI subcommand that does not exist', async () => {
  stubDevices(() => EMPTY);
  const { render } = await import('../web/ui/panels/gateway.mjs');
  const host = new FakeNode('div');
  await render(host);
  const copy = host.text;
  assert.match(copy, /No pairing requests waiting/);
  // `pompos nodes pair` has never existed (commands/auth_nodes.mjs:
  // list|register|remove|pending|approve|revoke|rotate|devices). The eighth
  // piece of copy in this area to promise a CLI path that isn't there.
  assert.ok(!copy.includes('nodes pair'),
    `the empty state must not instruct a non-existent subcommand; saw: ${copy}`);
  assert.match(copy, /pompos nodes approve <requestId>/,
    'it must name the command that DOES approve a pending request');
});

test('an expired device is labelled expired, and a /devices failure surfaces', async () => {
  // Both rendering branches the table has, in one pass: the expiry chip is not
  // colour-alone, and a route error is shown rather than a blank panel.
  stubDevices(() => ({
    ...EMPTY,
    devices: [{ deviceId: 'sha256:dead', platform: 'browser', label: 'old', role: 'read-only', approvedAt: '2026-01-01T00:00:00.000Z', expiresAt: 1 }],
  }));
  const { render } = await import('../web/ui/panels/gateway.mjs');
  const host = new FakeNode('div');
  await render(host);
  assert.match(host.text, /expired/);
  assert.match(host.text, /read-only/, 'the stored role is shown so the operator can see what they are approving');

  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'devices.json is unreadable' }) });
  const host2 = new FakeNode('div');
  await render(host2);
  assert.match(host2.text, /Error: devices\.json is unreadable/);
});
