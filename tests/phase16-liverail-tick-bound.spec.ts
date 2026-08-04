// tests/phase16-liverail-tick-bound.spec.ts
//
// dashboard-shell-motion Task 10 fix round 1: web/ui/liverail.mjs's ticker
// only ever looks at `ticker.lastElementChild` to find "the tick that should
// now exit". Before this fix, the moment ANY exit tick's `animationend`
// failed to fire (because the tab was backgrounded — Task 5's
// watchVisibility() treats a hidden document exactly like reduced motion,
// so this is the normal long-running-dashboard case, not an edge case), the
// very next event promoted a NEWER node to `lastElementChild` and the stale
// one was never referenced again by the closure. Nothing pruned it. One
// permanently-orphaned, absolutely-positioned div accumulated per event, for
// as long as the dashboard stayed open. A node:test unit can't see this at
// all — it's an artifact of real animation-event dispatch timing in a real
// engine — so this drives actual `workflow.step` events (POST
// /workflows/run with a sessionId, a real in-process emit site from this
// same task) through a real SSE connection into a real page and counts DOM
// nodes.
//
// Two ways to reach "the exit animation does not complete", both asserting
// the INVARIANT (bounded ticker children) rather than the mechanism, per
// this round's instruction:
//   1. `page.emulateMedia({ reducedMotion: 'reduce' })` — motion.mjs's
//      `reduced()` returns true, so mountLiveRail's own reduced-motion
//      branch removes the previous tick synchronously. This exercises the
//      "handled" path, not the backstop.
//   2. An injected stylesheet that overrides `.tick.exit { animation: none
//      !important; }` — no animation ever starts for an exiting tick, so no
//      `animationend` EVER fires for it, genuinely and permanently, with
//      reduced-motion left off. This is not a fake of the mechanism; it is a
//      real instance of the exact risk this task's code comments name
//      ("some future CSS rename of tick-out's animation-name") — the
//      backstop's unconditional prune is what has to catch it, not the
//      animationend listener.
//
// Setup (daemon boot, port allocation, --allow-origin) follows
// tests/phase16-palette-escape.spec.ts's pattern: the bare `daemon` command
// needs an explicit --allow-origin matching its own loopback origin, because
// the browser sends an `Origin` header for dashboard.js and every /ui/*.mjs
// module import even though they're same-origin. Without it the origin gate
// in daemon.mjs 403s dashboard.js itself, before any of its code (including
// stream.mjs's connect()) ever runs — confirmed by reproducing it directly
// (a clean, non-extension Playwright/Chromium session hitting a bare
// `daemon` spawned without this flag gets a 403 on GET /dashboard.js, and
// `#daemon-state` never leaves its static "connecting…"). The `workflow.step`
// events themselves are still driven by a direct Node `fetch()` to
// POST /workflows/run (tests/phase17-workflow-run-route.spec.ts's pattern),
// not through the page — only the page's own asset/module loading needed
// the origin fix. `--workflow-state-dir` points at a scratch tmpdir so a
// sessionId-bearing run doesn't write `.workflow-state/` into the repo.

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

// Pre-allocates the port (rather than letting `--port 0` pick one) so
// `--allow-origin` can name it up front. The bare `daemon` command's
// `allowedOrigins` is empty by default, and the browser DOES send an
// `Origin` header for module-script fetches even same-origin (dashboard.js
// and every /ui/*.mjs import) — see tests/phase16-palette-escape.spec.ts's
// header comment. Without a matching --allow-origin, the origin gate in
// daemon.mjs 403s dashboard.js itself before any of its code (including
// connect()) ever runs, so `#daemon-state` sits at its static "connecting…"
// forever — confirmed by reproducing it directly against a bare `daemon`
// spawned without this flag.
async function startDaemon(cfgDir: string, stateDir: string): Promise<Daemon> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [
    CLI, 'daemon', '--port', String(port), '--allow-origin', `http://127.0.0.1:${port}`,
    '--workflow-state-dir', stateDir,
  ], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let bound = 0; let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString(); const nl = buf.indexOf('\n');
    if (nl >= 0 && !bound) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) bound = j.port; } catch { /* not the port line */ } }
  });
  const start = Date.now();
  while (!bound && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!bound) { child.kill('SIGKILL'); throw new Error('daemon never bound a port'); }
  return {
    baseUrl: `http://127.0.0.1:${bound}`, child,
    stop: () => new Promise<void>((resolve) => {
      child.on('close', () => resolve()); child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
    }),
  };
}

// Fires N sequential workflow.step emits in one request (one node per step,
// each a real success transition inside runPersistentInner's loop).
async function fireWorkflowSteps(daemon: Daemon, sessionId: string, n: number): Promise<string> {
  const lastId = `${sessionId}-n${n - 1}`;
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `${sessionId}-n${i}`, type: 'set', config: { value: i },
  }));
  const res = await fetch(daemon.baseUrl + '/workflows/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, workflow: { nodes } }),
  });
  expect(res.status).toBe(200);
  return lastId;
}

async function waitConnected(page: Page) {
  await page.waitForFunction(() => document.getElementById('daemon-state')?.textContent === 'live');
}

// All N events have been processed by the page once the LAST node's id shows
// up anywhere in the ticker — SSE frames arrive and are handled in order on
// a single connection, so seeing the last one proves every earlier one was
// already handled (JS is single-threaded; there's no reordering to worry
// about).
async function waitProcessed(page: Page, lastId: string) {
  await page.waitForFunction(
    (id) => document.getElementById('ticker')?.textContent?.includes(id) ?? false,
    lastId,
  );
}

function tickerChildCount(page: Page) {
  return page.evaluate(() => document.getElementById('ticker')?.childElementCount ?? -1);
}

test.describe('Task 10 fix round 1 — liverail ticker does not leak orphaned exit ticks', () => {
  let daemon: Daemon;
  let stateDir: string;

  test.beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p16liverail-state-'));
    daemon = await startDaemon(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p16liverail-cfg-')), stateDir);
  });
  test.afterAll(async () => {
    if (daemon) await daemon.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('reduced motion: the previous tick is removed synchronously, ticker never exceeds 1', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(daemon.baseUrl + '/dashboard');
    await waitConnected(page);

    const lastId = await fireWorkflowSteps(daemon, 'pw-reduced', 12);
    await waitProcessed(page, lastId);

    expect(await tickerChildCount(page)).toBe(1);
  });

  test('animationend genuinely never fires (animation: none on .tick.exit): the backstop still bounds the ticker', async ({ page }) => {
    await page.goto(daemon.baseUrl + '/dashboard');
    // Force the exact failure mode this task's fix targets: no animation
    // ever starts for an exiting tick, so `animationend` never dispatches
    // for it — not delayed, not throttled, genuinely never. Reduced motion
    // is left OFF here on purpose: this is not the handled branch, it's the
    // general case the unconditional prune has to catch on its own.
    await page.addStyleTag({ content: '.tick.exit { animation: none !important; }' });
    await waitConnected(page);

    const lastId = await fireWorkflowSteps(daemon, 'pw-noanim', 15);
    await waitProcessed(page, lastId);

    // The invariant, not the mechanism: at most the outgoing tick plus the
    // incoming one. Without the backstop this would be 15 (one permanently
    // orphaned div per event, since none of them ever received animationend).
    expect(await tickerChildCount(page)).toBeLessThanOrEqual(2);

    // Fire a second burst to confirm the bound holds over time (not just
    // "small once by luck") — orphans would keep accumulating past the
    // first assertion if the backstop weren't unconditional every cycle.
    const lastId2 = await fireWorkflowSteps(daemon, 'pw-noanim-2', 15);
    await waitProcessed(page, lastId2);
    expect(await tickerChildCount(page)).toBeLessThanOrEqual(2);
  });
});
