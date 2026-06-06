// browser — playwright-driven browser_navigate / click / back / screenshot.
// Playwright is already a devDep (playwright.config.ts); we lazy-import and
// return a structured error if it is missing at runtime. A persistent
// headless Chromium context is reused across calls in the same process.

import { isSafeUrl, isPrivateAddr } from './web.mjs';

let _backend = null;
export function __setBrowserBackend(b) { _backend = b; }

let _ctx = null;
async function ensureCtx() {
  if (_backend) return _backend;
  if (_ctx) return _ctx;
  let pw;
  try { pw = await import('playwright'); }
  catch { throw new Error('browser: playwright not installed (npm i playwright)'); }
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Block in-page requests (redirects, subresources, JS-driven navigations)
  // to loopback / private / link-local / metadata IPs — goto-time validation
  // alone misses those. Cheap literal-IP check, no per-request DNS.
  await context.route('**/*', (route) => {
    try {
      const h = new URL(route.request().url()).hostname.replace(/^\[|\]$/g, '');
      if (h === 'localhost' || h === '0.0.0.0' || isPrivateAddr(h)) return route.abort('blockedbyclient');
    } catch { /* unparseable → let Chromium handle it */ }
    return route.continue();
  });
  const page = await context.newPage();
  _ctx = {
    navigate: async (url) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); return { url: page.url(), title: await page.title() }; },
    click:    async (sel) => { await page.click(sel); return { clicked: sel }; },
    back:     async () => { await page.goBack(); return { url: page.url() }; },
    screenshot: async (path) => { await page.screenshot({ path, fullPage: true }); return { path }; },
  };
  return _ctx;
}

function safeHttp(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return true;
  } catch { return false; }
}

const browser_navigate = {
  name: 'browser_navigate', category: 'browser', sensitive: true,
  description: 'Navigate to an http(s) URL in a headless Chromium session.',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async exec(args) {
    if (!safeHttp(args.url)) return { ok: false, error: 'browser_navigate: http(s) only' };
    // Same DNS-resolving SSRF guard as web_fetch before driving Chromium at
    // the URL — otherwise an agent could navigate to the dashboard, cloud
    // metadata (169.254.169.254), or internal services and read them back
    // via title / DOM / screenshot.
    const safe = await isSafeUrl(args.url);
    if (!safe.ok) return { ok: false, error: `browser_navigate: ${safe.error}` };
    try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.navigate(args.url)) }; }
    catch (e) { return { ok: false, error: `browser_navigate: ${e.message}` }; }
  },
};

const browser_click = {
  name: 'browser_click', category: 'browser', sensitive: true,
  description: 'Click an element by CSS selector.',
  parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  async exec(args) {
    try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.click(args.selector)) }; }
    catch (e) { return { ok: false, error: `browser_click: ${e.message}` }; }
  },
};

const browser_back = {
  name: 'browser_back', category: 'browser', sensitive: true,
  description: 'Navigate back in browser history.',
  parameters: { type: 'object', properties: {} },
  async exec() {
    try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.back()) }; }
    catch (e) { return { ok: false, error: `browser_back: ${e.message}` }; }
  },
};

const browser_screenshot = {
  name: 'browser_screenshot', category: 'browser', sensitive: true,
  description: 'Capture a full-page PNG to <path>.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async exec(args) {
    try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.screenshot(args.path)) }; }
    catch (e) { return { ok: false, error: `browser_screenshot: ${e.message}` }; }
  },
};

export const TOOLS = [browser_navigate, browser_click, browser_back, browser_screenshot];
