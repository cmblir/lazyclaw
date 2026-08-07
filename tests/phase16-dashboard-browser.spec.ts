// tests/phase16-dashboard-browser.spec.ts
//
// First real browser coverage of the daemon dashboard (phase15 only fetched
// routes; phase3 drove the static demo). Boots a real daemon, opens
// /dashboard in chromium, and exercises the interactive surface the handoff
// called out: panel navigation, the shared modal, and small-viewport layout.
//
// dashboard-shell-motion Task 3 replaced the flat data-tab="…" bar with a
// grouped sidebar (.nav-item[data-id]) and the #modal-backdrop/.open modal
// with #modal-scrim/[data-open] (matching web/ui/modal.mjs's contract). The
// selectors below were updated to match; the invariants they defend
// (default panel, panel switching persists via the hash, the modal opens
// and can be dismissed, no horizontal overflow at three viewports) are
// unchanged from before Task 3 — see git history for the pre-shell version.

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }

// Grab an ephemeral port ourselves (instead of `--port 0`) so we can pass a
// matching `--allow-origin` up front. daemon.mjs's CSRF Origin gate
// (daemon/lib/auth.mjs isOriginAllowed) rejects ANY request carrying an
// `Origin` header unless it's on the allowlist — and a real browser DOES
// send `Origin` for `<script type="module">` / dynamic import() fetches,
// even same-origin (unlike classic scripts). Without this, dashboard.js and
// every /ui/*.mjs import 403 in a real browser and the shell never mounts;
// `pompos dashboard` avoids this by setting allowLoopbackOrigin
// unconditionally, but the bare `daemon` command (what this spec drives)
// requires an explicit --allow-origin, by design (see commands/daemon.mjs).
// Small TOCTOU race between closing this probe socket and the daemon
// binding the same port is inherent to this pattern; acceptable for a test.
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

test.describe('Phase 16 — dashboard in the browser', () => {
  let daemon: Daemon;

  test.beforeAll(async () => {
    daemon = await startDaemon(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p16-')));
  });
  test.afterAll(async () => { if (daemon) await daemon.stop(); });

  test('loads with Chat active by default, switches panels on click, and a reload on the hash reopens the same panel', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    await expect(page.locator('.rail')).toBeVisible();
    // Default state: Chat is ALL[0] in nav_model.mjs.
    await expect(page.locator('.nav-item[data-id="chat"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#host')).toContainText('Chat');

    await page.click('.nav-item[data-id="teams"]');
    await expect(page.locator('.nav-item[data-id="teams"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.nav-item[data-id="chat"]')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#host')).toContainText('Teams');
    expect(await page.evaluate(() => location.hash)).toBe('#teams');

    // The live Team tab (avatars / A->B delegation drill-down) also activates.
    await page.click('.nav-item[data-id="team"]');
    await expect(page.locator('.nav-item[data-id="team"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.nav-item[data-id="teams"]')).not.toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => location.hash)).toBe('#team');

    // The hash is the single source of truth for the active panel
    // (shell.mjs's onHash) — a real property the old flat tabs never had to
    // prove, since they didn't persist across reload either.
    await page.reload();
    await expect(page.locator('.nav-item[data-id="team"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#host')).toContainText('Team Live');
  });

  test('the shared modal opens, and the × button, backdrop click, and Escape all close it', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    const openModalCall = () => page.evaluate(async () => {
      const { openModal } = await import('/ui/modal.mjs');
      openModal({ title: 'PW Modal', body: 'hello from playwright' });
    });

    expect(await page.locator('#modal-scrim').getAttribute('data-open')).toBeNull();
    await openModalCall();
    expect(await page.locator('#modal-scrim').getAttribute('data-open')).not.toBeNull();
    await expect(page.locator('#modal-title')).toHaveText('PW Modal');
    await expect(page.locator('#modal-body')).toContainText('hello from playwright');

    // × button (web/ui/modal.mjs's initModal wires this — it was an inline
    // onclick= before Task 3 deleted dashboard.js and the wiring with it).
    await page.click('#modal-x');
    expect(await page.locator('#modal-scrim').getAttribute('data-open')).toBeNull();

    // Clicking the backdrop itself (not the dialog box) also closes it —
    // the old #modal-backdrop had `onclick="if(event.target===this)closeModal()"`.
    await openModalCall();
    await page.locator('#modal-scrim').click({ position: { x: 5, y: 5 } });
    expect(await page.locator('#modal-scrim').getAttribute('data-open')).toBeNull();

    // Escape.
    await openModalCall();
    await page.keyboard.press('Escape');
    expect(await page.locator('#modal-scrim').getAttribute('data-open')).toBeNull();
  });

  // The three viewports the project pins (CLAUDE.md §8.1): mobile, small
  // window (most-often-missed), full screen. None may scroll horizontally.
  for (const vp of [
    { name: 'mobile', width: 375, height: 667 },
    { name: 'small window', width: 768, height: 800 },
    { name: 'full screen', width: 1280, height: 800 },
  ]) {
    test(`no horizontal overflow on the ${vp.name} viewport (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(daemon.baseUrl + '/dashboard');
      await expect(page.locator('.rail')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(2); // allow sub-pixel rounding
    });
  }

  // The mobile drawer is the ≤820px verification the sandboxed browser used
  // during Task 3's manual pass couldn't do (its resize tool didn't change
  // the real viewport) — Playwright's setViewportSize actually does. Also
  // covers the Escape-layering requirement: with both the drawer and the
  // modal open, one Escape must close only the modal (the higher stacking
  // layer), not both at once.
  test('mobile (375px): the burger opens the drawer over a backdrop, and Escape closes exactly one layer at a time', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(daemon.baseUrl + '/dashboard');

    await page.click('#burger');
    expect(await page.locator('#rail').getAttribute('data-open')).not.toBeNull();
    expect(await page.locator('#rail-scrim').getAttribute('data-open')).not.toBeNull();
    await expect(page.locator('#burger')).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');
    expect(await page.locator('#rail').getAttribute('data-open')).toBeNull();
    await expect(page.locator('#burger')).toHaveAttribute('aria-expanded', 'false');

    // Drawer open + modal open: one Escape closes only the modal.
    await page.click('#burger');
    await page.evaluate(async () => {
      const { openModal } = await import('/ui/modal.mjs');
      openModal({ title: 'x', body: 'y' });
    });
    await page.keyboard.press('Escape');
    expect(await page.locator('#modal-scrim').getAttribute('data-open')).toBeNull();
    expect(await page.locator('#rail').getAttribute('data-open')).not.toBeNull();
    // A second Escape now closes the drawer, the remaining open layer.
    await page.keyboard.press('Escape');
    expect(await page.locator('#rail').getAttribute('data-open')).toBeNull();
  });
});
