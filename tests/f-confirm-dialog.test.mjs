// tests/f-confirm-dialog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

function stubFetchSequence(responses) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push(opts?.body ? JSON.parse(opts.body) : null);
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return calls;
}

test('a safe command runs without asking anything', async () => {
  stubFetchSequence([{ status: 200, body: { ok: true, lines: ['ok'] } }]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let asked = 0;
  const out = await runSlashConfirmed('/team list', { confirm: async () => { asked += 1; return true; } });
  assert.equal(out.ok, true);
  assert.equal(asked, 0);
});

test('an accepted confirmation retries the same line with the token', async () => {
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
    { status: 200, body: { ok: true, lines: ['removed'] } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let seenPrompt = null;
  const out = await runSlashConfirmed('/team remove crew', {
    confirm: async (p) => { seenPrompt = p; return true; },
  });
  assert.equal(seenPrompt, 'Remove team crew?', 'the user sees the blast radius, not a generic "are you sure"');
  assert.deepEqual(out, { ok: true, lines: ['removed'] });
  assert.deepEqual(calls[1], { line: '/team remove crew', confirm: 'c_1' });
});

test('a declined confirmation does NOT retry and reports cancellation', async () => {
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  const out = await runSlashConfirmed('/team remove crew', { confirm: async () => false });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CANCELLED');
  assert.equal(calls.length, 1, 'nothing is sent after a decline');
});

test('a second confirmation is not asked twice in a row', async () => {
  // If the server asks again after a redemption something is wrong; surface it
  // rather than looping.
  stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'p', token: 'c_1' } },
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'p', token: 'c_2' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let asked = 0;
  const out = await runSlashConfirmed('/team remove crew', { confirm: async () => { asked += 1; return true; } });
  assert.equal(asked, 1, 'ask once, then stop');
  assert.equal(out.ok, false);
});

// ---------------------------------------------------------------------------
// The tests above all pass an explicit `confirm` function, so the default
// asker (askInModal, not exported — it is only reachable by omitting
// `confirm`) never runs. That leaves its MutationObserver-based dismissal
// handling — the fix for ×/scrim/Escape leaving the promise unresolved
// forever — completely uncovered. There is no jsdom in this repo and this
// task takes no new dependency, so below is the smallest DOM stub that
// makes askInModal exercisable: just enough of `document`/`Element` for
// el() (dom.mjs) and openModal/closeModal (modal.mjs) to run, plus a
// MutationObserver stand-in that fires attribute-change callbacks.
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.style = { cssText: '', setProperty() {} };
    this.isConnected = true;
    this._observers = [];
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); this._notify(k); }
  removeAttribute(k) { this.attributes.delete(k); this._notify(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  append(...kids) { this.children.push(...kids); }
  get firstChild() { return this.children[0] ?? null; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  focus() { this.focused = true; }
  click() { (this.listeners.get('click') || []).forEach((fn) => fn()); }
  // Real MutationObserver callbacks fire as queued microtasks, not inline —
  // that matters here: askInModal's own button handlers call closeModal()
  // (which flips data-open) and THEN decide() in the same synchronous turn.
  // An inline notify would let the observer's decide(false) run before the
  // click handler's own decide(true) does, resolving Confirm as a decline.
  _notify(attrName) {
    if (this._observers.length === 0) return;
    const observers = [...this._observers];
    queueMicrotask(() => observers.forEach((o) => o._fire(attrName)));
  }
}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.disconnected = false; this.target = null; }
  observe(target, opts) {
    this.target = target;
    this.attributeFilter = opts?.attributeFilter || null;
    target._observers.push(this);
  }
  _fire(attrName) {
    if (this.disconnected) return;
    if (this.attributeFilter && !this.attributeFilter.includes(attrName)) return;
    this.callback([{ type: 'attributes', attributeName: attrName }]);
  }
  disconnect() {
    this.disconnected = true;
    if (this.target) this.target._observers = this.target._observers.filter((o) => o !== this);
  }
}

// Fresh elements + globals per test, so nothing leaks between them.
function setupModalDom() {
  const scrim = new FakeNode('div');
  const elements = {
    'modal-scrim': scrim,
    'modal-title': new FakeNode('h3'),
    'modal-body': new FakeNode('div'),
    'modal-foot': new FakeNode('div'),
    'modal-x': new FakeNode('button'),
  };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => elements[id],
    createElement: (tag) => new FakeNode(tag),
    querySelector: () => null, // askInModal's body is a bare <p> — nothing ever matches here
  };
  globalThis.MutationObserver = FakeMutationObserver;
  return { scrim, elements };
}

// Resolves once askInModal has actually opened the modal (the scrim's
// data-open is set) instead of guessing a tick count, so this test doesn't
// depend on how many microtask hops runSlash's own fetch/json chain takes.
function waitForOpenAttribute(scrim) {
  return new Promise((resolve) => {
    const original = scrim.setAttribute.bind(scrim);
    scrim.setAttribute = (k, v) => {
      original(k, v);
      if (k === 'data-open') resolve();
    };
  });
}

test('dismissing the default modal any way other than Confirm — the × button, the scrim, Escape, all of which funnel into closeModal() — resolves as a decline', async () => {
  const { scrim } = setupModalDom();
  const opened = waitForOpenAttribute(scrim);
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  const { closeModal } = await import('../web/ui/modal.mjs');
  const result = runSlashConfirmed('/team remove crew'); // no `confirm` opt: exercises the default askInModal
  await opened;
  closeModal(); // exactly what the × button / scrim click / Escape handler all do
  const out = await result;
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CANCELLED');
  assert.equal(calls.length, 1, 'a decline must not retry');
  assert.equal(scrim._observers.length, 0, 'the observer must disconnect once resolved, not linger');
});

test('clicking Confirm in the default modal resolves true, retries with the token, and leaves no observer attached', async () => {
  const { scrim, elements } = setupModalDom();
  const opened = waitForOpenAttribute(scrim);
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
    { status: 200, body: { ok: true, lines: ['removed'] } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  const result = runSlashConfirmed('/team remove crew');
  await opened;
  const confirmBtn = elements['modal-foot'].children.find((c) => c.textContent === 'Confirm');
  assert.ok(confirmBtn, 'askInModal must put a Confirm button in the modal foot');
  confirmBtn.click();
  const out = await result;
  assert.deepEqual(out, { ok: true, lines: ['removed'] });
  assert.deepEqual(calls[1], { line: '/team remove crew', confirm: 'c_1' });
  assert.equal(scrim._observers.length, 0, 'the observer must disconnect once Confirm resolves it');
});
