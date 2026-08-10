// tests/f-chat-slash-routing.test.mjs — web/ui/panels/chat.mjs's two pure
// routing/autocomplete rules, exercised with no DOM (see task-9-brief.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSlashLine, filterCommands } from '../web/ui/panels/chat.mjs';

test('only a leading slash routes to the dispatcher', () => {
  assert.equal(isSlashLine('/status'), true);
  assert.equal(isSlashLine('  /status'), true, 'leading whitespace is trimmed');
  assert.equal(isSlashLine('what is /status?'), false, 'a slash mid-sentence is prose');
  assert.equal(isSlashLine('http://x/y'), false);
  assert.equal(isSlashLine(''), false);
  assert.equal(isSlashLine('/'), false, 'a bare slash is not a command yet');
});

test('autocomplete filters by prefix and keeps registry order', () => {
  const all = [
    { name: '/status', description: 'show status' },
    { name: '/skill', description: 'skills' },
    { name: '/team', description: 'teams' },
  ];
  assert.deepEqual(filterCommands(all, '/s').map((c) => c.name), ['/status', '/skill']);
  assert.deepEqual(filterCommands(all, '/te').map((c) => c.name), ['/team']);
  assert.deepEqual(filterCommands(all, '/').map((c) => c.name), ['/status', '/skill', '/team']);
  assert.deepEqual(filterCommands(all, '/zz'), []);
});

test('filtering is case-insensitive and ignores a trailing argument', () => {
  const all = [{ name: '/team', description: 'teams' }];
  assert.deepEqual(filterCommands(all, '/TE').map((c) => c.name), ['/team']);
  assert.deepEqual(filterCommands(all, '/team add crew'), [],
    'once an argument is typed the popover closes');
});

// ─────────────────────────────────────────────────────────────────────────
// Fix round: the two pure functions above were the only tested surface —
// sendSlashLine (the streaming route, the CONFIRM_REQUIRED fallback, and
// the success/cancelled/error rendering) rested entirely on a manual trace.
// That is the exact pattern that let /loop ship broken earlier in this
// phase (a fake `dispatch` in the SSE tests hid a crash before the first
// line). Below drives the real render() through a minimal DOM stub, same
// shape as tests/f-confirm-dialog.test.mjs's FakeNode/FakeMutationObserver
// (no jsdom in this repo) — extended only with what chat.mjs additionally
// touches: replaceChildren, a `value` field for the textarea, and an
// instance querySelector for appendMsg's `stream.querySelector('.empty')`.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
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
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  get firstChild() { return this.children[0] ?? null; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  focus() { this.focused = true; }
  click() { (this.listeners.get('click') || []).forEach((fn) => fn()); }
  // Only the '.classname' shape chat.mjs actually calls (appendMsg's
  // `stream.querySelector('.empty')`) — breadth-first over children.
  querySelector(sel) {
    if (typeof sel !== 'string' || !sel.startsWith('.')) return null;
    const cls = sel.slice(1);
    const queue = [...this.children];
    while (queue.length) {
      const n = queue.shift();
      if (!n || typeof n !== 'object') continue;
      if (typeof n.className === 'string' && n.className.split(/\s+/).includes(cls)) return n;
      if (Array.isArray(n.children)) queue.push(...n.children);
    }
    return null;
  }
  // Same reasoning as f-confirm-dialog.test.mjs: real MutationObserver
  // callbacks fire as queued microtasks, not inline.
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

// Fresh document + modal elements per test, so nothing leaks between them —
// same setupModalDom() shape as f-confirm-dialog.test.mjs. window.prompt
// defaults to declining (returns null) since only the 401 case needs it,
// and a decline is the safe default for every other test (a stray prompt
// would otherwise hang nothing, but silently retrying would mask a bug).
function setupDom() {
  const scrim = new FakeNode('div');
  const modalEls = {
    'modal-scrim': scrim,
    'modal-title': new FakeNode('h3'),
    'modal-body': new FakeNode('div'),
    'modal-foot': new FakeNode('div'),
    'modal-x': new FakeNode('button'),
  };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => modalEls[id],
    createElement: (tag) => new FakeNode(tag),
    querySelector: () => null, // askInModal's body is a bare <p> — nothing matches
  };
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.window = { prompt: () => null };
  return { scrim, modalEls };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body };
}

// A one-shot SSE body: every `frames` entry becomes one `event:`/`data:`
// record, delivered as a single chunk (chunk-boundary splitting is already
// covered by web/ui/stream.mjs's own parser tests — not this file's job).
function sseResponse(frames) {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: { getReader: () => ({
      async read() {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: bytes };
      },
    }) },
    json: async () => ({}),
  };
}

// GET /slash/commands and GET /providers each answer once, from a fixed
// value; POST /slash is answered from `slashQueue`, FIFO, one response per
// call — an extra, unstubbed call throws instead of silently returning
// something, so "no further request" assertions are enforced by the stub
// itself, not just by a call-count check after the fact.
function makeFetch({ providers = [], commands = [], slashQueue = [] } = {}) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if (u === '/slash/commands') return jsonResponse(200, commands);
    if (u === '/providers') return jsonResponse(200, providers);
    if (u === '/slash') {
      const step = slashQueue[i++];
      if (!step) throw new Error(`unstubbed extra POST /slash call: ${JSON.stringify(calls[calls.length - 1].body)}`);
      return step();
    }
    return jsonResponse(200, {});
  };
  return calls;
}

function collect(node, pred, out = []) {
  if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    if (Array.isArray(node.children)) for (const c of node.children) collect(c, pred, out);
  }
  return out;
}

function findChatEls(host) {
  return {
    textarea: collect(host, (n) => n.tagName === 'textarea')[0],
    sendBtn: collect(host, (n) => n.tagName === 'button' && n.textContent === 'Send')[0],
    stream: collect(host, (n) => n.attributes?.get('id') === 'chat-stream')[0],
  };
}

// One entry per appended .msg bubble, in DOM order — the initial "Type
// below to start." placeholder is always gone by the time a real message
// has been sent, so no filtering for it is needed here.
function getMessages(stream) {
  return stream.children
    .filter((c) => c && typeof c === 'object' && typeof c.className === 'string' && c.className.startsWith('msg '))
    .map((c) => ({ cls: c.className, text: c.textContent }));
}

async function sendLine(host, text) {
  const { textarea, sendBtn } = findChatEls(host);
  textarea.value = text;
  const onclick = sendBtn.listeners.get('click')[0];
  return onclick(); // the promise sendChat() returns — never fire-and-forget it
}

// Resolves once askInModal has actually opened the modal, instead of
// guessing a tick count — same helper as f-confirm-dialog.test.mjs.
function waitForOpenAttribute(scrim) {
  return new Promise((resolve) => {
    const original = scrim.setAttribute.bind(scrim);
    scrim.setAttribute = (k, v) => { original(k, v); if (k === 'data-open') resolve(); };
  });
}

test('a STREAM_COMMANDS line (/loop) streams lines as they arrive, not buffered', async () => {
  setupDom();
  const calls = makeFetch({
    slashQueue: [() => sseResponse([
      { event: 'line', data: { text: 'iteration 1' } },
      { event: 'line', data: { text: 'iteration 2' } },
      { event: 'done', data: { ok: true, lines: ['iteration 1', 'iteration 2'] } },
    ])],
  });
  const { render } = await import('../web/ui/panels/chat.mjs');
  const host = new FakeNode('div');
  await render(host);

  await sendLine(host, '/loop 3 do the thing');

  const { stream } = findChatEls(host);
  const msgs = getMessages(stream);
  // The two streamed lines land as SEPARATE .msg bubbles, one per SSE
  // `line` event — not one bubble that appears once the run finishes —
  // and are NOT re-appended from the final envelope's `lines` (that would
  // show each line twice).
  assert.deepEqual(msgs, [
    { cls: 'msg user', text: '/loop 3 do the thing' },
    { cls: 'msg system', text: 'iteration 1' },
    { cls: 'msg system', text: 'iteration 2' },
  ]);
  const slashCall = calls.find((c) => c.url === '/slash');
  assert.equal(slashCall.headers.accept, 'text/event-stream', 'STREAM_COMMANDS must ask for SSE');
});

test('a non-STREAM_COMMANDS line takes the buffered path (one request, no SSE)', async () => {
  setupDom();
  const calls = makeFetch({ slashQueue: [() => jsonResponse(200, { ok: true, lines: ['provider: anthropic'] })] });
  const { render } = await import('../web/ui/panels/chat.mjs');
  const host = new FakeNode('div');
  await render(host);

  await sendLine(host, '/status');

  const { stream } = findChatEls(host);
  assert.deepEqual(getMessages(stream), [
    { cls: 'msg user', text: '/status' },
    { cls: 'msg system', text: 'provider: anthropic' },
  ]);
  const slashCalls = calls.filter((c) => c.url === '/slash');
  assert.equal(slashCalls.length, 1, '/status never streams');
  assert.equal(slashCalls[0].headers.accept, undefined, 'the buffered path never asks for SSE');
});

test('CONFIRM_REQUIRED on the streaming path falls back to the confirm dialog, and once confirmed, actually runs', async () => {
  const { scrim, modalEls } = setupDom();
  const opened = waitForOpenAttribute(scrim);
  const calls = makeFetch({
    slashQueue: [
      // 1) the streaming attempt: refused before dispatch, no lines emitted.
      () => sseResponse([{ event: 'done', data: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Abandon task foo? It stops and cannot be resumed.', token: 'stream_tok' } }]),
      // 2) runSlashConfirmed's own (buffered) probe — a SEPARATE token.
      () => jsonResponse(409, { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Abandon task foo? It stops and cannot be resumed.', token: 'buf_tok' }),
      // 3) the confirmed retry — must be answered.
      () => jsonResponse(200, { ok: true, lines: ['abandoned foo'] }),
    ],
  });
  const { render } = await import('../web/ui/panels/chat.mjs');
  const host = new FakeNode('div');
  await render(host);

  const resultPromise = sendLine(host, '/task abandon foo');
  await opened;
  const confirmBtn = modalEls['modal-foot'].children.find((c) => c.textContent === 'Confirm');
  assert.ok(confirmBtn, 'the shared confirm modal must open — a destructive /task subcommand is not exempt just because it was typed under a STREAM_COMMANDS name');
  confirmBtn.click();
  await resultPromise;

  const { stream } = findChatEls(host);
  assert.deepEqual(getMessages(stream), [
    { cls: 'msg user', text: '/task abandon foo' },
    { cls: 'msg system', text: 'abandoned foo' },
  ], 'the run actually happened after confirmation — not silence, not a duplicate of the streamed (empty) attempt');

  const slashCalls = calls.filter((c) => c.url === '/slash');
  assert.equal(slashCalls.length, 3);
  assert.equal(slashCalls[2].body.confirm, 'buf_tok',
    'the confirmed request redeems the token runSlashConfirmed minted, not the discarded streaming attempt\'s token');
});

test('a decline on the streaming-fallback path renders the cancelled state and fires no further request', async () => {
  const { scrim, modalEls } = setupDom();
  const opened = waitForOpenAttribute(scrim);
  const calls = makeFetch({
    slashQueue: [
      () => sseResponse([{ event: 'done', data: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Abandon task bar?', token: 'stream_tok' } }]),
      () => jsonResponse(409, { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Abandon task bar?', token: 'buf_tok' }),
      // no third entry: a decline must never reach it — an extra call
      // would throw inside the fetch stub itself.
    ],
  });
  const { render } = await import('../web/ui/panels/chat.mjs');
  const host = new FakeNode('div');
  await render(host);

  const resultPromise = sendLine(host, '/task abandon bar');
  await opened;
  const cancelBtn = modalEls['modal-foot'].children.find((c) => c.textContent === 'Cancel');
  assert.ok(cancelBtn);
  cancelBtn.click();
  await resultPromise;

  const { stream } = findChatEls(host);
  assert.deepEqual(getMessages(stream), [
    { cls: 'msg user', text: '/task abandon bar' },
    { cls: 'msg cancelled', text: 'Cancelled — nothing ran.' },
  ], 'a decline is neither the success look (.system) nor the failure look (.error)');
  assert.equal(calls.filter((c) => c.url === '/slash').length, 2, 'nothing runs after a decline');
});

test('an ok:false failure renders the error state, never the success state', async () => {
  setupDom();
  makeFetch({ slashQueue: [() => jsonResponse(400, { ok: false, error: 'boom', code: 'SLASH_ERR' })] });
  const { render } = await import('../web/ui/panels/chat.mjs');
  const host = new FakeNode('div');
  await render(host);

  await sendLine(host, '/status');

  const { stream } = findChatEls(host);
  const msgs = getMessages(stream);
  assert.deepEqual(msgs, [
    { cls: 'msg user', text: '/status' },
    { cls: 'msg error', text: '⚠ boom' },
  ]);
  assert.ok(!msgs.some((m) => m.cls === 'msg system'), 'a failed command must never also render a success bubble');
});

test('a 401 body ({error:"unauthorized"}, no `ok` field) renders as a failure, not as neither', async () => {
  setupDom(); // window.prompt declines the re-auth prompt by default
  makeFetch({ slashQueue: [() => jsonResponse(401, { error: 'unauthorized' })] });
  const { render } = await import('../web/ui/panels/chat.mjs');
  const host = new FakeNode('div');
  await render(host);

  await sendLine(host, '/status');

  const { stream } = findChatEls(host);
  const msgs = getMessages(stream);
  assert.deepEqual(msgs, [
    { cls: 'msg user', text: '/status' },
    { cls: 'msg error', text: '⚠ unauthorized' },
  ], '`out.ok` must be checked for truthiness — a missing `ok` field is not success');
  assert.ok(!msgs.some((m) => m.cls === 'msg system'));
});
