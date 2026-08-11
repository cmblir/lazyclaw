// tests/f-approvals-panel-resolve.test.mjs — the row's three outcomes.
//
// The failure paths matter more than the success one: a resolve that could not
// happen must leave the row actionable and say why. A row that disappears on
// failure tells the operator an agent was unblocked when it is still waiting —
// the exact defect class this project keeps producing.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
// approvals.mjs imports shell.mjs (for bumpNav), which imports motion.mjs,
// which reads matchMedia at module-load time — same stub as
// tests/f-shell-cleanup-resolve.test.mjs needs for the same transitive import.
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

// The smallest DOM that dom.mjs's el() needs — same approach as
// tests/f-panel-write-guard.test.mjs (no jsdom in this repo).
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
  appendChild(k) { if (k && typeof k === 'object') k.parent = this; this.children.push(k); return k; }
  // render()'s show() helper calls shown.replaceWith(node) to swap the
  // "Loading…" placeholder for real content — needed for the SSE-refresh
  // test below, which drives the panel through render() end to end.
  replaceWith(node) {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) { this.parent.children[i] = node; node.parent = this.parent; }
    this.parent = null;
  }
  // Real DOM reflects the boolean `disabled` attribute onto the `.disabled`
  // IDL property (e.g. button.setAttribute('disabled', '') also makes
  // button.disabled === true); el() in dom.mjs only ever calls setAttribute,
  // so without this the fake node's `.disabled` field (declared above) would
  // never move and every disabled-state assertion would be unreachable.
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'disabled') this.disabled = true; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); if (k === 'disabled') this.disabled = false; }
  addEventListener(t, fn) { this.listeners.set(t, fn); }
  replaceChildren(...kids) {
    this.children = kids.filter((k) => k != null);
    for (const k of this.children) if (k && typeof k === 'object') k.parent = this;
  }
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

// cell.text concatenates every child's text with no separator, so scanning it
// for a whole word (e.g. /approved/i) is unsafe once a chip sits next to an
// "Approve"/"Deny" button: "...Approve" + "Deny..." reads as "...ApproveD..."
// which itself matches /approved/i. Reading the chip span's own text avoids
// that boundary false-positive entirely.
function chipNode(cell) {
  return cell.children.find((c) => c.tagName === 'span' && c.className && c.className.startsWith('chip'));
}

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
  const pairBtn = cell.children.find((c) => c.tagName === 'button' && /Pair this browser/i.test(c.text));
  assert.equal(pairBtn, undefined, 'a non-NOT_PAIRED failure must not offer a pairing button that cannot help');
});

test('a successful deny shows "denied", not a hardcoded "approved"', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  await _decide(tr, { id: 'ap_5' }, 'ap_5', 'deny', {
    resolveApproval: async () => ({ ok: true, id: 'ap_5', approved: false }),
  });
  const cell = tr.querySelector('[data-f="actions"]');
  const chip = chipNode(cell);
  assert.ok(chip, 'expected a status chip');
  assert.match(chip.text, /denied/i);
  assert.doesNotMatch(chip.text, /approved/i, 'a deny must never render as an approval');
});

test('NOT_PAIRED offers pairing inline instead of a bare error, without dropping Approve/Deny', async () => {
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
  const decideButtons = cell.children.filter((c) => c.tagName === 'button' && /Approve|Deny/.test(c.text));
  assert.equal(decideButtons.length, 2, 'Approve/Deny must remain so the operator can retry the same decision after pairing');
  await pairBtn.listeners.get('click')({ preventDefault() {} });
  assert.equal(paired, 1);
});

test('a pair attempt that fails with NO_WEBCRYPTO is not re-offered — this browser can never pair', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  await _decide(tr, { id: 'ap_6' }, 'ap_6', 'approve', {
    resolveApproval: async () => ({ ok: false, code: 'NOT_PAIRED', error: 'this browser is not a paired device' }),
    pairThisBrowser: async () => ({ ok: false, code: 'NO_WEBCRYPTO', error: 'WebCrypto is unavailable on this origin' }),
  });
  const cell = tr.querySelector('[data-f="actions"]');
  let pairBtn = cell.children.find((c) => c.tagName === 'button' && /Pair this browser/i.test(c.text));
  assert.ok(pairBtn, 'the pair button must still be offered on the initial NOT_PAIRED failure');
  await pairBtn.listeners.get('click')({ preventDefault() {} });
  pairBtn = cell.children.find((c) => c.tagName === 'button' && /Pair this browser/i.test(c.text));
  assert.equal(pairBtn, undefined, 'NO_WEBCRYPTO can never succeed by retrying — re-offering the button is a dead end');
  assert.match(cell.text, /WebCrypto is unavailable/);
});

test('a thrown resolve is reported, not swallowed, and leaves the row actionable', async () => {
  const { _decide } = await import('../web/ui/panels/approvals.mjs');
  const tr = row();
  await _decide(tr, { id: 'ap_4' }, 'ap_4', 'deny', {
    resolveApproval: async () => { throw new Error('network down'); },
  });
  const cell = tr.querySelector('[data-f="actions"]');
  assert.match(cell.text, /network down/);
  const buttons = cell.children.filter((c) => c.tagName === 'button' && /Approve|Deny/.test(c.text));
  assert.ok(buttons.length >= 2, 'a thrown resolve must still leave the row actionable');
  assert.equal(buttons.some((b) => b.disabled === true), false, 'buttons must be re-enabled, not left disabled by a stray throw');
  assert.equal(chipNode(cell), undefined, 'a thrown resolve must not render a resolved-state chip');
});

test('an exec.approval.resolved event refreshes the mounted panel, not just the badge, and no-ops once unmounted', async () => {
  const { render, _onStreamEvent } = await import('../web/ui/panels/approvals.mjs');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  // Pending stays empty throughout — this test is about the WIRING (does
  // load() get called at all), not the table/reconcile machinery, so an
  // empty list keeps the fake DOM surface this file needs to a minimum.
  globalThis.fetch = async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({ pending: [] }) }; };
  try {
    // No panel mounted yet: the badge still refreshes (refreshBadge always
    // runs), but there is no load() to also call.
    const before = fetchCalls;
    _onStreamEvent('exec.approval.resolved');
    await Promise.resolve();
    assert.equal(fetchCalls, before + 1, 'unmounted: only the badge refresh fetches');

    const host = new FakeNode('div');
    const cleanup = await render(host);
    const afterMount = fetchCalls;

    _onStreamEvent('exec.approval.resolved');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchCalls, afterMount + 2, 'mounted: the badge refresh AND the table reload both fire');

    cleanup();
    const afterUnmount = fetchCalls;
    _onStreamEvent('exec.approval.resolved');
    await Promise.resolve();
    assert.equal(fetchCalls, afterUnmount + 1, 'unmounted again: back to just the badge refresh, no stale load()');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a stale mount\'s cleanup cannot retract a LATER mount\'s SSE registration', async () => {
  // shell.mjs fires a render's cleanup as soon as the operator navigates away
  // before that render settled, even if a newer mount already took over
  // activeLoad. The clear must be identity-checked so mount A's belated
  // cleanup can only retract ITS OWN registration, never mount A2's.
  const { render, _onStreamEvent } = await import('../web/ui/panels/approvals.mjs');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({ pending: [] }) }; };
  const cleanupA = await render(new FakeNode('div'));   // mount A: activeLoad = loadA
  const cleanupA2 = await render(new FakeNode('div'));  // mount A2: activeLoad = loadA2 (the live one)
  try {
    cleanupA(); // A's stale cleanup arrives late — must not touch A2's registration

    const before = fetchCalls;
    _onStreamEvent('exec.approval.resolved');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchCalls, before + 2,
      'A2 must still be registered after A\'s stale cleanup: badge refresh AND A2\'s load() both fire');
  } finally {
    // Unconditional, regardless of the assertion above: each render() started
    // its own setInterval(tick, 1000), which keeps the test process's event
    // loop alive forever if never cleared — an assertion failure must not
    // also hang the whole suite on top of failing honestly.
    cleanupA2();
    globalThis.fetch = originalFetch;
  }
});
