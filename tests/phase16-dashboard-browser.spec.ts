// tests/phase16-dashboard-browser.spec.ts
//
// First real browser coverage of the daemon dashboard (phase15 only fetched
// routes; phase3 drove the static demo). Boots a real daemon, opens
// /dashboard in chromium, and exercises the interactive surface the handoff
// called out: tab navigation, the shared modal, and small-viewport layout.

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }

async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let port = 0;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0 && !port) {
      try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* not the port line */ }
    }
  });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound a port'); }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
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

  test('loads with the Chat tab active and switches tabs on click', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    await expect(page.locator('nav.tabs')).toBeVisible();
    // Default state: Chat panel active.
    await expect(page.locator('#tab-chat')).toHaveClass(/active/);

    await page.click('button[data-tab="teams"]');
    await expect(page.locator('#tab-teams')).toHaveClass(/active/);
    await expect(page.locator('button[data-tab="teams"]')).toHaveClass(/active/);
    await expect(page.locator('#tab-chat')).not.toHaveClass(/active/);

    // The live Team tab (avatars / A->B delegation drill-down) also activates.
    await page.click('button[data-tab="team"]');
    await expect(page.locator('#tab-team')).toHaveClass(/active/);
    await expect(page.locator('#tab-teams')).not.toHaveClass(/active/);
  });

  test('the shared modal opens and closes (Escape)', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    await expect(page.locator('#modal-backdrop')).not.toHaveClass(/open/);
    await page.evaluate(() => (window as unknown as { openModal: (o: unknown) => void }).openModal({ title: 'PW Modal', bodyHtml: '<p>hello from playwright</p>' }));
    await expect(page.locator('#modal-backdrop')).toHaveClass(/open/);
    await expect(page.locator('#modal-title')).toHaveText('PW Modal');
    await expect(page.locator('#modal-body')).toContainText('hello from playwright');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-backdrop')).not.toHaveClass(/open/);
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
      await expect(page.locator('nav.tabs')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(2); // allow sub-pixel rounding
    });
  }
});
