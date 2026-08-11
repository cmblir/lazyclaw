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
  }
  append(...kids) { for (const k of kids) if (k != null) this.children.push(k); }
  appendChild(k) { this.children.push(k); return k; }
  // Real DOM reflects the boolean `disabled` attribute onto the `.disabled`
  // IDL property (e.g. button.setAttribute('disabled', '') also makes
  // button.disabled === true); el() in dom.mjs only ever calls setAttribute,
  // so without this the fake node's `.disabled` field (declared above) would
  // never move and every disabled-state assertion would be unreachable.
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'disabled') this.disabled = true; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); if (k === 'disabled') this.disabled = false; }
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
