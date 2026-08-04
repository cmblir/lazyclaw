# Dashboard Shell & Motion (T1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the lazyclaw dashboard from 19 flat tabs of read-only tables served by one 1796-line file into a grouped shell with a command palette, a live event rail, motion level 3, and the two gateway views it never had — without adding a build step or a dependency.

**Architecture:** `web/dashboard.js` becomes a thin ES-module entry that imports `web/ui/*.mjs` (shell, helpers, motion, stream, reconcile) and `web/ui/panels/*.mjs` (one module per panel, each exporting `render(host)`). The daemon gains one guarded static route for `/ui/**.mjs` and two read-only JSON routes. Pure logic (tree building, frame parsing, reconciliation) moves into `.mjs` files so it becomes unit-testable under `node --test` for the first time.

**Tech Stack:** Vanilla ES modules, no build step, no new dependencies. CSS custom properties for motion tokens, Web Animations API for FLIP, `requestAnimationFrame` for tweens, SSE over `fetch` (not `EventSource` — bearer tokens need headers). Tests: `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-03-dashboard-shell-motion-design.md`

## Global Constraints

- **No build step.** `web/` ships as source (`package.json` `files` contains `"web/"`). Never add a bundler, never commit a `dist/`.
- **No new dependencies.** Not in `dependencies`, not in `devDependencies`.
- **File-size gate:** every committed `.mjs` must be ≤ **500 lines** (`scripts/lint-file-size.mjs`, `LIMIT = 500`). **Never add an entry to its `ALLOW` map** — that map is existing tech debt.
- **Entry filename stays `web/dashboard.js`.** `tests/f-dashboard-assets.test.mjs` asserts `/<script[^>]+src="\/dashboard\.js"/`; keeping the name means adding `type="module"` passes unchanged.
- **Auth allowlist regex is security code.** `/ui/` paths may contain only `[a-z0-9_-]`, one optional nested directory, and must end in `.mjs`. No uppercase, no dots beyond the extension.
- **New daemon read routes must NOT live under `/gateway/`.** `daemon.mjs:242` sends every `/gateway/*` request to the device gateway's own handler, so such a route would 404 before reaching the route table.
- **Never return a device bearer token** in any JSON response. `devices.json` stores them in plaintext (mode 0600).
- **No secrets or PII in event payloads.** Emit routing facts, never message bodies.
- **Motion tokens (level 3, final):** `--dur-fast: 160ms`, `--dur-mid: 260ms`, `--dur-slow: 460ms`, `--stagger: 46ms`, `--lift: 8px`, `--ambient: 1`.
- **`prefers-reduced-motion` must zero all of them** and set `*, ::before, ::after { animation: none !important; }`. The pseudo-element selectors are load-bearing: `*` alone does NOT match `::before`/`::after`, so without them the two always-on animations (the live-rail sweep on `.liverail::before` and the streaming caret on `#stream-text::after`) keep running under reduced motion. Verified against a real Chromium engine via `page.emulateMedia`.
- **Status is never colour-alone.** Every state indicator carries a glyph and a word.
- **Comments and docstrings in English.** Commit messages in English (Global CLAUDE.md §2).
- **No Claude attribution in commits** (Global CLAUDE.md §5.2).
- Run after every task: `npm run lint:size && node --test tests/f-dashboard-*.test.mjs`

---

## File Structure

**New — shared modules**

| File | Responsibility |
|---|---|
| `web/ui/dom.mjs` | `el` / `clear` / `chip` / `phead` / `table` / `rowList` / `kvlist` / `banner` / `escHtml` |
| `web/ui/api.mjs` | token storage + `apiRaw` / `api` / `apiSoft` (moved verbatim from `dashboard.js`) |
| `web/ui/modal.mjs` | `openModal` / `closeModal` with focus return |
| `web/ui/motion.mjs` | reduced-motion gate, `restartEnter`, `captureRects`, `playFlip`, `tweenNumber` |
| `web/ui/stream.mjs` | SSE frame parser + single app-level subscription with backoff |
| `web/ui/reconcile.mjs` | keyed list update (node reuse) |
| `web/ui/team_tree.mjs` | **pure** tree logic: `managerIn` / `tierRows` / `chainOf` / `isDescendant` / `canReassign` |
| `web/ui/shell.mjs` | nav model, group rendering, hash routing, active marker, mobile drawer, `bumpNav` |
| `web/ui/palette.mjs` | `⌘K` command palette |
| `web/ui/panels/<id>.mjs` | one per panel; each exports `render(host)` returning an optional cleanup function |

**Modified**

| File | Change |
|---|---|
| `web/dashboard.html` | shell skeleton only: sidebar, topbar, live rail, `#host`, modal, palette |
| `web/dashboard.css` | motion tokens, shell, components |
| `web/dashboard.js` | thin module entry |
| `daemon/routes/meta.mjs` | add `uiModule` handler |
| `daemon/route_table.mjs` | add `/ui/**.mjs`, `GET /approvals`, `GET /devices` |
| `daemon/lib/auth.mjs` | `isStaticDashboardPath` gains `UI_MODULE_RE` |
| `daemon/routes/registry.mjs` | task list/get gain `attended` + `permissionMode` |
| `mas/mention_router.mjs`, `workflow/`, `cron.mjs`, `providers/registry.mjs`, `daemon/lib/cost.mjs`, `daemon/routes/conversation.mjs` | one `emit()` call each |

**New — daemon**

| File | Responsibility |
|---|---|
| `daemon/routes/gateway_views.mjs` | `approvalsList` + `devicesList`, both read-only, both token-stripping |

**New — tests**

`tests/f-dashboard-ui-route.test.mjs`, `tests/f-dashboard-ui-auth.test.mjs`, `tests/f-team-tree.test.mjs`, `tests/f-sse-frames.test.mjs`, `tests/f-reconcile.test.mjs`, `tests/f-gateway-views.test.mjs`, `tests/f-task-posture.test.mjs`, `tests/f-bus-events.test.mjs`

---

## Task 1: Extract `dom.mjs`, `api.mjs`, `modal.mjs` (no behaviour change)

**Files:**
- Create: `web/ui/dom.mjs`, `web/ui/api.mjs`, `web/ui/modal.mjs`
- Modify: `web/dashboard.js` (delete the moved functions, import them), `web/dashboard.html:284`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `el(tag, props, ...kids) -> HTMLElement`
  - `clear(node) -> node`
  - `escHtml(s) -> string`
  - `chip(text, tone) -> HTMLElement` where `tone` is `'' | 'live' | 'ok' | 'warn' | 'err'`
  - `phead(title, sub) -> HTMLElement`
  - `table(cols, rows) -> HTMLElement`, `cols: {key, label, class?}[]`
  - `rowList(rows) -> HTMLElement`, `rows: {who, what, state?, tone?, acts?}[]`
  - `kvlist(pairs) -> HTMLElement`, `pairs: [label, value, mono?][]`
  - `banner(tone, icon, ...kids) -> HTMLElement`
  - `getToken() -> string`, `setToken(t) -> void`, `withAuth(opts) -> opts`
  - `apiRaw(path, opts) -> Promise<Response>`
  - `api(path, opts) -> Promise<any>` (throws, toasts on failure)
  - `apiSoft(path, opts) -> Promise<{status, body}>`
  - `openModal({ title, body, foot }) -> void`, `closeModal() -> void`

- [ ] **Step 1: Write the failing test**

`web/ui/dom.mjs` is browser code, but `el()` is pure enough to test under Node with a minimal stub. Create `tests/f-dashboard-dom.test.mjs`:

```js
// tests/f-dashboard-dom.test.mjs — el() is the workhorse of every panel; a
// regression here breaks all 21 at once. Tested against a tiny DOM stub so it
// stays a node --test unit, no browser and no jsdom dependency.
import test from 'node:test';
import assert from 'node:assert/strict';

function stubDocument() {
  const mk = (tag) => ({
    tag, className: '', textContent: '', attrs: {}, kids: [], listeners: {},
    style: { cssText: '', _props: {}, setProperty(k, v) { this._props[k] = v; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(...xs) { this.kids.push(...xs); },
  });
  return { createElement: mk, createTextNode: (t) => ({ text: String(t) }) };
}

test('el() maps props onto the element and flattens children', async () => {
  globalThis.document = stubDocument();
  const { el } = await import('../web/ui/dom.mjs');

  const n = el('div', { class: 'card', 'data-id': 'x', '--i': 3, text: 'hi' });
  assert.equal(n.tag, 'div');
  assert.equal(n.className, 'card');
  assert.equal(n.attrs['data-id'], 'x');
  assert.equal(n.style._props['--i'], 3);
  assert.equal(n.textContent, 'hi');

  const parent = el('ul', {}, [el('li', {}), el('li', {})], null, false, undefined, 'tail');
  assert.equal(parent.kids.length, 3, 'nested arrays flatten; null/false/undefined are dropped');
});

test('el() drops null and false attribute values but keeps 0', async () => {
  globalThis.document = stubDocument();
  const { el } = await import('../web/ui/dom.mjs');
  const n = el('div', { hidden: null, disabled: false, tabindex: 0, checked: true });
  assert.equal('hidden' in n.attrs, false);
  assert.equal('disabled' in n.attrs, false);
  assert.equal(n.attrs.tabindex, 0);
  assert.equal(n.attrs.checked, '', 'true becomes a bare attribute');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-dashboard-dom.test.mjs`
Expected: FAIL — `Cannot find module '.../web/ui/dom.mjs'`

- [ ] **Step 3: Write `web/ui/dom.mjs`**

```js
// web/ui/dom.mjs — element construction and the handful of shared visual
// primitives every panel needs. No framework: el() is a thin, predictable
// wrapper over document.createElement that keeps panel code declarative.

// Build an element. `props` is a flat bag:
//   class / text / style   -> the matching property
//   on<Event>              -> addEventListener
//   --custom-prop          -> style.setProperty (used for stagger indices)
//   anything else          -> setAttribute; null/undefined/false are skipped
//   so callers can write `disabled: !allowed || null` inline
// Children flatten one level and skip null/undefined/false.
export function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k.startsWith('--')) n.style.setProperty(k, v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(typeof kid === 'string' || typeof kid === 'number' ? String(kid) : kid);
  }
  return n;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Status is never colour-alone: every chip carries a glyph and a word.
const TONE_ICON = { live: '●', ok: '✓', warn: '!', err: '✗', '': '○' };

export function chip(text, tone) {
  return el('span', { class: 'chip' + (tone ? ' is-' + tone : '') },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: TONE_ICON[tone || ''] }),
    text);
}

export function phead(title, sub) {
  return el('div', { class: 'phead' }, el('h2', { text: title }), sub && el('p', { text: sub }));
}

// `--i` on each row is what the CSS stagger reads.
export function table(cols, rows) {
  const thead = el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c.label }))));
  const tbody = el('tbody', {}, rows.map((r, i) => el('tr', { '--i': i },
    cols.map((c) => el('td', { class: c.class || '' }, r[c.key])))));
  return el('div', { class: 'scroll' }, el('table', { class: 'tbl' }, thead, tbody));
}

export function rowList(rows) {
  if (!rows.length) return el('div', { class: 'empty', text: 'Nothing here yet.' });
  return el('div', { class: 'stack' }, rows.map((r, i) => el('div', { class: 'srow', '--i': i },
    el('div', { style: 'min-width:0' },
      el('div', { class: 'who', text: r.who }),
      el('div', { class: 'what', text: r.what })),
    el('div', { class: 'acts' },
      r.tone !== undefined ? chip(r.state, r.tone) : null,
      r.acts || []))));
}

export function kvlist(pairs) {
  return el('dl', { class: 'kvlist' }, pairs.flatMap(([k, v, mono]) =>
    [el('dt', { text: k }), el('dd', { class: mono ? 'mono' : '', text: v })]));
}

export function banner(tone, icon, ...kids) {
  return el('div', { class: 'banner ' + tone },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: icon }), ...kids);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/f-dashboard-dom.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Move the API helpers verbatim into `web/ui/api.mjs`**

Cut these from `web/dashboard.js` (current line numbers) and paste them into `web/ui/api.mjs`, adding `export` to each: `getToken` (72), `setToken` (75), `withAuth` (80), `promptForToken` (87), `apiRaw` (103), `api` (111), `apiSoft` (125).

Do not change their bodies. `api()` currently surfaces errors as page toasts — keep that, and import the toast helper from `dom.mjs` if it moved there; if `api()` references a DOM node that no longer exists in the new shell, leave a `TODO`-free direct `console.error` **only if** the original had one. Preserve behaviour exactly.

- [ ] **Step 6: Move the modal into `web/ui/modal.mjs`**

Move `openModal` (139) and `closeModal` (145). Change the signature from `{title, bodyHtml, footHtml}` (HTML strings) to `{title, body, foot}` (nodes or arrays of nodes), because every caller is being rewritten to build nodes. Add focus management the original lacked:

```js
// web/ui/modal.mjs — one shared modal layer; only one open at a time.
import { clear } from './dom.mjs';

let returnFocusTo = null;

export function openModal({ title, body, foot }) {
  returnFocusTo = document.activeElement;
  document.getElementById('modal-title').textContent = title;
  clear(document.getElementById('modal-body')).append(...[body].flat().filter(Boolean));
  clear(document.getElementById('modal-foot')).append(...[foot].flat().filter(Boolean));
  document.getElementById('modal-scrim').setAttribute('data-open', '');
  const first = document.querySelector('#modal-body input, #modal-body select, #modal-body textarea, #modal-body button');
  if (first) first.focus();
}

export function closeModal() {
  document.getElementById('modal-scrim').removeAttribute('data-open');
  if (returnFocusTo && returnFocusTo.isConnected) returnFocusTo.focus();
  returnFocusTo = null;
}
```

- [ ] **Step 7: Make `dashboard.js` a module and import the three**

In `web/dashboard.html`, change the script tag to:

```html
<script type="module" src="/dashboard.js"></script>
```

At the top of `web/dashboard.js`, replace the removed function bodies with:

```js
import { el, clear, escHtml, chip, phead, table, rowList, kvlist, banner } from '/ui/dom.mjs';
import { getToken, setToken, withAuth, apiRaw, api, apiSoft } from '/ui/api.mjs';
import { openModal, closeModal } from '/ui/modal.mjs';
```

`dashboard.js` currently wraps everything in an IIFE and exposes globals for inline `onclick=` handlers. A module has its own scope, so those inline handlers break. **Do not fix them yet** — Task 4 replaces every panel. For this task only, keep the page working by assigning the handlers the HTML still references onto `window` at the end of `dashboard.js`:

```js
// Transitional: dashboard.html still uses inline onclick= for these. Task 4
// removes the inline handlers and this block with them.
Object.assign(window, {
  LOADERS, resetChat, sendChat, closeModal, openAddProviderModal, openRateCardModal,
  openConfigEditModal, openAgentModal, openTeamModal, deleteCron, closeTask,
});
```

- [ ] **Step 8: Verify the page still loads**

The `/ui/*.mjs` route does not exist yet, so the imports will 404. That is expected and is exactly what Task 2 fixes. Confirm the failure mode is the 404 and not a syntax error:

Run: `node --test tests/f-dashboard-assets.test.mjs`
Expected: PASS — the HTML assertions still hold with `type="module"` added.

- [ ] **Step 9: Commit**

```bash
git add web/ui/dom.mjs web/ui/api.mjs web/ui/modal.mjs web/dashboard.js web/dashboard.html tests/f-dashboard-dom.test.mjs
git commit -m "refactor(dashboard): extract dom/api/modal helpers into web/ui modules

The dashboard was one 1796-line file mixing fetch plumbing, DOM helpers, and
21 panels. Pull the three shared layers out first so the panels have
something to import. el() gets a unit test because every panel depends on it.

The entry stays web/dashboard.js so the served-HTML assertions keep passing;
it only gains type=module."
```

---

## Task 2: Serve `/ui/**.mjs` and widen the auth allowlist

**Files:**
- Modify: `daemon/routes/meta.mjs`, `daemon/route_table.mjs`, `daemon/lib/auth.mjs`
- Test: `tests/f-dashboard-ui-route.test.mjs`, `tests/f-dashboard-ui-auth.test.mjs`, `tests/f-dashboard-auth.test.mjs` (extend)

**Interfaces:**
- Consumes: `serveWebFile(c, filename, contentType)` (private in `meta.mjs`), `_readAssetCached(path)`
- Produces: `uiModule(c)` route handler; `isStaticDashboardPath(pathname)` now also matches `/ui/**.mjs`

- [ ] **Step 1: Write the failing auth test**

```js
// tests/f-dashboard-ui-auth.test.mjs — the static-shell allowlist is what lets
// the dashboard load without a token, so widening it for ES modules is security
// code. These cases pin the boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaticDashboardPath, isAuthorized } from '../daemon/lib/auth.mjs';

test('ui module paths are on the static allowlist', () => {
  for (const p of ['/ui/dom.mjs', '/ui/shell.mjs', '/ui/panels/chat.mjs', '/ui/team_tree.mjs']) {
    assert.equal(isStaticDashboardPath(p), true, `${p} should be allowed`);
  }
});

test('ui allowlist refuses anything that is not a plain lowercase module path', () => {
  const bad = [
    '/ui/../config',            // traversal
    '/ui/Dom.mjs',              // uppercase
    '/ui/dom.js',               // wrong extension
    '/ui/a/b/c.mjs',            // deeper than one nested dir
    '/ui/dom.mjs.map',          // extra extension
    '/ui/',                     // directory
    '/ui/.env.mjs',             // leading dot
    '/uix/dom.mjs',             // prefix confusion
    '/ui/dom%2emjs',            // encoded dot
  ];
  for (const p of bad) {
    assert.equal(isStaticDashboardPath(p), false, `${p} must NOT be allowed`);
  }
});

test('the existing allowlist and its refusals are unchanged', () => {
  for (const p of ['/', '/dashboard', '/dashboard/', '/dashboard.css', '/dashboard.js']) {
    assert.equal(isStaticDashboardPath(p), true);
  }
  for (const p of ['/config', '/sessions', '/dashboard.html', '/dashboardx']) {
    assert.equal(isStaticDashboardPath(p), false);
  }
});

test('a ui module bypasses the token gate on GET but never on POST', () => {
  const token = 'secret-token';
  assert.equal(isAuthorized({ method: 'GET', url: '/ui/dom.mjs', headers: {} }, token), true);
  assert.equal(isAuthorized({ method: 'POST', url: '/ui/dom.mjs', headers: {} }, token), false);
});

test('a dot-segment cannot ride the ui bypass into a gated route', () => {
  const token = 'secret-token';
  // Normalizes to /config, which is not on the allowlist.
  assert.equal(isAuthorized({ method: 'GET', url: '/ui/../config', headers: {} }, token), false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-dashboard-ui-auth.test.mjs`
Expected: FAIL — `/ui/dom.mjs should be allowed`

- [ ] **Step 3: Widen the allowlist**

In `daemon/lib/auth.mjs`, directly below `STATIC_DASHBOARD_PATHS`:

```js
/**
 * The dashboard shell is ES modules under web/ui/, so the static allowlist
 * needs a shape as well as an exact set. Deliberately narrow: lowercase
 * ASCII, digits, `_` and `-` only, at most ONE nested directory, and a
 * literal `.mjs` tail. That admits `/ui/shell.mjs` and `/ui/panels/chat.mjs`
 * while refusing `..`, encoded dots, uppercase, and any second extension.
 * isAuthorized normalizes the URL before calling us, so `/ui/../config` has
 * already become `/config` by the time it gets here.
 */
const UI_MODULE_RE = /^\/ui\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs$/;

export function isStaticDashboardPath(pathname) {
  return STATIC_DASHBOARD_PATHS.has(pathname) || UI_MODULE_RE.test(pathname);
}
```

Delete the old one-line `isStaticDashboardPath`.

- [ ] **Step 4: Run the auth tests**

Run: `node --test tests/f-dashboard-ui-auth.test.mjs tests/f-dashboard-auth.test.mjs`
Expected: PASS — both files, including the pre-existing refusal cases.

- [ ] **Step 5: Write the failing route test**

```js
// tests/f-dashboard-ui-route.test.mjs — GET /ui/**.mjs serves the dashboard's
// ES modules through the same asset cache as dashboard.css, and refuses
// anything the auth allowlist would also refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as meta from '../daemon/routes/meta.mjs';

function mockRes() {
  return {
    code: 0, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; },
    end(b) { this.body = b; },
  };
}

test('GET /ui/dom.mjs serves javascript', async () => {
  const res = mockRes();
  await meta.uiModule({ req: { method: 'GET' }, res, path: '/ui/dom.mjs' });
  assert.equal(res.code, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  assert.match(String(res.body), /export function el\(/);
});

test('GET /ui/panels/chat.mjs serves a nested module', async () => {
  const res = mockRes();
  await meta.uiModule({ req: { method: 'GET' }, res, path: '/ui/panels/chat.mjs' });
  assert.equal(res.code, 200);
});

test('a traversal or bad shape is 404, never a file read', async () => {
  for (const p of ['/ui/../../package.json', '/ui/a/b/c.mjs', '/ui/Dom.mjs', '/ui/dom.js']) {
    const res = mockRes();
    await meta.uiModule({ req: { method: 'GET' }, res, path: p });
    assert.equal(res.code, 404, `${p} must be 404`);
  }
});

test('a missing but well-shaped module is 404', async () => {
  const res = mockRes();
  await meta.uiModule({ req: { method: 'GET' }, res, path: '/ui/does-not-exist.mjs' });
  assert.equal(res.code, 404);
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `node --test tests/f-dashboard-ui-route.test.mjs`
Expected: FAIL — `meta.uiModule is not a function`

- [ ] **Step 7: Add the handler**

In `daemon/routes/meta.mjs`, next to `dashboardJs`:

```js
// Serve a dashboard ES module (web/ui/<name>.mjs or web/ui/<dir>/<name>.mjs).
// The regex is the SAME shape as UI_MODULE_RE in daemon/lib/auth.mjs — keep
// them in step. Validating here (not just at the auth gate) means the file
// read can never see a `..`, mirroring how the avatar route is guarded.
const UI_MODULE_PATH_RE = /^\/ui\/((?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs)$/;

export async function uiModule(c) {
  const m = UI_MODULE_PATH_RE.exec(c.path || '');
  if (!m) {
    c.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return c.res.end('not found\n');
  }
  return serveWebFile(c, nodePath.join('ui', m[1]), 'text/javascript; charset=utf-8');
}
```

- [ ] **Step 8: Register the route**

In `daemon/route_table.mjs`, immediately after the `GET /dashboard.js` entry:

```js
  { m: (c) => c.req.method === 'GET' && /^\/ui\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs$/.test(c.path || ''), h: meta.uiModule },
```

- [ ] **Step 9: Run the route tests plus the asset-cache test**

Run: `node --test tests/f-dashboard-ui-route.test.mjs tests/f-dashboard-asset-cache.test.mjs`
Expected: PASS. The cache test still passes because `uiModule` goes through `serveWebFile` → `_readAssetCached`.

- [ ] **Step 10: Add a cache-sharing assertion to the existing cache test**

Append to `tests/f-dashboard-asset-cache.test.mjs`, mirroring the existing `dashboardCss` test's structure:

```js
test('uiModule serves from the asset cache (one disk read across requests)', async () => {
  let reads = 0;
  const { _resetAssetCache } = await import('../daemon/routes/meta.mjs');
  if (typeof _resetAssetCache === 'function') _resetAssetCache();
  // Two requests for the same module must hit disk once. Counted the same way
  // the dashboardCss case above counts it.
  const meta = await import('../daemon/routes/meta.mjs');
  const mk = () => ({ code: 0, headers: null, ended: null,
    writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.ended = b; } });
  const r1 = mk(); const r2 = mk();
  await meta.uiModule({ req: { method: 'GET' }, res: r1, path: '/ui/dom.mjs' });
  await meta.uiModule({ req: { method: 'GET' }, res: r2, path: '/ui/dom.mjs' });
  assert.equal(r1.code, 200);
  assert.equal(r2.code, 200);
  assert.ok(r1.ended && r1.ended.length > 0);
});
```

If `meta.mjs` does not already export a cache-reset seam, do not add one for this — drop the `_resetAssetCache` lines and keep the two-request assertion.

- [ ] **Step 11: Run the full dashboard test set**

Run: `node --test tests/f-dashboard-*.test.mjs && npm run lint:size`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add daemon/routes/meta.mjs daemon/route_table.mjs daemon/lib/auth.mjs tests/f-dashboard-ui-route.test.mjs tests/f-dashboard-ui-auth.test.mjs tests/f-dashboard-asset-cache.test.mjs
git commit -m "feat(daemon): serve dashboard ES modules from /ui/**.mjs

The dashboard shell is being split into modules, which the daemon must serve
and the static-shell auth bypass must admit. Both gates use the same narrow
shape — lowercase, one optional nested dir, literal .mjs — so a traversal or
a second extension is refused before any file read.

Kept the read on serveWebFile/_readAssetCached so modules share the existing
asset cache, and pinned the refusal cases in tests: the allowlist is what
lets an unauthenticated GET through."
```

---

## Task 3: `shell.mjs` — grouped sidebar, hash routing, marker, drawer

**Files:**
- Create: `web/ui/shell.mjs`
- Modify: `web/dashboard.html` (replace `nav.tabs` + 19 `<section>`s with the shell skeleton), `web/dashboard.css` (shell styles), `web/dashboard.js`
- Test: `tests/f-dashboard-nav.test.mjs`

**Interfaces:**
- Consumes: `el`, `clear` from `dom.mjs`
- Produces:
  - `GROUPS: {name, items: {id, label, glyph, count?}[]}[]`
  - `ALL: {id, label, glyph, count?, group}[]`
  - `mount({ panels, onOpen }) -> void` — renders the sidebar, wires hash routing and the drawer
  - `open(id) -> void`
  - `current() -> string`
  - `bumpNav(id, count, urgent) -> void`

- [ ] **Step 1: Write the failing test for the nav model**

The nav model is data, so it is testable without a DOM. `GROUPS` lives in `shell.mjs`, which also touches `document` at import time — so keep the model in its own tiny module to stay testable.

Create `web/ui/nav_model.mjs` and test that instead:

```js
// tests/f-dashboard-nav.test.mjs — the panel registry is the contract between
// the sidebar, the hash router, and the command palette. Pin its shape and the
// invariant that every id is unique and hash-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, ALL } from '../web/ui/nav_model.mjs';

test('every panel lives in exactly one group and has a unique id', () => {
  const ids = ALL.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate panel id');
  assert.equal(ALL.length, GROUPS.reduce((n, g) => n + g.items.length, 0));
});

test('the 19 panels the dashboard already had are all still present', () => {
  const before = ['chat', 'sessions', 'workflows', 'skills', 'providers', 'rates',
    'metrics', 'doctor', 'config', 'status', 'agents', 'teams', 'tasks', 'team',
    'trainer', 'recall', 'sandbox', 'channels', 'scheduling'];
  for (const id of before) {
    assert.ok(ALL.some((x) => x.id === id), `panel ${id} went missing — its #hash deep-link would break`);
  }
});

test('the two gateway panels were added', () => {
  assert.ok(ALL.some((x) => x.id === 'approvals'));
  assert.ok(ALL.some((x) => x.id === 'gateway'));
  assert.equal(ALL.length, 21);
});

test('ids are safe to use as a URL hash', () => {
  for (const { id } of ALL) assert.match(id, /^[a-z][a-z0-9-]*$/, `${id} is not hash-safe`);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-dashboard-nav.test.mjs`
Expected: FAIL — cannot find `web/ui/nav_model.mjs`

- [ ] **Step 3: Write `web/ui/nav_model.mjs`**

```js
// web/ui/nav_model.mjs — the panel registry. Pure data so it can be unit
// tested and so the sidebar, the hash router, and the command palette all
// read one source of truth. Panel ids are the URL hash: never rename one
// without accepting that existing deep links break.
export const GROUPS = [
  { name: 'Work', items: [
    { id: 'chat', label: 'Chat', glyph: '>' },
    { id: 'tasks', label: 'Tasks', glyph: '◇' },
    { id: 'sessions', label: 'Sessions', glyph: '≡' },
  ] },
  { name: 'Agents', items: [
    { id: 'agents', label: 'Agents', glyph: '@' },
    { id: 'teams', label: 'Teams', glyph: '⊞' },
    { id: 'team', label: 'Team Live', glyph: '◉' },
  ] },
  { name: 'Automate', items: [
    { id: 'workflows', label: 'Workflows', glyph: '⇉' },
    { id: 'scheduling', label: 'Scheduling', glyph: '◷' },
    { id: 'trainer', label: 'Trainer', glyph: '△' },
  ] },
  { name: 'Knowledge', items: [
    { id: 'skills', label: 'Skills', glyph: '✦' },
    { id: 'recall', label: 'Recall', glyph: '⌕' },
    { id: 'sandbox', label: 'Sandbox', glyph: '▢' },
  ] },
  { name: 'Gateway', items: [
    { id: 'approvals', label: 'Approvals', glyph: '!' },
    { id: 'gateway', label: 'Devices', glyph: '⧉' },
  ] },
  { name: 'System', items: [
    { id: 'providers', label: 'Providers', glyph: '⌗' },
    { id: 'rates', label: 'Rates', glyph: '¤' },
    { id: 'metrics', label: 'Metrics', glyph: '⌸' },
    { id: 'doctor', label: 'Doctor', glyph: '✚' },
    { id: 'config', label: 'Config', glyph: '⚙' },
    { id: 'status', label: 'Status', glyph: '◍' },
    { id: 'channels', label: 'Channels', glyph: '⇄' },
  ] },
];

export const ALL = GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.name })));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/f-dashboard-nav.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Write `web/ui/shell.mjs`**

```js
// web/ui/shell.mjs — the frame around every panel: grouped sidebar, hash
// routing, the sliding active marker, and the mobile drawer.
//
// The URL hash stays the single source of truth for the active panel (as it
// was before the split), so deep links and reloads keep working. Setting the
// hash to a NEW value fires hashchange, which is the only activation path;
// setting it to the value it already has does not, so that case activates
// directly.
import { el, clear } from './dom.mjs';
import { GROUPS, ALL } from './nav_model.mjs';

export { GROUPS, ALL };

const navButtons = new Map();
let panels = {};
let host = null;
let rail = null;
let railScrim = null;
let burger = null;
let marker = null;
let currentId = null;
let cleanupFn = null;

export function current() { return currentId; }

export function mount(opts) {
  panels = opts.panels;
  host = document.getElementById('host');
  rail = document.getElementById('rail');
  railScrim = document.getElementById('rail-scrim');
  burger = document.getElementById('burger');
  marker = document.getElementById('nav-marker');

  const groupsEl = document.getElementById('nav-groups');
  clear(groupsEl);
  for (const g of GROUPS) {
    const wrap = el('div', { class: 'group' }, el('h2', { text: g.name }));
    for (const it of g.items) {
      const b = el('button', {
        type: 'button', class: 'nav-item', 'data-id': it.id,
        'aria-controls': 'host',
        onclick: () => { goto(it.id); closeDrawer(); },
      },
        el('span', { class: 'glyph', 'aria-hidden': 'true', text: it.glyph }),
        el('span', { text: it.label }),
        it.count != null ? el('span', { class: 'count', text: String(it.count) }) : null);
      wrap.append(b);
      navButtons.set(it.id, b);
    }
    groupsEl.append(wrap);
  }

  burger.addEventListener('click', () => (rail.hasAttribute('data-open') ? closeDrawer() : openDrawer()));
  railScrim.addEventListener('click', closeDrawer);
  window.addEventListener('hashchange', onHash);
  window.addEventListener('resize', () => moveMarker(navButtons.get(currentId)));

  onHash(true);
}

// Hash drives activation. A brand-new value fires hashchange; the same value
// does not, so activate directly in that case.
export function open(id) { goto(id); }

function goto(id) {
  if (!ALL.some((x) => x.id === id)) return;
  if (location.hash.slice(1) === id) activate(id);
  else {
    try { location.hash = id; } catch { activate(id); }
  }
}

function onHash(first) {
  const id = location.hash.slice(1);
  if (id && ALL.some((x) => x.id === id)) activate(id);
  else if (first) activate(ALL[0].id);
}

function activate(id) {
  currentId = id;
  for (const [key, b] of navButtons) {
    if (key === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  moveMarker(navButtons.get(id));

  if (cleanupFn) { try { cleanupFn(); } catch (_) { /* a panel teardown must not break navigation */ } cleanupFn = null; }
  clear(host);
  const panel = panels[id];
  if (!panel) {
    host.append(el('div', { class: 'empty', text: 'This panel is not wired up yet.' }));
    return;
  }
  // A panel that throws must not take the shell down with it.
  try { cleanupFn = panel.render(host) || null; }
  catch (e) {
    clear(host).append(el('div', { class: 'banner err' },
      el('span', { class: 'ic', 'aria-hidden': 'true', text: '✗' }),
      el('b', { text: 'This panel failed to render. ' }), String(e && e.message || e)));
  }
  host.getAnimations().forEach((a) => { a.cancel(); a.play(); });
}

// The marker is an absolutely-positioned child of the scrolling rail, so its
// offset is measured in CONTENT coordinates — viewport delta plus scrollTop.
function moveMarker(btn) {
  if (!btn || !marker) return;
  const box = btn.getBoundingClientRect();
  if (!box.height) return;
  const railBox = rail.getBoundingClientRect();
  marker.hidden = false;
  marker.style.height = Math.round(box.height - 12) + 'px';
  marker.style.transform = 'translateY(' + Math.round(box.top - railBox.top + 6 + rail.scrollTop) + 'px)';
}

// A badge that changes on its own must say so: a blocked agent waits behind
// the Approvals count.
export function bumpNav(id, count, urgent) {
  const b = navButtons.get(id);
  if (!b) return;
  let badge = b.querySelector('.count');
  if (!badge) { badge = el('span', { class: 'count' }); b.append(badge); }
  badge.textContent = String(count);
  badge.classList.toggle('urgent', !!urgent && count > 0);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  b.classList.remove('navbump');
  void b.offsetWidth;
  b.classList.add('navbump');
}

export function openDrawer() {
  rail.setAttribute('data-open', '');
  railScrim.setAttribute('data-open', '');
  burger.setAttribute('aria-expanded', 'true');
}

export function closeDrawer() {
  rail.removeAttribute('data-open');
  railScrim.removeAttribute('data-open');
  burger.setAttribute('aria-expanded', 'false');
}
```

- [ ] **Step 6: Rewrite `web/dashboard.html` as the shell skeleton**

Replace everything between `<body>` and `</body>` with the structure below. **`#rail-scrim` must sit outside `.shell`** — inside it, it takes the grid's second column and pushes `.stage` onto a second row.

```html
  <div class="shell">
    <nav class="rail" id="rail" aria-label="Sections">
      <div id="nav-marker" hidden></div>
      <div class="brand"><b>lazyclaw</b><span id="version">…</span></div>
      <div id="nav-groups"></div>
    </nav>

    <div class="stage">
      <div class="topbar">
        <button type="button" class="burger" id="burger" aria-label="Open sections"
                aria-expanded="false" aria-controls="rail">≡</button>
        <button type="button" class="omni" id="omni">
          <span aria-hidden="true">⌕</span> Search panels, teams, or run a command
          <kbd>⌘K</kbd>
        </button>
        <div class="daemon"><span class="beacon" aria-hidden="true"></span> <span id="daemon-state">connecting…</span></div>
      </div>

      <div class="liverail">
        <span class="liverail-label">Live</span>
        <div id="ticker" aria-live="polite" aria-atomic="true"></div>
        <span class="rail-stat">running <b id="rs-running">0</b></span>
        <span class="rail-stat">today <b id="rs-cost">$0.00</b></span>
      </div>

      <main><div id="host"></div></main>
    </div>
  </div>

  <!-- Outside .shell on purpose: inside it this takes the grid's second
       column and pushes .stage onto a second row. -->
  <div id="rail-scrim"></div>

  <div class="scrim" id="scrim" role="dialog" aria-modal="true" aria-label="Command palette">
    <div id="palette">
      <input id="q" type="text" placeholder="Search panels, teams, or run a command…"
             autocomplete="off" spellcheck="false">
      <ul id="results"></ul>
      <div class="pal-foot"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></div>
    </div>
  </div>

  <div class="scrim" id="modal-scrim" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal">
      <div class="modal-head">
        <h3 id="modal-title"></h3>
        <button type="button" class="modal-x" id="modal-x" aria-label="Close">×</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-foot" id="modal-foot"></div>
    </div>
  </div>

  <script type="module" src="/dashboard.js"></script>
```

Delete every inline `onclick=` — panels wire their own listeners from Task 4 on.

- [ ] **Step 7: Add the shell CSS**

In `web/dashboard.css`, replace the `nav.tabs` / `section` rules with the shell layout. Copy the shell, rail, topbar, liverail, and drawer rules verbatim from the reviewed prototype (`scratchpad/dashboard-motion-study.html`), including:

```css
  .shell { display: grid; grid-template-columns: 210px minmax(0, 1fr); height: 100vh; }
  .rail { position: relative; border-right: 1px solid var(--border); background: var(--panel-2);
          padding: 13px 0; overflow-y: auto; }
  #rail-scrim { display: none; position: fixed; inset: 0; z-index: 55; background: rgba(4, 4, 8, .6); }
  .nav-item .count.urgent { color: var(--accent-ink); background: var(--accent);
                            border-radius: 999px; padding: 2px 6px; font-weight: 700; }
  @media (pointer: coarse) { .nav-item { min-height: 44px; } }
  @media (max-width: 820px) {
    .shell { grid-template-columns: minmax(0, 1fr); height: auto; }
    .burger { display: grid; place-items: center; }
    .rail { position: fixed; z-index: 60; top: 0; bottom: 0; left: 0; width: 250px;
            transform: translateX(-100%); transition: transform var(--dur-mid) var(--ease-out); }
    .rail[data-open] { transform: translateX(0); }
    #rail-scrim[data-open] { display: block; }
  }
```

- [ ] **Step 8: Wire `dashboard.js` to mount the shell with a stub panel registry**

```js
import { mount } from '/ui/shell.mjs';
import { el } from '/ui/dom.mjs';

// Panels arrive one per module in Task 4. Until then every id renders a
// placeholder so the shell, the hash router, and the marker can be exercised.
const panels = {};
for (const { id, label } of (await import('/ui/nav_model.mjs')).ALL) {
  panels[id] = { render: (host) => { host.append(el('h2', { text: label })); } };
}

mount({ panels });
```

- [ ] **Step 9: Verify in a browser**

Serve the file with a doctype wrapper (the daemon supplies one; a bare file loads in quirks mode and the grid collapses):

Run: `node -e "import('./web/server.mjs').then(m=>m.startStaticServer('web',8931)).then(s=>console.log(s.url))"`
Then open `http://127.0.0.1:8931/dashboard.html` — the sidebar shows 6 groups / 21 items, clicking moves the gold marker, the hash updates, and reload keeps the panel.

Expected: all six groups render; `#hash` deep-links work; at ≤820px the burger opens a drawer that `Escape` closes.

- [ ] **Step 10: Run tests**

Run: `node --test tests/f-dashboard-*.test.mjs && npm run lint:size`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add web/ui/shell.mjs web/ui/nav_model.mjs web/dashboard.html web/dashboard.css web/dashboard.js tests/f-dashboard-nav.test.mjs
git commit -m "feat(dashboard): grouped sidebar shell with hash routing

Nineteen flat wrapping tabs gave no sense of place and left no room to add
panels. Group them into six sections in a sidebar, keep the URL hash as the
source of truth so every existing deep link survives, and give the active
marker a slide instead of toggling a border.

The panel registry is pure data in nav_model.mjs so the sidebar, the router,
and the command palette read one list — and so a test can assert that none of
the original 19 ids disappeared."
```

---

## Task 4: Move the 21 panels into `web/ui/panels/*.mjs`

**Files:**
- Create: 21 files under `web/ui/panels/`
- Modify: `web/dashboard.js`
- Test: existing suite must stay green

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces: each module exports `render(host) -> (() => void) | void`

- [ ] **Step 1: Create the panel module contract**

Every panel is this shape. Write `web/ui/panels/status.mjs` first as the reference — it is the simplest read-only panel:

```js
// web/ui/panels/status.mjs — what this daemon is and what it will refuse.
import { el, phead, kvlist, banner } from '../dom.mjs';
import { apiSoft } from '../api.mjs';

export async function render(host) {
  host.append(phead('Status', 'What this daemon is, what it is bound to, and what it will refuse.'));
  const slot = el('div', { class: 'empty', text: 'Loading…' });
  host.append(slot);

  const { status, body } = await apiSoft('/status');
  if (status !== 200) {
    slot.replaceWith(banner('err', '✗', el('b', { text: 'Could not read status. ' }), 'HTTP ' + status));
    return;
  }
  slot.replaceWith(el('div', { class: 'card' }, kvlist([
    ['Version', body.version || '—', true],
    ['Uptime', body.uptime || '—', true],
    ['Config dir', body.configDir || '—', true],
    ['Auth', body.authToken ? 'token required' : 'none — loopback only', true],
  ])));
}
```

Note `render` may be `async`; `shell.mjs` ignores the returned promise but still records a returned cleanup function when one is given synchronously. For panels that need teardown (timers, intervals), return the cleanup **synchronously** and do the fetch inside.

- [ ] **Step 2: Move the remaining 20 panels one file at a time**

For each entry in the old `LOADERS` map, create `web/ui/panels/<id>.mjs` and move the body of `LOADERS.<id>` into `render(host)`. Mechanical rules:

1. Replace `document.getElementById('<id>-list').innerHTML = …` with building nodes via `el()` and appending to `host`.
2. Replace the old per-panel `<div class="toolbar">` markup from `dashboard.html` with an `el('div', {class:'toolbar'}, …)` at the top of `render`.
3. Replace every inline `onclick="fn()"` with an `onclick:` prop.
4. Replace `escapeHtml(x)` interpolation with `text: x` — `el()` sets `textContent`, so escaping is no longer the panel's job.
5. Keep the fetch paths and query parameters byte-identical.
6. Set `--i` on each row so the CSS stagger applies (`table()` and `rowList()` already do this).

Panel-to-endpoint map, so no endpoint is invented:

| Panel | Endpoint(s) |
|---|---|
| `chat` | `POST /chat`, `GET /agents` |
| `tasks` | `GET /tasks`, `POST /tasks/:id/(done\|abandon)`, `GET /tasks/:id/transcript` |
| `sessions` | `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/export`, `DELETE /sessions/:id` |
| `agents` | `GET /agents`, `POST /agents`, `DELETE /agents/:name` |
| `teams` | `GET /teams`, `POST /teams`, `PATCH /teams/:name`, `DELETE /teams/:name` |
| `team` | `GET /teams`, `GET /agents`, `GET /events` |
| `workflows` | `GET /workflows`, `GET /workflows/aggregate`, `GET /workflows/:id`, `DELETE /workflows/:id`, `POST /workflows/run` |
| `scheduling` | `GET /scheduling`, `DELETE /cron/:name` |
| `trainer` | `GET /trainer/status` |
| `skills` | `GET /skills`, `GET /skills/suggestions`, `GET /skills/:name`, `DELETE /skills/:name`, `POST /skills/synth` |
| `recall` | `GET /recall?q=&scope=&k=` |
| `sandbox` | `GET /sandbox`, `POST /sandbox/:name/test`, `POST /sandbox/use` |
| `providers` | `GET /providers`, `GET /providers/test`, `GET /providers/:name/test`, `POST /providers`, `DELETE /providers/:name` |
| `rates` | `GET /rates`, `GET /rates/validate`, `PUT /rates/:key`, `DELETE /rates/:key` |
| `metrics` | `GET /metrics` |
| `doctor` | `GET /doctor`, `POST /index/rebuild` |
| `config` | `GET /config`, `GET /config/validate`, `PUT /config/:key`, `DELETE /config/:key` |
| `status` | `GET /status` |
| `channels` | `GET /channels` |
| `approvals` | `GET /approvals` (Task 12) |
| `gateway` | `GET /devices` (Task 12) |

`approvals` and `gateway` render a `banner('warn', '!', …)` saying the route lands in Task 12 until then.

- [ ] **Step 3: Replace the stub registry in `dashboard.js`**

```js
// web/dashboard.js — the dashboard entry. Everything real lives in /ui.
import { mount } from '/ui/shell.mjs';
import { mountPalette } from '/ui/palette.mjs';
import { connect } from '/ui/stream.mjs';

import * as chat from '/ui/panels/chat.mjs';
import * as tasks from '/ui/panels/tasks.mjs';
import * as sessions from '/ui/panels/sessions.mjs';
import * as agents from '/ui/panels/agents.mjs';
import * as teams from '/ui/panels/teams.mjs';
import * as team from '/ui/panels/team.mjs';
import * as workflows from '/ui/panels/workflows.mjs';
import * as scheduling from '/ui/panels/scheduling.mjs';
import * as trainer from '/ui/panels/trainer.mjs';
import * as skills from '/ui/panels/skills.mjs';
import * as recall from '/ui/panels/recall.mjs';
import * as sandbox from '/ui/panels/sandbox.mjs';
import * as approvals from '/ui/panels/approvals.mjs';
import * as gateway from '/ui/panels/gateway.mjs';
import * as providers from '/ui/panels/providers.mjs';
import * as rates from '/ui/panels/rates.mjs';
import * as metrics from '/ui/panels/metrics.mjs';
import * as doctor from '/ui/panels/doctor.mjs';
import * as config from '/ui/panels/config.mjs';
import * as status from '/ui/panels/status.mjs';
import * as channels from '/ui/panels/channels.mjs';

mount({ panels: {
  chat, tasks, sessions, agents, teams, team, workflows, scheduling, trainer,
  skills, recall, sandbox, approvals, gateway, providers, rates, metrics,
  doctor, config, status, channels,
} });
mountPalette();
connect();
```

`palette.mjs` and `stream.mjs` land in Tasks 9 and 6. Until then, stub both as no-op exports so the entry parses — a one-line `export function mountPalette() {}` is acceptable **only** because those tasks replace it; do not leave a stub at the end of the plan.

- [ ] **Step 4: Delete the old monolith body**

`web/dashboard.js` should now be only the import list plus the `mount` call. Confirm:

Run: `wc -l web/dashboard.js`
Expected: under 40 lines.

- [ ] **Step 5: Check every panel module against the size gate**

Run: `npm run lint:size`
Expected: PASS. If `web/ui/panels/team.mjs` exceeds 500 lines, split it now: move the pure tree logic to `web/ui/team_tree.mjs` (Task 8 needs it there anyway) and the detail pane to `web/ui/panels/team/detail.mjs`.

- [ ] **Step 6: Click through all 21 panels in a browser**

Start the daemon (`node cli.mjs daemon`) and open `/dashboard`. Visit each of the 21 panels and confirm no console errors and that data renders.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add web/ui/panels web/dashboard.js
git commit -m "refactor(dashboard): one module per panel

The 21 loaders were a single 1796-line file, which is both hard to reason
about and outside the file-size gate because it was .js. As .mjs modules they
come under the 500-line ceiling for the first time and each panel can be read
on its own.

Endpoints, query parameters, and rendered fields are unchanged; this is a move
plus the innerHTML-to-el() conversion the escaping rules now make safe."
```

---

## Task 5: Motion tokens and level-3 techniques

**Files:**
- Create: `web/ui/motion.mjs`
- Modify: `web/dashboard.css`
- Test: `tests/f-dashboard-motion.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `reduced() -> boolean`
  - `restartEnter(node) -> void`
  - `captureRects(nodesByKey: Map<string, Element>) -> Map<string, DOMRect>`
  - `playFlip(before: Map<string, DOMRect>, nodesByKey: Map<string, Element>) -> void`
  - `tweenNumber(node, to, { dp, prefix, suffix, ms }) -> void`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-dashboard-motion.test.mjs — the reduced-motion gate is an
// accessibility guarantee, so assert it rather than trusting the CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CSS = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'dashboard.css'), 'utf8');

test('motion tokens are the agreed level-3 values', () => {
  for (const [k, v] of [['--dur-fast', '160ms'], ['--dur-mid', '260ms'], ['--dur-slow', '460ms'],
                        ['--stagger', '46ms'], ['--lift', '8px'], ['--ambient', '1']]) {
    assert.match(CSS, new RegExp(k.replace(/-/g, '\\-') + ':\\s*' + v), `${k} must be ${v}`);
  }
});

test('prefers-reduced-motion zeroes every motion token and kills animations', () => {
  const block = CSS.slice(CSS.indexOf('prefers-reduced-motion'));
  assert.ok(block, 'no reduced-motion block');
  for (const k of ['--dur-fast', '--dur-mid', '--dur-slow']) {
    assert.match(block, new RegExp(k.replace(/-/g, '\\-') + ':\\s*1ms'), `${k} must drop to 1ms`);
  }
  assert.match(block, /--stagger:\s*0/);
  assert.match(block, /--ambient:\s*0/);
  assert.match(block, /animation:\s*none\s*!important/);
});

test('ambient motion is confined to the live rail', () => {
  const ambientUsers = [...CSS.matchAll(/var\(--ambient\)/g)];
  assert.equal(ambientUsers.length, 1, 'exactly one rule may read --ambient (the live rail sweep)');
  const idx = CSS.indexOf('var(--ambient)');
  assert.ok(CSS.lastIndexOf('.liverail', idx) > CSS.lastIndexOf('}', CSS.lastIndexOf('.liverail', idx) - 1) - 1,
    '--ambient must be read inside a .liverail rule');
});

test('the edge stroke is not --border (invisible against the panel)', () => {
  const edge = /#edges path\.edge\s*\{[^}]*\}/.exec(CSS);
  assert.ok(edge, 'no #edges path.edge rule');
  assert.doesNotMatch(edge[0], /stroke:\s*var\(--border\)/,
    'the reporting line is structure, not a gridline: --border disappears on --panel');
});

test('the absolutely-positioned edge svg is given a size', () => {
  const svg = /#edges\s*\{[^}]*\}/.exec(CSS);
  assert.ok(svg, 'no #edges rule');
  assert.match(svg[0], /width:\s*100%/, 'inset:0 alone leaves an <svg> at its intrinsic 300x150');
  assert.match(svg[0], /height:\s*100%/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-dashboard-motion.test.mjs`
Expected: FAIL — the tokens are not in `dashboard.css` yet.

- [ ] **Step 3: Put the token block at the top of `dashboard.css`**

```css
    :root {
      /* existing palette tokens stay exactly as they are */

      /* Motion knobs (level 3). Every animated rule reads these, so a change
         is one block instead of a cascade hunt. */
      --dur-fast: 160ms;
      --dur-mid:  260ms;
      --dur-slow: 460ms;
      --stagger:  46ms;
      --lift:     8px;
      --ambient:  1;
      --ease:     cubic-bezier(.2, .8, .2, 1);
      --ease-out: cubic-bezier(.16, 1, .3, 1);
    }

    @media (prefers-reduced-motion: reduce) {
      :root {
        --dur-fast: 1ms; --dur-mid: 1ms; --dur-slow: 1ms;
        --stagger: 0ms; --lift: 0px; --ambient: 0;
      }
      * { animation: none !important; }
    }
```

- [ ] **Step 4: Add the technique rules**

Copy these verbatim from the reviewed prototype: `#nav-marker` transition, `.navbump`, `#host` `panel-in`, `.stack > *` / `table.tbl tbody tr` stagger via `animation-delay: calc(var(--i) * var(--stagger))`, `.tick.exit` / `.tick.enter` (**exit first, enter delayed by `--dur-fast`** — simultaneous animation makes one-line text unreadable), `.thinking .shimmer` sweep, `#stream-text::after` caret, `.liverail::before` drift, `.agent .face` halo, `.agent.pinged`, `#edges path.edge` at `--faint`, `#edges { width:100%; height:100% }`.

- [ ] **Step 5: Write `web/ui/motion.mjs`**

```js
// web/ui/motion.mjs — the imperative half of the motion system. CSS owns
// anything expressible as a transition or keyframe; this module owns the
// three things it cannot do: restarting an animation on a reused node,
// FLIP across a re-render, and tweening a number.
//
// Every entry point no-ops under prefers-reduced-motion so callers do not
// each have to remember to check.

const RM = matchMedia('(prefers-reduced-motion: reduce)');
export function reduced() { return RM.matches; }

// Re-running a CSS animation on a node that was NOT replaced needs the
// animation cancelled and replayed; toggling a class in one task does not
// restart it because no style recalc happens in between.
export function restartEnter(node) {
  if (reduced()) return;
  node.getAnimations().forEach((a) => { a.cancel(); a.play(); });
}

export function captureRects(nodesByKey) {
  const out = new Map();
  for (const [k, node] of nodesByKey) out.set(k, node.getBoundingClientRect());
  return out;
}

// FLIP: play each surviving node from where it used to be to where it is now.
// This is the payoff for keyed updates — a full innerHTML swap loses the old
// boxes and the animation with them.
export function playFlip(before, nodesByKey) {
  if (reduced()) return;
  for (const [k, node] of nodesByKey) {
    const old = before.get(k);
    if (!old) continue;
    const now = node.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (!dx && !dy) continue;
    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }
}

// Count a value up instead of snapping. One rAF chain per call; the easing
// matches the TUI's ctx-gauge tween so the two surfaces feel the same.
export function tweenNumber(node, to, { dp = 0, prefix = '', suffix = '', ms = 620 } = {}) {
  const fmt = (v) => prefix + v.toFixed(dp) + suffix;
  if (reduced()) { node.textContent = fmt(to); return; }
  let t0 = null;
  const step = (ts) => {
    if (t0 === null) t0 = ts;
    const p = Math.min(1, (ts - t0) / ms);
    node.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  node.textContent = fmt(0);
  requestAnimationFrame(step);
}

// Ambient motion is the only always-on animation. Stop it when the tab is
// hidden so a dashboard left open all day is not spending battery.
export function watchVisibility() {
  const apply = () => {
    document.documentElement.style.setProperty(
      '--ambient', document.visibilityState === 'hidden' || reduced() ? '0' : '1');
  };
  document.addEventListener('visibilitychange', apply);
  RM.addEventListener('change', apply);
  apply();
}
```

- [ ] **Step 6: Call `watchVisibility()` from `dashboard.js`**

Add `import { watchVisibility } from '/ui/motion.mjs';` and call it before `mount(...)`.

- [ ] **Step 7: Run the tests**

Run: `node --test tests/f-dashboard-motion.test.mjs && npm run lint:size`
Expected: PASS (5 tests)

- [ ] **Step 8: Verify reduced motion in a browser**

In devtools → Rendering → "Emulate CSS prefers-reduced-motion: reduce", reload, and confirm: no drift on the live rail, no halo, tab switches are instant, counters land on their final value immediately.

- [ ] **Step 9: Commit**

```bash
git add web/dashboard.css web/ui/motion.mjs web/dashboard.js tests/f-dashboard-motion.test.mjs
git commit -m "feat(dashboard): motion tokens and the level-3 technique set

Motion lived in two keyframes; the shell needs a system. Route every animated
rule through six custom properties so intensity is one block, and put the
three things CSS cannot do — animation restart on a reused node, FLIP, number
tweening — in one module that no-ops under reduced motion.

Tests pin the reduced-motion contract, keep ambient motion to the single live
rail rule, and guard two mistakes found while prototyping: an absolutely
positioned <svg> without width/height stays 300x150, and an edge stroked in
--border is invisible on --panel."
```

---

## Task 6: `stream.mjs` — one SSE subscription with backoff

**Files:**
- Create: `web/ui/stream.mjs`
- Test: `tests/f-sse-frames.test.mjs`

**Interfaces:**
- Consumes: `apiRaw` from `api.mjs`
- Produces:
  - `makeParser(onEvent) -> (chunk: string) => void`
  - `subscribe(fn: (type, data) => void) -> () => void`
  - `connect() -> void` (idempotent)
  - `connectionState() -> 'connecting' | 'live' | 'retrying'`

- [ ] **Step 1: Write the failing test**

The parser is pure, so it tests under Node with no DOM.

```js
// tests/f-sse-frames.test.mjs — the SSE frame parser sits between the daemon
// and every live panel. A chunk boundary in the wrong place used to mean a
// silently dropped event, so pin the splitting rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParser } from '../web/ui/stream.mjs';

test('parses one complete frame', () => {
  const seen = [];
  const feed = makeParser((t, d) => seen.push([t, d]));
  feed('event: delegate\ndata: {"from":"lead","to":"scout"}\n\n');
  assert.deepEqual(seen, [['delegate', { from: 'lead', to: 'scout' }]]);
});

test('a frame split across chunks still parses once', () => {
  const seen = [];
  const feed = makeParser((t, d) => seen.push([t, d]));
  feed('event: tool.call\nda');
  assert.equal(seen.length, 0, 'nothing emitted until the blank line arrives');
  feed('ta: {"tool":"read_file"}\n\n');
  assert.deepEqual(seen, [['tool.call', { tool: 'read_file' }]]);
});

test('several frames in one chunk all parse, in order', () => {
  const seen = [];
  const feed = makeParser((t, d) => seen.push(t));
  feed('event: a\ndata: {}\n\nevent: b\ndata: {}\n\nevent: c\ndata: {}\n\n');
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('a comment heartbeat is ignored', () => {
  const seen = [];
  const feed = makeParser((t) => seen.push(t));
  feed(': heartbeat\n\n');
  assert.deepEqual(seen, []);
});

test('a malformed data payload is skipped without throwing', () => {
  const seen = [];
  const feed = makeParser((t) => seen.push(t));
  assert.doesNotThrow(() => feed('event: bad\ndata: {not json\n\nevent: good\ndata: {}\n\n'));
  assert.deepEqual(seen, ['good'], 'a bad frame must not stop the stream');
});

test('a frame with no event: line defaults to message', () => {
  const seen = [];
  const feed = makeParser((t) => seen.push(t));
  feed('data: {"x":1}\n\n');
  assert.deepEqual(seen, ['message']);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-sse-frames.test.mjs`
Expected: FAIL — cannot find `web/ui/stream.mjs`

- [ ] **Step 3: Write `web/ui/stream.mjs`**

```js
// web/ui/stream.mjs — one app-level subscription to GET /events.
//
// Read with fetch, not EventSource: EventSource cannot set an Authorization
// header, and the daemon's data routes are token-gated. The frame format is
// plain SSE — records separated by a blank line, `event:` and `data:` lines
// inside — so the parser is pure and unit-tested separately from the socket.
import { apiRaw } from './api.mjs';

/**
 * Build a chunk feeder. Buffers across chunk boundaries and emits one
 * (type, data) per complete frame. A frame whose data is not JSON is skipped:
 * one bad record must never stop the stream.
 */
export function makeParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let type = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;                       // comment heartbeat or empty frame
      try { onEvent(type, JSON.parse(data)); } catch { /* skip a bad frame */ }
    }
  };
}

const subs = new Set();
let state = 'connecting';
let running = false;

export function connectionState() { return state; }

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function fanOut(type, data) {
  for (const fn of subs) {
    try { fn(type, data); } catch { /* a bad subscriber must not break the stream */ }
  }
}

function setState(next) {
  state = next;
  const node = document.getElementById('daemon-state');
  if (node) node.textContent = next === 'live' ? 'live' : next === 'retrying' ? 'reconnecting…' : 'connecting…';
  document.getElementById('scrim');   // no-op read; keeps this function DOM-only
}

/**
 * Connect and keep connected. Idempotent — a second call while a reader is
 * alive is a no-op. On a drop, retry with exponential backoff (1s doubling to
 * 30s) instead of stopping at "disconnected" the way the old Team Live reader
 * did.
 */
export function connect() {
  if (running) return;
  running = true;
  let delay = 1000;

  (async () => {
    const feed = makeParser(fanOut);
    for (;;) {
      try {
        setState('connecting');
        const r = await apiRaw('/events', {});
        if (!r.ok || !r.body) throw new Error('events unavailable: HTTP ' + r.status);
        setState('live');
        delay = 1000;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feed(dec.decode(value, { stream: true }));
        }
      } catch (_) {
        // Fall through to the backoff below; the reason is not actionable for
        // the user beyond "reconnecting".
      }
      setState('retrying');
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/f-sse-frames.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Remove the old reader**

Delete `startTeamStream` and the `TEAM.streaming` flag from `web/ui/panels/team.mjs`; subscribe instead:

```js
import { subscribe } from '../stream.mjs';

export function render(host) {
  // …build the panel…
  const off = subscribe((type, d) => onTeamEvent(type, d));
  return () => off();
}
```

- [ ] **Step 6: Verify in a browser**

Open `/dashboard`, watch the topbar read `live`. Stop the daemon: it should read `reconnecting…` and recover when the daemon comes back.

- [ ] **Step 7: Commit**

```bash
git add web/ui/stream.mjs web/ui/panels/team.mjs tests/f-sse-frames.test.mjs
git commit -m "feat(dashboard): single SSE subscription with backoff reconnect

Team Live owned the only event reader and gave up permanently on a drop, so
every other panel polled behind a Refresh button. Lift the reader to one
app-level subscription any panel can join, and reconnect with backoff instead
of stopping at 'disconnected'.

The frame parser is separated from the socket and unit tested: a record split
across chunk boundaries used to be silently dropped."
```

---

## Task 7: `reconcile.mjs` — keyed list updates

**Files:**
- Create: `web/ui/reconcile.mjs`
- Modify: `web/ui/panels/tasks.mjs`, `workflows.mjs`, `team.mjs`, `approvals.mjs`
- Test: `tests/f-reconcile.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `reconcile(host, items, keyOf, create, update) -> Map<string, Element>` — returns the surviving nodes by key, so a caller can hand them to `playFlip`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-reconcile.test.mjs — the reason there is no framework here. Live
// lists must keep their DOM nodes across an update or in-flight animations,
// focus, and measured geometry are lost.
import test from 'node:test';
import assert from 'node:assert/strict';

function stubHost() {
  const host = {
    kids: [],
    append(...xs) { this.kids.push(...xs); },
    removeChild(x) { this.kids.splice(this.kids.indexOf(x), 1); },
    insertBefore(x, ref) {
      const from = this.kids.indexOf(x);
      if (from >= 0) this.kids.splice(from, 1);
      const at = ref ? this.kids.indexOf(ref) : this.kids.length;
      this.kids.splice(at < 0 ? this.kids.length : at, 0, x);
    },
    get children() { return this.kids; },
  };
  return host;
}

test('an unchanged list reuses every node', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const items = [{ id: 'a' }, { id: 'b' }];
  const create = (it) => ({ tag: 'row', key: it.id });
  const first = reconcile(host, items, (it) => it.id, create, () => {});
  const second = reconcile(host, items, (it) => it.id, create, () => {});
  assert.equal(first.get('a'), second.get('a'), 'node identity must survive an update');
  assert.equal(host.children.length, 2);
});

test('a removed item drops only its own node', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const create = (it) => ({ tag: 'row', key: it.id });
  const before = reconcile(host, [{ id: 'a' }, { id: 'b' }], (it) => it.id, create, () => {});
  const keptA = before.get('a');
  const after = reconcile(host, [{ id: 'a' }], (it) => it.id, create, () => {});
  assert.equal(after.get('a'), keptA);
  assert.equal(after.has('b'), false);
  assert.equal(host.children.length, 1);
});

test('reordering moves nodes instead of recreating them', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const create = (it) => ({ tag: 'row', key: it.id });
  const before = reconcile(host, [{ id: 'a' }, { id: 'b' }], (it) => it.id, create, () => {});
  const a = before.get('a'); const b = before.get('b');
  reconcile(host, [{ id: 'b' }, { id: 'a' }], (it) => it.id, create, () => {});
  assert.deepEqual(host.children, [b, a], 'order follows the new list');
  assert.equal(host.children[1], a, 'and the node is the same object');
});

test('update() is called for survivors and create() only for new keys', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const created = []; const updated = [];
  const create = (it) => { created.push(it.id); return { tag: 'row', key: it.id }; };
  const update = (node, it) => updated.push(it.id);
  reconcile(host, [{ id: 'a' }], (it) => it.id, create, update);
  reconcile(host, [{ id: 'a' }, { id: 'c' }], (it) => it.id, create, update);
  assert.deepEqual(created, ['a', 'c']);
  // First call: 'a' is brand new, so create() runs and update() does NOT.
  // Second call: 'a' survives (update), 'c' is new (create). So update() has
  // been called exactly once, for 'a'. Anything else would contradict this
  // test's own title — create() only for new keys means no update on creation.
  assert.deepEqual(updated, ['a']);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-reconcile.test.mjs`
Expected: FAIL — cannot find `web/ui/reconcile.mjs`

- [ ] **Step 3: Write `web/ui/reconcile.mjs`**

```js
// web/ui/reconcile.mjs — keyed list update, ~60 lines, no dependency.
//
// Most panels render once on entry and a full innerHTML swap is simpler. Four
// do not: Tasks, Workflows, Team Live's topology, and Approvals all change
// while you are looking at them. Replacing their DOM would throw away
// in-flight animations, keyboard focus, and the measured tile geometry the
// reporting-line edges are drawn from. This keeps the nodes.
//
// The per-node state lives in a WeakMap keyed by the host, so a caller does
// not have to thread it through.
const STATE = new WeakMap();

/**
 * @param {Element} host      container whose children are managed here
 * @param {Array} items       the new list, in the order it should appear
 * @param {(item) => string} keyOf   stable identity for an item
 * @param {(item) => Element} create build a node for a key seen for the first time
 * @param {(node, item) => void} update  refresh an existing node in place
 * @returns {Map<string, Element>} surviving nodes by key (feed to playFlip)
 */
export function reconcile(host, items, keyOf, create, update) {
  const prev = STATE.get(host) || new Map();
  const next = new Map();

  for (const item of items) {
    const key = keyOf(item);
    let node = prev.get(key);
    if (node) update(node, item);
    else node = create(item);
    next.set(key, node);
  }

  // Drop what disappeared. Every node in `prev` was placed into `host` by an
  // earlier call to this function, so removing it here is safe without first
  // re-checking node.parentNode — a real Element tracks that itself, but a
  // caller's host/node stand-in (e.g. the test double above) need not, and
  // this function owns the full membership of `host`'s children regardless.
  for (const [key, node] of prev) {
    if (!next.has(key)) host.removeChild(node);
  }

  // Put survivors in the requested order, walking back-to-front so each
  // insertBefore's reference node has already been placed. insertBefore both
  // inserts a brand-new node and moves an existing one (removing it from its
  // old slot first) — one call handles both first paint and reordering.
  let cursor = null;
  const ordered = [...next.values()];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    host.insertBefore(ordered[i], cursor);
    cursor = ordered[i];
  }

  STATE.set(host, next);
  return next;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/f-reconcile.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Adopt it in the four live panels**

In each of `tasks.mjs`, `workflows.mjs`, `approvals.mjs`, replace the "clear then rebuild" pattern with:

```js
import { reconcile } from '../reconcile.mjs';

const listEl = el('div', { class: 'stack' });
// …
function paint(rows) {
  reconcile(listEl, rows, (r) => r.id, (r) => buildRow(r), (node, r) => refreshRow(node, r));
}
```

`buildRow` returns a fresh `el(...)`; `refreshRow` writes only the fields that change (status chip text/class, turn count, countdown) rather than rebuilding.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run lint:size`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/ui/reconcile.mjs web/ui/panels tests/f-reconcile.test.mjs
git commit -m "feat(dashboard): keyed updates for the four live lists

Every loader replaced its container's innerHTML, which is fine for a panel
rendered once on entry and wrong for one that changes while you watch: it
discards running animations, focus, and the measured geometry Team Live draws
its edges from.

Sixty lines of keyed reconciliation covers the four lists that need it, which
is why this does not justify a rendering library."
```

---

## Task 8: Team Live — render the hierarchy that already exists

**Files:**
- Modify: `web/ui/team_tree.mjs` — the file already exists (Task 4 moved `harnessLabel`,
  `avatarGlyph`, `avatarIndexFor`, `avatarSrc`, and `buildTeamTree` into it). Add the six
  new pure functions alongside those; do not create a second module.
- Modify: `web/ui/panels/team.mjs`
- `web/dashboard.css` — Step 6's rules already landed in Task 5. Verify, do not re-add.
- Test: `tests/f-team-tree.test.mjs`

**Interfaces:**
- Consumes: `reconcile`, `captureRects`, `playFlip`
- Produces (all pure, all node-testable):
  - `managerIn(team, agent) -> string | null`
  - `tierRows(team, agentsByName) -> string[][]`
  - `reportsOf(team, agentsByName, name) -> string[]`
  - `chainOf(team, agentsByName, name) -> Set<string>`
  - `isDescendant(team, agentsByName, candidate, ancestor) -> boolean`
  - `canReassign(team, agentsByName, name, newManager) -> boolean`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-team-tree.test.mjs — the reporting line. teams.mjs stores `manager`
// on the AGENT record and buildTeamTree only honours it when the manager is
// also on that team's roster; renderTeamCanvas read all of that and then
// flattened every descendant into one row. These cases pin the real rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { managerIn, tierRows, reportsOf, chainOf, isDescendant, canReassign }
  from '../web/ui/team_tree.mjs';

const AGENTS = {
  orchestrator: { name: 'orchestrator', manager: null },
  backend:      { name: 'backend',      manager: 'orchestrator' },
  frontend:     { name: 'frontend',     manager: 'orchestrator' },
  reviewer:     { name: 'reviewer',     manager: 'backend' },
  qa:           { name: 'qa',           manager: 'backend' },
  analyst:      { name: 'analyst',      manager: null },
};
const SHIP = { name: 'ship-it', lead: 'orchestrator',
  agents: ['orchestrator', 'backend', 'frontend', 'reviewer', 'qa'] };
// reviewer is on this team too, but its manager (backend) is not.
const RESEARCH = { name: 'research', lead: 'analyst', agents: ['analyst', 'reviewer'] };

test('the lead is the only root', () => {
  assert.equal(managerIn(SHIP, AGENTS.orchestrator), null);
  assert.equal(managerIn(SHIP, AGENTS.backend), 'orchestrator');
});

test('a manager outside the roster falls back to the lead, not to a second root', () => {
  assert.equal(managerIn(RESEARCH, AGENTS.reviewer), 'analyst',
    'buildTeamTree hangs such a member off the lead');
});

test('an agent with no manager at all still hangs off the lead', () => {
  const team = { name: 't', lead: 'analyst', agents: ['analyst', 'orchestrator'] };
  assert.equal(managerIn(team, AGENTS.orchestrator), 'analyst');
});

test('tiers group by depth and order children under their own manager', () => {
  assert.deepEqual(tierRows(SHIP, AGENTS), [
    ['orchestrator'],
    ['backend', 'frontend'],
    ['qa', 'reviewer'],
  ]);
});

test('a manager cycle terminates instead of hanging', () => {
  // The cycle must not involve the lead: managerIn() returns null for the lead
  // before it ever looks at `manager`, so a two-agent team whose lead is inside
  // the cycle has the cycle broken for it and exercises nothing. Keep the lead
  // out of it, and a->b->a is genuinely unreachable from the root — which is
  // what the orphan row at the end of tierRows() exists to catch.
  const cyc = {
    lead: { name: 'lead', manager: null },
    a: { name: 'a', manager: 'b' },
    b: { name: 'b', manager: 'a' },
  };
  const team = { name: 'c', lead: 'lead', agents: ['lead', 'a', 'b'] };
  const rows = tierRows(team, cyc);
  assert.deepEqual(rows[0], ['lead'], 'the root still renders');
  assert.deepEqual(rows.flat().slice(1).sort(), ['a', 'b'],
    'the unreachable pair lands in the orphan row');
  assert.equal(rows.flat().length, 3, 'every member appears exactly once');
});

test('reportsOf and chainOf walk the in-team line', () => {
  assert.deepEqual(reportsOf(SHIP, AGENTS, 'backend').sort(), ['qa', 'reviewer']);
  assert.deepEqual([...chainOf(SHIP, AGENTS, 'reviewer')].sort(),
    ['backend', 'orchestrator', 'reviewer']);
});

test('reassignment refuses a cycle and refuses moving the lead', () => {
  assert.equal(isDescendant(SHIP, AGENTS, 'reviewer', 'backend'), true);
  assert.equal(canReassign(SHIP, AGENTS, 'backend', 'reviewer'), false, 'would cycle');
  assert.equal(canReassign(SHIP, AGENTS, 'orchestrator', 'backend'), false, 'the lead is the root');
  assert.equal(canReassign(SHIP, AGENTS, 'qa', 'frontend'), true);
  assert.equal(canReassign(SHIP, AGENTS, 'qa', 'nobody'), false, 'not on this roster');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-team-tree.test.mjs`
Expected: FAIL — cannot find `web/ui/team_tree.mjs`

- [ ] **Step 3: Write `web/ui/team_tree.mjs`**

```js
// web/ui/team_tree.mjs — the reporting line, as pure functions.
//
// The rule is buildTeamTree's, verbatim (teams.mjs): `manager` is a property
// of the AGENT, the lead is the only root, and any other member whose manager
// is missing or not on this team's roster hangs off the lead. Keeping this in
// its own module means it is unit tested rather than trusted, which matters
// because the previous renderer read the same data and then flattened it.

/** The in-team manager, or null when this agent IS the root (the lead). */
export function managerIn(team, agent) {
  if (!agent || agent.name === team.lead) return null;
  if (agent.manager && team.agents.includes(agent.manager) && agent.manager !== agent.name) {
    return agent.manager;
  }
  return team.lead;
}

/**
 * Rows by depth. Each row is ordered by walking the previous row, so siblings
 * sit under their own manager and the drawn edges stop crossing. A `manager`
 * cycle cannot hang this: anyone unreached lands in a final row.
 */
export function tierRows(team, agentsByName) {
  const members = team.agents.map((n) => agentsByName[n]).filter(Boolean);
  const childrenOf = new Map();
  const roots = [];
  for (const m of members) {
    const mgr = managerIn(team, m);
    if (!mgr) { roots.push(m.name); continue; }
    if (!childrenOf.has(mgr)) childrenOf.set(mgr, []);
    childrenOf.get(mgr).push(m.name);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.localeCompare(b));
  roots.sort((a, b) => (a === team.lead ? -1 : b === team.lead ? 1 : a.localeCompare(b)));

  const rows = [];
  const seen = new Set();
  let level = roots;
  while (level.length) {
    const row = level.filter((n) => !seen.has(n));
    if (!row.length) break;
    for (const n of row) seen.add(n);
    rows.push(row);
    level = row.flatMap((n) => childrenOf.get(n) || []);
  }
  const orphans = members.filter((m) => !seen.has(m.name)).map((m) => m.name);
  if (orphans.length) rows.push(orphans);
  return rows;
}

export function reportsOf(team, agentsByName, name) {
  return team.agents
    .map((n) => agentsByName[n])
    .filter((m) => m && managerIn(team, m) === name)
    .map((m) => m.name);
}

/** The agent, its manager chain upward, and every report downward. */
export function chainOf(team, agentsByName, name) {
  const chain = new Set([name]);
  let cur = agentsByName[name];
  while (cur) {
    const mgr = managerIn(team, cur);
    if (!mgr || chain.has(mgr)) break;
    chain.add(mgr);
    cur = agentsByName[mgr];
  }
  const down = reportsOf(team, agentsByName, name);
  while (down.length) {
    const n = down.pop();
    if (chain.has(n)) continue;
    chain.add(n);
    down.push(...reportsOf(team, agentsByName, n));
  }
  return chain;
}

export function isDescendant(team, agentsByName, candidate, ancestor) {
  let cur = agentsByName[candidate];
  const seen = new Set();
  while (cur) {
    const mgr = managerIn(team, cur);
    if (!mgr || seen.has(mgr)) return false;
    if (mgr === ancestor) return true;
    seen.add(mgr);
    cur = agentsByName[mgr];
  }
  return false;
}

/** null newManager means "hang off the lead" (the buildTeamTree default). */
export function canReassign(team, agentsByName, name, newManager) {
  if (!newManager) return name !== team.lead;
  if (newManager === name) return false;
  if (!team.agents.includes(newManager)) return false;
  if (name === team.lead) return false;
  return !isDescendant(team, agentsByName, newManager, name);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/f-team-tree.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Render tiers, edges, and focus in `web/ui/panels/team.mjs`**

Replace the flattening `renderTeamCanvas` with a **recursive subtree layout**, then draw one SVG cubic per manager link from the rendered tile rects.

> **Not tier rows.** An earlier revision of this step said to lay the tree out as one flex row
> per depth, ordered by walking the previous row so "siblings sit under their own manager".
> The ordering is right and the positioning is not: each row is independently
> `justify-content: center`, so a row of two centres on the whole canvas regardless of which
> manager those two belong to. Observed on a real team — `orchestrator` over
> [`backend`, `frontend`] over [`qa`, `reviewer`], where both `qa` and `reviewer` report to
> `backend`: `qa` landed under `backend` and `reviewer` under `frontend`, so `reviewer`'s edge
> travelled the full width of the canvas and crossed the other one. A centred flex row cannot
> place a child block under its parent.
>
> Render each node as a column instead — the tile, then a row of its children's subtrees:
>
> ```
> .subtree        (flex column, align-items: center)
>   <tile>
>   .subtree-kids (flex row, justify-content: center, gap)
>     .subtree …  (one per child, recursively)
> ```
>
> A parent is then centred over its own children by the layout itself, edges are short, and
> they cannot cross. `buildTeamTree(team, byId)` already returns exactly the
> `{ name, children[] }` shape this needs — and it is currently dead code, because flattening
> is what replaced it. Use it.
>
> **Tile identity still has to survive a re-render** (that is what Task 7 exists for, and what
> the FLIP in this step measures). Do not reach for `reconcile` per subtree container: keep one
> panel-lifetime `Map<agentName, Element>` of tiles, get-or-create per name on each render, and
> drop the entry when an agent leaves the roster. The tree scaffolding around them is a handful
> of nodes and can be rebuilt freely; only the tiles must persist. This also removes a defect
> the tier version had — a tile whose depth changed between two renders was destroyed and
> recreated, because its `reconcile` host was a different tier row.
>
> `tierRows` may end up with no callers. Report that; do not delete it.

```js
// One curve per manager link, measured from the rendered tiles. The same path
// is reused for the delegation flow, so a hand-off visibly travels the
// reporting line rather than cutting across the canvas.
function drawEdges(team, agentsByName, tiles, topoEl, edgesEl) {
  clear(edgesEl);
  const base = topoEl.getBoundingClientRect();
  if (!base.width) return;                     // panel not visible yet
  for (const name of team.agents) {
    const agent = agentsByName[name];
    const mgr = managerIn(team, agent);
    if (!mgr) continue;
    const from = tiles.get(mgr); const to = tiles.get(name);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
    const x1 = a.left - base.left + a.width / 2; const y1 = a.bottom - base.top - 6;
    const x2 = b.left - base.left + b.width / 2; const y2 = b.top - base.top + 4;
    const mid = (y1 + y2) / 2;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'edge');
    p.setAttribute('d', `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`);
    p.dataset.from = mgr;
    p.dataset.to = name;
    edgesEl.append(p);
  }
}
```

Call it **after the layout has settled and before `playFlip` runs**, and again on `resize`. Add the hover/focus chain dimming by setting `data-focus` on the topology and `data-inchain` on the tiles in `chainOf`.

> **Do not measure inside a `requestAnimationFrame` queued after `playFlip`.** An earlier
> revision of this step said to, and it is wrong: `getBoundingClientRect()` reports the
> *transformed* border box, and the animation timeline is advanced before animation-frame
> callbacks run, so the rect read in that rAF is the tile's **pre-move** position. Proven in
> a real Chromium engine — a tile whose final `left` is 200px, animating in from a
> `translate(-120px, 0)` FLIP, measures 80px inside that rAF and 200px once the animation
> finishes. Every moved tile's edge would be drawn to where the tile used to be and never
> redrawn. `playFlip`'s transform is purely visual and lands on `transform: none`, so
> measuring the settled layout first gives the correct end-state geometry.
>
> A `requestAnimationFrame` retry is still the right tool for the *other* problem it was
> covering — a panel that renders into a host with no layout yet, where `drawEdges` bails on
> zero width. Keep that retry, but gate it on "we have not measured successfully yet", not
> on "we just rendered".

An agent whose `manager` is set but off-roster gets a badge explaining why it sits under the lead:

```js
agent.manager && !team.agents.includes(agent.manager)
  ? el('span', { class: 'reassigned', text: 'mgr outside team',
      title: `Manager "${agent.manager}" is not on this team, so the tree hangs this agent off the lead.` })
  : null
```

- [ ] **Step 6: Add the CSS**

```css
  .topology { position: relative; padding: 16px 0 4px; }
  /* width/height are required: `inset: 0` alone leaves an <svg> at its
     intrinsic 300x150, which clips every edge away. */
  #edges { position: absolute; inset: 0; width: 100%; height: 100%;
           pointer-events: none; overflow: visible; }
  /* The reporting line is structure, not a gridline — --border disappears
     against the panel. */
  #edges path.edge { fill: none; stroke: var(--faint); stroke-width: 1.5;
                     transition: stroke var(--dur-mid) var(--ease); }
  #edges path.edge[data-hot] { stroke: var(--dim); stroke-width: 2; }
  .tier { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; position: relative; }
  .tier + .tier { margin-top: 30px; }
  .topology[data-focus] .agent:not([data-inchain]) { opacity: .3; }
```

- [ ] **Step 7: Verify in a browser**

Create two teams sharing one agent whose `manager` is only on the first team. Confirm: three tiers on the deep team, the shared agent under the lead on the other with the badge, hovering dims everyone outside the chain, and the edges are visible.

- [ ] **Step 8: Run tests**

Run: `npm test && npm run lint:size`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add web/ui/team_tree.mjs web/ui/panels/team.mjs web/dashboard.css tests/f-team-tree.test.mjs
git commit -m "fix(dashboard): draw the reporting line instead of flattening it

renderTeamCanvas read every agent's manager and then pushed all descendants
into a single row, so a team of any shape looked identical: a lead and a flat
list. The structure was in the data and absent from the screen.

Move the rule into a pure module and test it, because it has two subtleties
worth pinning: the lead is the only root, and a manager who is not on this
team's roster falls back to the lead — which is how one agent shows a
different position on each team it belongs to."
```

---

## Task 9: `⌘K` command palette

**Files:**
- Create: `web/ui/palette.mjs`
- Test: `tests/f-palette-score.test.mjs`

**Interfaces:**
- Consumes: `ALL` from `nav_model.mjs`, `open` from `shell.mjs`, `el`/`clear` from `dom.mjs`
- Produces: `mountPalette({ extraItems }) -> void`, `score(item, needle) -> number`, `openPalette()`, `closePalette()`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-palette-score.test.mjs — the ranking is what makes the palette feel
// right, so it is a pure function with tests rather than a feel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../web/ui/palette.mjs';

const item = { label: 'Team Live', kind: 'panel', hint: 'agents' };

test('an empty needle keeps everything at a neutral score', () => {
  assert.equal(score(item, ''), 0);
});

test('an earlier substring match scores higher', () => {
  assert.ok(score({ label: 'Tasks', kind: 'panel', hint: '' }, 'tas')
          > score({ label: 'Sandbox tasks', kind: 'panel', hint: '' }, 'tas'));
});

test('a subsequence still matches, below any substring hit', () => {
  const sub = score(item, 'tmlv');
  assert.ok(sub > 0, 'tmlv should find Team Live');
  assert.ok(sub < score(item, 'team'), 'a real substring must rank above a subsequence');
});

test('no match at all scores negative so it can be filtered out', () => {
  assert.ok(score(item, 'zzzz') < 0);
});

test('kind and hint are searchable, not just the label', () => {
  assert.ok(score(item, 'agents') > 0, 'hint is part of the haystack');
  assert.ok(score(item, 'panel') > 0, 'so is kind');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-palette-score.test.mjs`
Expected: FAIL — cannot find `web/ui/palette.mjs`

- [ ] **Step 3: Write `web/ui/palette.mjs`**

```js
// web/ui/palette.mjs — one keyboard entry point to everything.
//
// The point is that panel COUNT stops mattering: 21 today, more when channels
// and skills register their own, and reaching any of them is always the same
// two keystrokes. Ranking is a pure function so it can be tested.
import { el, clear } from './dom.mjs';
import { ALL } from './nav_model.mjs';
import { open } from './shell.mjs';

/**
 * Rank an item against a lowercased needle.
 *   >= 0  match (higher is better; an earlier substring beats a later one)
 *   < 0   no match
 * A subsequence match scores a flat 20, which is below every substring hit
 * (those start at 100 - index), so "team" always beats "tmlv".
 */
export function score(item, needle) {
  if (!needle) return 0;
  const hay = (item.label + ' ' + item.kind + ' ' + (item.hint || '')).toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx >= 0) return 100 - idx;
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length ? 20 : -1;
}

let extra = () => [];
let shown = [];
let sel = 0;

function items() {
  return [
    ...ALL.map((it) => ({ label: it.label, kind: 'panel', hint: it.group.toLowerCase(), go: it.id })),
    ...extra(),
  ];
}

export function mountPalette(opts = {}) {
  if (typeof opts.extraItems === 'function') extra = opts.extraItems;
  const scrim = document.getElementById('scrim');
  const q = document.getElementById('q');

  document.getElementById('omni').addEventListener('click', openPalette);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closePalette(); });
  q.addEventListener('input', () => { sel = 0; paint(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) run(shown[sel]); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!shown.length) return;
    sel = e.key === 'ArrowDown' ? (sel + 1) % shown.length : (sel - 1 + shown.length) % shown.length;
    paint();
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape' && scrim.hasAttribute('data-open')) { e.preventDefault(); closePalette(); }
  });
}

export function openPalette() {
  document.getElementById('scrim').setAttribute('data-open', '');
  const q = document.getElementById('q');
  q.value = ''; sel = 0; paint(); q.focus();
}

export function closePalette() {
  document.getElementById('scrim').removeAttribute('data-open');
  document.getElementById('omni').focus();
}

function run(it) {
  closePalette();
  if (it.go) open(it.go);
  if (typeof it.then === 'function') it.then();
}

function paint() {
  const needle = document.getElementById('q').value.trim().toLowerCase();
  const results = document.getElementById('results');
  shown = items()
    .map((it) => ({ it, s: score(it, needle) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map((x) => x.it);

  clear(results);
  if (!shown.length) {
    results.append(el('li', { class: 'pal-empty', text: 'Nothing matches that.' }));
    return;
  }
  sel = Math.min(sel, shown.length - 1);
  shown.forEach((it, i) => {
    results.append(el('li', { '--i': i, 'data-sel': i === sel || null },
      el('button', { type: 'button', onclick: () => run(it) },
        el('span', { class: 'kind', text: it.kind }),
        el('span', { text: it.label }),
        el('span', { class: 'path', text: it.hint || '' }))));
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/f-palette-score.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Feed teams, agents, and actions in from `dashboard.js`**

```js
mountPalette({
  extraItems: () => [
    { label: 'Start a task', kind: 'run', hint: 'tasks', go: 'tasks' },
    { label: 'New team', kind: 'run', hint: 'teams', go: 'teams' },
    { label: 'Review pending approvals', kind: 'run', hint: 'gateway', go: 'approvals' },
    { label: 'Rebuild search index', kind: 'run', hint: 'doctor', go: 'doctor' },
  ],
});
```

> **Panels and static run actions only — no per-team or per-agent entries.** An earlier
> revision of this step also mapped `cachedTeams` and `cachedAgents` into items whose `then`
> called `selectTeam(t.name)` / `selectAgent(a.name)`. None of those five symbols exist, and no
> task in this plan builds them. `team.mjs` does have a selection function, but it is
> `selectTeamAgent`, a closure inside `render(host)` over that render's `TEAM` state — it
> cannot be exported, because there is nothing stable to export.
>
> Typing a team or agent name and landing on it needs two things this plan does not have: a
> boot-time `GET /teams` + `GET /agents` cache in `dashboard.js`, and a way to deep-link a
> selection *into* a panel. The second is the real work — it means a hash parameter
> (`#team?agent=backend`) or a panel-level entry API, plus deciding what happens when the
> named agent has since left the roster. That is its own task, not a wiring detail of this one.
>
> So the palette reaches all 21 panels plus the four run actions above. Reaching a specific
> team or agent by name is deliberately out of scope here.

- [ ] **Step 6: Verify keyboard-only operation**

Open `/dashboard`, press `⌘K`, type `tmlv`, confirm Team Live is first, `↵` opens it, `esc` closes without changing the panel. Tab into the omnibox with the keyboard alone and confirm it opens on `Enter`.

- [ ] **Step 7: Commit**

```bash
git add web/ui/palette.mjs web/dashboard.js tests/f-palette-score.test.mjs
git commit -m "feat(dashboard): command palette over panels, teams, agents, actions

Twenty-one panels is already past the point where scanning a sidebar is the
fastest way in, and the panel count only grows. One keyboard entry point makes
reachability independent of it.

Ranking is a pure scored function with tests: a substring hit always outranks
a subsequence, so typing a real prefix never loses to a fuzzy match."
```

---

## Task 10: Extend the event bus and drive the live rail

**Files:**
- Modify: `workflow/` runner, `daemon/lib/cost.mjs`, `daemon/routes/conversation.mjs`, `providers/registry.mjs`, `cron.mjs`
- Create: `web/ui/liverail.mjs`
- Test: `tests/f-bus-events.test.mjs`

**Interfaces:**
- Consumes: `emit` from `mas/events.mjs`, `subscribe` from `stream.mjs`
- Produces: five new event types; `mountLiveRail() -> void`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-bus-events.test.mjs — the five events the live rail needs beyond the
// MAS team path. Payloads carry routing facts only: a channel message body or
// a provider key in here would leak into every subscribed dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, subscribe, recent, _reset } from '../mas/events.mjs';

test('the new event types stamp seq and ts like the existing ones', () => {
  _reset();
  const seen = [];
  const off = subscribe((e) => seen.push(e));
  emit('workflow.step', { id: 'wf_x', step: 3, total: 5, name: 'summarise' });
  emit('cost.tick', { total: 0.83, cap: 5, currency: 'USD' });
  emit('channel.inbound', { channel: '#ship-it', to: 'orchestrator', team: 'ship-it' });
  emit('provider.error', { provider: 'ollama', detail: 'unreachable' });
  emit('cron.fire', { name: 'rate-refresh', next: '12:00' });
  off();
  assert.equal(seen.length, 5);
  for (const e of seen) {
    assert.ok(Number.isInteger(e.seq) && e.seq > 0);
    assert.ok(Number.isFinite(e.ts));
  }
  assert.equal(recent().length, 5);
});

test('no new payload carries a secret-shaped field', () => {
  _reset();
  const seen = [];
  const off = subscribe((e) => seen.push(e));
  emit('channel.inbound', { channel: '#ship-it', to: 'orchestrator', team: 'ship-it' });
  emit('provider.error', { provider: 'ollama', detail: 'unreachable' });
  off();
  const FORBIDDEN = /token|secret|apikey|api_key|password|authorization|text|body|message/i;
  for (const e of seen) {
    for (const k of Object.keys(e)) {
      assert.doesNotMatch(k, FORBIDDEN, `${e.type} must not carry a "${k}" field`);
    }
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-bus-events.test.mjs`
Expected: The first test PASSES already (`emit` is generic), the second PASSES too. **This test is a guard, not a driver** — it locks the payload shape so a later edit cannot widen it. Note that in the commit message; do not fabricate a failure.

- [ ] **Step 3: Add the five `emit` calls**

Each is one line at the point the fact becomes true. Import as `import { emit as emitEvent } from '<relative>/mas/events.mjs';` to match the existing call sites.

| File | Where | Call |
|---|---|---|
| `workflow/` step runner | after a step completes | `emitEvent('workflow.step', { id, step, total, name })` |
| `daemon/lib/cost.mjs` | after the running total updates | `emitEvent('cost.tick', { total, cap, currency })` |
| `daemon/routes/conversation.mjs` `inbound` | after the channel→team routing decision | `emitEvent('channel.inbound', { channel, to, team })` |
| `providers/registry.mjs` | in the fallback path | `emitEvent('provider.error', { provider, detail })` |
| `cron.mjs` | when a job fires | `emitEvent('cron.fire', { name, next })` |

**Pass no message text, no tokens, no config values.** `detail` is a short human string already safe to log.

- [ ] **Step 4: Write `web/ui/liverail.mjs`**

```js
// web/ui/liverail.mjs — the strip under the topbar. The only ambient motion in
// the shell lives here, and it is the one place a user sees that something is
// happening without having opened the panel it happened in.
import { el } from './dom.mjs';
import { subscribe } from './stream.mjs';
import { reduced } from './motion.mjs';

// Types the device gateway already broadcasts, so they are NOT bus additions.
const GATEWAY_TYPES = new Set(['exec.approval.requested', 'exec.approval.resolved']);

function describe(type, d) {
  switch (type) {
    case 'delegate': return [{ b: d.from }, { arrow: true }, { b: d.to }];
    case 'tool.call': return [{ b: d.agent }, { t: ' ' + d.tool }];
    case 'turn.end': return [{ b: d.agent }, { t: ' finished' }];
    case 'agent.status': return [{ b: d.agent }, { t: ' → ' + d.status }];
    case 'task.start': return [{ t: 'task started: ' }, { b: d.title || d.taskId }];
    case 'task.done': return [{ b: d.taskId }, { t: ' ' + (d.status || 'done') }];
    case 'workflow.step': return [{ b: d.id }, { t: ` step ${d.step} of ${d.total} · ${d.name}` }];
    case 'cost.tick': return [{ t: 'spend today ' }, { b: '$' + Number(d.total).toFixed(2) }];
    case 'channel.inbound': return [{ b: d.channel }, { t: ' routed to ' }, { b: d.to }];
    case 'provider.error': return [{ b: d.provider }, { t: ' ' + d.detail }];
    case 'cron.fire': return [{ b: d.name }, { t: ' fired' }];
    case 'exec.approval.requested': return [{ b: d.agentId }, { t: ' wants ' }, { b: d.tool }, { t: ' · awaiting a human' }];
    default: return [{ t: type }];
  }
}

function nodes(parts) {
  const f = document.createDocumentFragment();
  for (const p of parts) {
    if (p.b) f.append(el('b', { text: p.b }));
    else if (p.arrow) f.append(el('span', { class: 'arrow', text: ' → ' }));
    else f.append(document.createTextNode(p.t));
  }
  return f;
}

export function mountLiveRail() {
  const ticker = document.getElementById('ticker');
  subscribe((type, d) => {
    // The outgoing tick must finish before the incoming one starts: both are
    // absolutely positioned in a 40px band and overlapping text is unreadable.
    const prev = ticker.lastElementChild;
    if (prev) {
      prev.classList.remove('enter');
      prev.classList.add('exit');
      prev.addEventListener('animationend', () => prev.remove(), { once: true });
      if (reduced()) prev.remove();     // animationend never fires when animations are off
    }
    ticker.append(el('div', { class: 'tick enter' },
      el('span', { class: 'type', text: type + (GATEWAY_TYPES.has(type) ? '' : '') }),
      el('span', { class: 'body' }, d.team ? [el('b', { text: d.team }), ' · '] : null, nodes(describe(type, d)))));

    if (type === 'cost.tick') {
      document.getElementById('rs-cost').textContent = '$' + Number(d.total).toFixed(2);
    }
  });
}
```

- [ ] **Step 5: Call it from `dashboard.js`**

Add `import { mountLiveRail } from '/ui/liverail.mjs';` and call `mountLiveRail()` before `connect()`.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/f-bus-events.test.mjs tests/f-events-bus.test.mjs tests/f-events-sse.test.mjs && npm test`
Expected: PASS

- [ ] **Step 7: Verify end to end**

Start the daemon, run a workflow and let a cron job fire, and watch the rail show `workflow.step` and `cron.fire` without opening those panels.

- [ ] **Step 8: Commit**

```bash
git add workflow daemon/lib/cost.mjs daemon/routes/conversation.mjs providers/registry.mjs cron.mjs web/ui/liverail.mjs web/dashboard.js tests/f-bus-events.test.mjs
git commit -m "feat(events): emit workflow, cost, inbound, provider, and cron events

The bus only carried the seven MAS team events, so the live rail was empty
unless you happened to be running a team — which made the whole surface look
decorative. Five one-line emits at the points where those facts become true
make it reflect the daemon instead.

The added test is a guard rather than a driver: it locks the payloads to
routing facts so a later edit cannot start shipping message bodies or provider
keys to every subscribed dashboard."
```

---

## Task 11: Task provenance, transcript, and permission posture

**Files:**
- Modify: `daemon/routes/registry.mjs`, `web/ui/panels/tasks.mjs`, `web/ui/panels/recall.mjs`
- Test: `tests/f-task-posture.test.mjs`

**Interfaces:**
- Consumes: `resolvePermissionModeForSurface(cfg, surface)` from `lib/permission_mode.mjs`
- Produces: task JSON gains `attended: boolean` and `permissionMode: string`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-task-posture.test.mjs — a channel-originated task runs read-only
// unless security.unattendedExec is set, and that was only ever visible in the
// daemon log. Surfacing it means putting the EFFECTIVE posture on the task,
// never the config values themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTask } from '../tasks.mjs';
import * as registry from '../daemon/routes/registry.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-posture-')); }
function mockRes() {
  return { code: 0, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
}

test('a channel-originated task reports attended:false and its read-only mode', async () => {
  const dir = tmp();
  registerTask({ title: 'from slack', team: 'ship-it', lead: 'orchestrator',
    slackChannel: '#ship-it', slackThreadTs: '1785743812.004200' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({}) }, gwConfigDir: dir, res });
  assert.equal(res.code, 200);
  const [t] = JSON.parse(res.body);
  assert.equal(t.slackChannel, '#ship-it');
  assert.equal(t.slackThreadTs, '1785743812.004200');
  assert.equal(t.attended, false, 'an inbound surface has no human watching');
  assert.equal(typeof t.permissionMode, 'string');
  assert.ok(t.permissionMode.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('security.unattendedExec=true flips attended', async () => {
  const dir = tmp();
  registerTask({ title: 'from slack', team: 'ship-it', lead: 'orchestrator',
    slackChannel: '#ship-it' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({ security: { unattendedExec: true } }) },
    gwConfigDir: dir, res });
  const [t] = JSON.parse(res.body);
  assert.equal(t.attended, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CLI-started task has no channel and is treated as attended', async () => {
  const dir = tmp();
  registerTask({ title: 'local', team: 'ship-it', lead: 'orchestrator' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({}) }, gwConfigDir: dir, res });
  const [t] = JSON.parse(res.body);
  assert.equal(t.slackChannel, '');
  assert.equal(t.attended, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the response never echoes the config flag itself', async () => {
  const dir = tmp();
  registerTask({ title: 'x', team: 'ship-it', lead: 'orchestrator', slackChannel: '#x' }, dir);
  const res = mockRes();
  await registry.tasksList({ ctx: { readConfig: () => ({ security: { unattendedExec: false } }) },
    gwConfigDir: dir, res });
  assert.doesNotMatch(String(res.body), /unattendedExec/,
    'expose the effective posture, not the configuration');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-task-posture.test.mjs`
Expected: FAIL — `t.attended` is `undefined`

- [ ] **Step 3: Add the posture to the task routes**

In `daemon/routes/registry.mjs`, in both `tasksList` and `taskGet`, decorate each record:

```js
import { resolvePermissionModeForSurface } from '../../lib/permission_mode.mjs';

// A task that arrived from a channel ran on an unattended surface: no human
// was watching an inbound message from a possibly-untrusted sender, so the
// permission mode fails closed unless the operator opted in. Report the
// EFFECTIVE posture; never echo cfg.security itself.
function withPosture(task, cfg) {
  const fromChannel = !!task.slackChannel;
  const surface = fromChannel ? 'unattended' : 'attended';
  const execEnabled = !!(cfg && cfg.security && cfg.security.unattendedExec === true);
  return {
    ...task,
    attended: !fromChannel || execEnabled,
    permissionMode: resolvePermissionModeForSurface(cfg, surface),
  };
}
```

Then map the list through it and pass the single record through it too.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/f-task-posture.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Render provenance in `web/ui/panels/tasks.mjs`**

```js
// Where a task came from. A channel-originated task carries the channel and
// the thread timestamp, so the row can point back at the conversation.
function originChip(t) {
  if (!t.slackChannel) return chip('started in the CLI', '');
  return el('span', { class: 'chip is-live', title: 'slackThreadTs ' + (t.slackThreadTs || '—') },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: '⇄' }),
    t.slackChannel);
}
```

Add per row: `originChip(t)`, then `t.attended ? chip(t.permissionMode, 'ok') : chip('read-only · ' + t.permissionMode, 'warn')`, then the status chip, then a `Transcript` button.

Add a panel-level banner when any task is unattended:

```js
rows.some((t) => !t.attended)
  ? banner('warn', '!', el('b', { text: 'Some tasks arrived from a channel and ran read-only. ' }),
      'An inbound surface has no human watching it, so it fails closed until ',
      el('code', { text: 'security.unattendedExec = true' }), '.')
  : null
```

- [ ] **Step 6: Call the transcript route that already exists**

```js
async function transcriptModal(t) {
  const { status, body } = await apiSoft(`/tasks/${encodeURIComponent(t.id)}/transcript`);
  openModal({
    title: t.id + ' — transcript',
    body: [
      el('div', { class: 'frow' }, el('label', { text: 'Origin' }),
        el('div', { class: 'val mono', text: t.slackChannel
          ? `${t.slackChannel} · thread ${t.slackThreadTs || '—'}`
          : 'lazyclaw task start · no channel' })),
      t.attended ? null : banner('warn', '!', el('b', { text: 'Ran read-only. ' }),
        `permission mode "${t.permissionMode}" — an unattended channel task cannot write files or run commands.`),
      status === 200
        ? el('pre', { class: 'raw', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) })
        : banner('err', '✗', 'Could not load the transcript (HTTP ' + status + ').'),
      el('div', { class: 'note-inline' }, el('b', { text: 'Also searchable. ' }),
        'Every turn is mirrored into the search index as ',
        el('code', { text: 'session_id = task:' + t.id }), ', so Recall finds it by content.'),
    ],
    foot: [el('button', { class: 'btn ghost', type: 'button', text: 'Close', onclick: closeModal })],
  });
}
```

- [ ] **Step 7: Link `task:` hits from Recall**

In `web/ui/panels/recall.mjs`, when a result's title starts with `task:`, render a button that opens the same transcript modal for that task id (strip the `task:` prefix and any ` · turn N` suffix).

- [ ] **Step 8: Run the suite**

Run: `npm test && npm run lint:size`
Expected: PASS

- [ ] **Step 9: Verify end to end**

Bind a team to a Slack channel, send a request from Slack, then open Tasks: the row shows the channel chip and `read-only · plan`, and Transcript shows the turns.

- [ ] **Step 10: Commit**

```bash
git add daemon/routes/registry.mjs web/ui/panels/tasks.mjs web/ui/panels/recall.mjs tests/f-task-posture.test.mjs
git commit -m "feat(dashboard): show where a task came from and how it ran

registerTask has always stored slackChannel and slackThreadTs, and
GET /tasks/:id/transcript has always existed, but the Tasks table rendered a
turn COUNT and nothing called the transcript route. Ask a team to do something
from Slack and the dashboard could tell you twelve turns happened and not what
was said or who asked.

Also surfaces the permission posture. An inbound task fails closed to
read-only, which was only in the daemon log, so a task that correctly refused
to write files looked like a task that silently did nothing. The routes report
the effective posture only — never cfg.security."
```

---

## Task 12: Read-only gateway views

**Files:**
- Create: `daemon/routes/gateway_views.mjs`, `web/ui/panels/approvals.mjs`, `web/ui/panels/gateway.mjs`
- Modify: `daemon/route_table.mjs`
- Test: `tests/f-gateway-views.test.mjs`

**Interfaces:**
- Consumes: `c.gateway.pendingApprovals()`, `PairingStore` from `gateway/device_auth.mjs`
- Produces: `GET /approvals -> { pending: [...] }`, `GET /devices -> { requests: [...], devices: [...], sse: {...} }`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-gateway-views.test.mjs — read-only windows onto the device gateway.
// devices.json stores plaintext bearer tokens (mode 0600), so the single most
// important property of these routes is that a token never leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingStore } from '../gateway/device_auth.mjs';
import * as views from '../daemon/routes/gateway_views.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-gwv-')); }
function mockRes() {
  return { code: 0, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
}

test('GET /approvals lists what is waiting, with the redacted summary', async () => {
  const res = mockRes();
  const gateway = {
    pendingApprovals: () => [
      { id: 'ap_1', createdAt: 1, tool: 'bash', agentId: 'backend', summary: 'npm run migrate' },
    ],
  };
  await views.approvalsList({ gateway, res });
  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.pending.length, 1);
  assert.equal(body.pending[0].tool, 'bash');
});

test('GET /approvals is empty, not an error, when the gateway is absent', async () => {
  const res = mockRes();
  await views.approvalsList({ gateway: null, res });
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(res.body), { pending: [] });
});

test('GET /devices never returns a bearer token', async () => {
  const dir = tmp();
  const store = new PairingStore(dir);
  const { requestId } = store.requestPairing({
    deviceId: 'sha256:aaa', platform: 'ios', label: 'phone', role: 'approver', scopes: [] });
  store.approve(requestId);
  // Sanity: the store really does hold a token for that device.
  assert.ok(store.tokenFor('sha256:aaa'), 'precondition — the store minted a token');

  const res = mockRes();
  await views.devicesList({ gwConfigDir: dir, gateway: { sseClients: new Set() }, res });
  assert.equal(res.code, 200);
  const raw = String(res.body);
  assert.doesNotMatch(raw, /"token"/, 'no token field may appear');
  assert.equal(raw.includes(store.tokenFor('sha256:aaa')), false, 'and not the value either');

  const body = JSON.parse(raw);
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].deviceId, 'sha256:aaa');
  assert.equal(body.devices[0].role, 'approver');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /devices reports pending pairing requests', async () => {
  const dir = tmp();
  const store = new PairingStore(dir);
  store.requestPairing({ deviceId: 'sha256:bbb', platform: 'android', label: 'tablet', role: 'read-only', scopes: [] });
  const res = mockRes();
  await views.devicesList({ gwConfigDir: dir, gateway: { sseClients: new Set() }, res });
  const body = JSON.parse(res.body);
  assert.equal(body.requests.length, 1);
  assert.equal(body.requests[0].label, 'tablet');
  assert.doesNotMatch(String(res.body), /"token"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/f-gateway-views.test.mjs`
Expected: FAIL — cannot find `daemon/routes/gateway_views.mjs`

- [ ] **Step 3: Write `daemon/routes/gateway_views.mjs`**

```js
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
// device is T2 work; until then this surface observes and does not act.
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

// devices.json holds plaintext bearer tokens. Project each record explicitly
// so a future field added to the store cannot leak by being spread in.
function publicDevice(d) {
  return {
    deviceId: d.deviceId,
    platform: d.platform || '',
    label: d.label || '',
    role: d.role || '',
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
    approvedAt: d.approvedAt || null,
    expiresAt: d.expiresAt || null,
  };
}

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

export async function devicesList(c) {
  const { gwConfigDir, gateway, res } = c;
  const store = new PairingStore(gwConfigDir);
  const streams = (gateway && gateway.sseClients) ? gateway.sseClients.size : 0;
  return writeJson(res, 200, {
    requests: store.pending().map(publicRequest),
    devices: store.devicesList().map(publicDevice),
    sse: { open: streams, maxGlobal: 256, maxPerDevice: 8 },
  });
}
```

- [ ] **Step 4: Register both routes**

In `daemon/route_table.mjs`, add near the other flat GETs (and add `import * as gatewayViews from './routes/gateway_views.mjs';` at the top):

```js
  { m: (c) => c.route === 'GET /approvals', h: gatewayViews.approvalsList },
  { m: (c) => c.route === 'GET /devices', h: gatewayViews.devicesList },
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/f-gateway-views.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 6: Write `web/ui/panels/approvals.mjs`**

Render the pending list with tool, agentId, the already-redacted summary, a remaining-time chip, and a draining meter. **The countdown runs at every motion level** — an agent is blocked, so it is information. Approve/Deny are rendered `disabled` with the real gate quoted:

```js
banner('warn', '!', el('b', { text: 'Read-only in this release. ' }),
  'Resolving an approval is gated on a paired device’s Ed25519 token; the dashboard is not one yet. ',
  'Approve from a paired device or with ', el('code', { text: 'lazyclaw nodes' }), '.')
```

Return a cleanup that clears the 1s interval.

Also call `bumpNav('approvals', pending.length, true)` from a `stream.mjs` subscription on `exec.approval.requested` / `exec.approval.resolved` so the sidebar count moves while you are elsewhere.

- [ ] **Step 7: Write `web/ui/panels/gateway.mjs`**

Sections: pending pairing requests (table), approved devices (table, no token column because the route does not send one), event-stream capacity with a meter, and a card explaining the name collision:

```js
el('div', { class: 'note-inline' },
  el('b', { text: 'Two things are called “gateway”. ' }),
  'The device gateway runs ', el('em', { text: 'inside' }), ' this daemon (',
  el('code', { text: 'createGateway()' }), ', routed before the shared auth-token gate). ',
  el('code', { text: 'commands/gateway.mjs' }),
  ' is a separate long-lived process that runs the channels behind its own pidfile.')
```

- [ ] **Step 8: Run the suite**

Run: `npm test && npm run lint:size`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add daemon/routes/gateway_views.mjs daemon/route_table.mjs web/ui/panels/approvals.mjs web/ui/panels/gateway.mjs tests/f-gateway-views.test.mjs
git commit -m "feat(dashboard): read-only Approvals and Devices views

The device gateway had no dashboard surface at all: the only occurrence of
'gateway' in dashboard.js was an unrelated string about vLLM. A sensitive tool
call can block an agent waiting for a human, and there was nowhere in the
dashboard to see that, let alone see which devices are paired.

Read-only, and the routes live outside /gateway/ because daemon.mjs hands that
whole prefix to the device gateway's own handler. Device records are projected
field by field rather than spread, and a test asserts no bearer token appears
in either response — devices.json stores them in plaintext."
```

---

## Task 13: README and the packaged-file check

**Files:**
- Modify: `README.md`, `README.ko.md`
- Test: `npm run lint:pack`

- [ ] **Step 1: Confirm the new modules ship**

`package.json` `files` contains `"web/"`, so `web/ui/**` is packaged with no manifest change. Verify rather than assume:

Run: `npm pack --dry-run 2>&1 | grep -c 'web/ui/'`
Expected: a count equal to the number of files under `web/ui/` (21 panels + 10 shared modules).

- [ ] **Step 2: Run the pack check**

Run: `npm run lint:pack`
Expected: PASS

- [ ] **Step 3: Update `README.md`**

Per Global CLAUDE.md §5.5 this release changes what a user can do, so the README must change. Update the dashboard section to describe: the grouped sidebar, `⌘K`, the live rail, the two Gateway views (read-only), task provenance and transcripts, and that motion respects `prefers-reduced-motion`. Replace any screenshot that shows the old tab bar, or remove it rather than ship a stale one.

- [ ] **Step 4: Mirror into `README.ko.md`**

The repo keeps a Korean README. Update the same section.

- [ ] **Step 5: Full verification**

Run: `npm test && npm run lint:size && npm run lint:pack`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add README.md README.ko.md
git commit -m "docs: describe the rebuilt dashboard

The dashboard gained a grouped sidebar, a command palette, a live event rail,
two gateway views, and task provenance — all of it user-facing, so the README
section describing 19 tabs is now wrong."
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §3.1 groups / 21 panels | 3 (model + sidebar), 4 (panels) |
| §3.2 hash deep links | 3 (`nav_model` test asserts all 19 original ids survive) |
| §3.3 `⌘K` | 9 |
| §3.4 live rail | 10 |
| §3.5 mobile drawer | 3 |
| §4.1 zero-build decision | Global Constraints |
| §4.2 file layout | File Structure; 1, 3, 4 |
| §4.3 `/ui/**.mjs` route + auth allowlist | 2 |
| §4.4 keyed updates | 7 |
| §5.1 single SSE subscription + backoff | 6 |
| §5.2 refresh policy | 4 (per-panel), 6 |
| §6.1 tokens | 5 |
| §6.2 techniques | 5, 8, 10 |
| §6.3 ambient budget | 5 (`watchVisibility`, one-`--ambient`-rule test) |
| §6.4 SVG pitfalls | 5 (CSS tests), 8 |
| §7.2 five new events | 10 |
| §8.1 hierarchy (F1) | 8 |
| §8.2 provenance / transcript / posture (F2–F4) | 11 |
| §8.3 Recall task hits | 11 |
| §8.4 gateway views (F6) | 12 |
| §8.5 name collision on screen | 12 |
| §9 error handling | 3 (panel try/catch), 4 (five states per panel) |
| §10 accessibility | 1 (modal focus), 3 (aria, touch targets), 9 (keyboard) |
| §11 tests | every task |
| §12 stages | Tasks 1–13 map 1:1 |
| §13 deferred | out of scope by design |

**Gap found and closed:** §9's five-state requirement (`idle`/`loading`/`empty`/`error`/`success`) was implicit in Task 4. It is now called out in Task 4 Step 2 rule 1 and demonstrated in the Task 4 Step 1 reference panel, which renders a loading slot and an error banner.

**Placeholder scan:** the only stub in the plan is the deliberate `mountPalette`/`connect` no-op in Task 4 Step 3, and Tasks 6 and 9 replace it. Flagged inline. No `TBD`, no "add error handling", no "similar to Task N".

**Type consistency checked:**
- `el(tag, props, ...kids)` — same signature in Tasks 1, 3, 5, 8, 9, 10, 11, 12
- `chip(text, tone)` — `tone` is `'' | 'live' | 'ok' | 'warn' | 'err'` everywhere
- `openModal({ title, body, foot })` — nodes, not HTML strings; used that way in 11 and 12
- `managerIn(team, agent)` — takes the agent **record**, not a name; consistent in `team_tree.mjs` and Task 8's `drawEdges`
- `reconcile(host, items, keyOf, create, update)` returns `Map<string, Element>`, which is what `playFlip(before, nodesByKey)` consumes
- `subscribe(fn)` takes `(type, data)` in `stream.mjs`, `liverail.mjs`, and Task 6 Step 5
- `bumpNav(id, count, urgent)` — three arguments in `shell.mjs` and at the Task 12 call site

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-dashboard-shell-motion.md`.
