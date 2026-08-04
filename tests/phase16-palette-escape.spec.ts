// tests/phase16-palette-escape.spec.ts
//
// dashboard-shell-motion Task 9 fix round 1: the drawer, modal, and command
// palette each install their own `window` keydown listener for Escape, and
// whichever layer is topmost must be the only one Escape closes. The bug
// this pins was NOT in the policy (which layer wins was already coded
// correctly) — it was in the mechanism: all three listeners fire in the same
// synchronous dispatch, in registration order, and a guard that reads a
// higher layer's `data-open` attribute AFTER that layer's own (bubble-phase)
// handler already cleared it sees "already closed" and wrongly falls
// through. A pure-function unit test over the policy can't catch this; only
// a real browser's event-dispatch ordering can. shell.mjs's drawer guard and
// palette.mjs's own modal guard are registered with `{ capture: true }` so
// they always read the pre-keypress state, independent of where in
// mount()/dashboard.js each addEventListener call happens to sit.
//
// Setup (daemon boot, port allocation, --allow-origin) follows
// tests/phase16-dashboard-browser.spec.ts's pattern verbatim: the bare
// `daemon` command needs an explicit --allow-origin (dashboard.js and every
// /ui/*.mjs import send Origin even same-origin, per that file's comment),
// unlike `lazyclaw dashboard` which sets allowLoopbackOrigin unconditionally.
//
// The drawer only exists below the 820px breakpoint (web/dashboard.css's
// `.burger { display: none }` / `@media (max-width: 820px) { .burger {
// display: grid } }`), so every case that opens the drawer uses a 375px
// viewport and clicks the real #burger button — mirroring the existing
// mobile drawer test in phase16-dashboard-browser.spec.ts, and the .burger
// cascade bug earlier in this plan that only a real ≤820px viewport test
// caught.

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startDaemon(cfgDir: string): Promise<Daemon> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [
    CLI, 'daemon', '--port', String(port), '--allow-origin', `http://127.0.0.1:${port}`,
  ], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let bound = 0;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0 && !bound) {
      try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) bound = j.port; } catch { /* not the port line */ }
    }
  });
  const start = Date.now();
  while (!bound && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!bound) { child.kill('SIGKILL'); throw new Error('daemon never bound a port'); }
  return {
    baseUrl: `http://127.0.0.1:${bound}`,
    child,
    stop: () => new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
    }),
  };
}

// Snapshot of which of the three Escape-dismissible layers are open, read
// straight off the attribute each layer's own module toggles — never off a
// screenshot, since a screenshot can't distinguish "closed" from "still
// mid-fade" and this bug is entirely about attribute-mutation ordering.
async function layers(page: Page) {
  return {
    drawer: (await page.locator('#rail').getAttribute('data-open')) !== null,
    palette: (await page.locator('#scrim').getAttribute('data-open')) !== null,
    modal: (await page.locator('#modal-scrim').getAttribute('data-open')) !== null,
  };
}

async function openDrawer(page: Page) {
  await page.click('#burger');
}
async function openPalette(page: Page) {
  // Ctrl+K over Cmd+K: works identically to metaKey in palette.mjs's
  // `(e.metaKey || e.ctrlKey)` check, and headless Chromium has no OS-level
  // Cmd binding to collide with regardless of host platform.
  await page.keyboard.press('Control+k');
}
async function openModal(page: Page) {
  await page.evaluate(async () => {
    const { openModal } = await import('/ui/modal.mjs');
    openModal({ title: 'PW Modal', body: 'hello from playwright' });
  });
}

test.describe('Task 9 fix round 1 — palette/modal/drawer Escape arbitration', () => {
  let daemon: Daemon;

  test.beforeAll(async () => {
    daemon = await startDaemon(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p16pal-')));
  });
  test.afterAll(async () => { if (daemon) await daemon.stop(); });

  test('drawer alone: Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(daemon.baseUrl + '/dashboard');
    await openDrawer(page);
    expect(await layers(page)).toEqual({ drawer: true, palette: false, modal: false });
    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });

  test('palette alone: Escape closes it', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    await openPalette(page);
    expect(await layers(page)).toEqual({ drawer: false, palette: true, modal: false });
    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });

  test('modal alone: Escape closes it', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    await openModal(page);
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: true });
    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });

  test('drawer + palette: one Escape closes only the palette, a second closes the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(daemon.baseUrl + '/dashboard');
    await openDrawer(page);
    await openPalette(page);
    expect(await layers(page)).toEqual({ drawer: true, palette: true, modal: false });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: true, palette: false, modal: false });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });

  test('drawer + modal: one Escape closes only the modal, a second closes the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(daemon.baseUrl + '/dashboard');
    await openDrawer(page);
    await openModal(page);
    expect(await layers(page)).toEqual({ drawer: true, palette: false, modal: true });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: true, palette: false, modal: false });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });

  test('palette + modal: one Escape closes only the modal, a second closes the palette', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    await openPalette(page);
    await openModal(page);
    expect(await layers(page)).toEqual({ drawer: false, palette: true, modal: true });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: true, modal: false });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });

  test('all three open: Escape closes modal, then palette, then drawer, one per keypress', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(daemon.baseUrl + '/dashboard');
    await openDrawer(page);
    await openModal(page);
    await openPalette(page);
    expect(await layers(page)).toEqual({ drawer: true, palette: true, modal: true });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: true, palette: true, modal: false });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: true, palette: false, modal: false });

    await page.keyboard.press('Escape');
    expect(await layers(page)).toEqual({ drawer: false, palette: false, modal: false });
  });
});
