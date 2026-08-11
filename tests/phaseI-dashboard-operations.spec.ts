// tests/phaseI-dashboard-operations.spec.ts — the done bar for phase 2.
//
// A representative operating loop, start to finish, with no terminal command:
// build a team, give it work, answer its approval request, read the result,
// change a setting, run it again. Plus a second spec proving a destructive
// action asks first and that declining changes nothing.
//
// Corrections to the brief this scenario was drafted from — verified by
// reading the real modules (web/ui/panels/*.mjs, mas/mention_router.mjs,
// mas/agent_turn.mjs, daemon/lib/slash_*.mjs) and, where noted, by driving a
// real daemon by hand before writing a single line of this file:
//
//   - There is no `[data-nav]` hook — navigation is `.nav-item[data-id]`
//     (web/ui/nav_model.mjs), and there is no `.modal` class — the shared
//     confirm dialog is `#modal-scrim`/`#modal-body`/`#modal-foot`
//     (web/ui/modal.mjs), already established by
//     tests/phase16-dashboard-browser.spec.ts.
//   - Agent/team/task creation is NOT a form with `name="…"` inputs and a
//     submit button — agents.mjs/teams.mjs/tasks.mjs collect every field via
//     a sequence of native `prompt()` dialogs (see each panel's
//     `open*Modal()`). One click opens the whole sequence; there is nothing
//     to `page.fill()`.
//   - `/task start` only ever registers a task as 'pending' (or 'running' if
//     the team has a Slack channel, which this scenario's team does not) —
//     nothing ticks it forward on its own. Advancing a task is
//     `/task tick <id>`, and no Tasks-panel button calls it — task-8-report.md
//     confirms the panel's composer surface is issue/mark-done/abandon only.
//     The one real, browser-only way to run a tick is to type it into Chat,
//     which routes any `/`-prefixed line to the same dispatcher
//     (task-9-report.md). That is what "give it work" / "watch progress
//     arrive" / "run it again" all do below — there is no other path.
//   - 'failed' is not a status this system ever assigns to a task (grep
//     confirms no `patchTask(..., {status:'failed'})` call exists anywhere).
//     A tick that doesn't reach the router's `[[TASK_DONE]]` marker ends
//     'paused' (mas/router_termination.mjs), resumable by ticking again.
//     There is also no task-retry action (no such composer exists) — "run it
//     again" below is a second, real `/task tick <id>` on the same task,
//     exactly what an operator would actually do to resume it.
//   - The built-in 'mock' provider (providers/registry.mjs) is a plain text
//     echo with NO tool-use adapter — mas/provider_adapters.mjs's
//     resolveToolUseAdapter only maps anthropic/openai/gemini/claude-cli
//     (plus a registered openai-compat endpoint), so an agent on 'mock'
//     cannot run a task turn at all; confirmed by ticking one against a real
//     daemon before writing this file — it throws before ever calling a
//     model and the turn goes straight to 'paused'. Determinism here instead
//     follows this repo's OWN established pattern for exercising the real
//     router (tests/phase13-mention-router.spec.ts's startMockAnthropic()):
//     agents use the real 'anthropic' provider, pointed at a local stub
//     HTTP server via POMPOS_ANTHROPIC_BASE_URL — the same env var
//     lib/config.mjs's _resolveBaseUrl already special-cases "for tests and
//     private gateways" — with a throwaway auth profile seeded through the
//     CLI in beforeAll (fixture setup, before the browser ever opens a page;
//     the same precedent phase15/16's own runCli() seeding already uses).
//     A registered CUSTOM/openai-compat provider was also tried and rejected
//     for this: mas/provider_adapters.mjs's `_openAICompatAdapter` builds
//     `{ baseUrl: info.baseUrl, ...opts }`, and the caller's own `opts`
//     always carries a `baseUrl` key (even when its value is undefined) that
//     then overwrites `info.baseUrl` right back to undefined by spread order
//     — a live task tick on a custom provider silently escapes to the real
//     vendor's default endpoint instead of the registered one. Confirmed by
//     watching a real tick hit the real OpenAI API (and get a real 401) with
//     a local stub sitting right next to it, untouched. 'anthropic' (a
//     first-class provider, resolved with no such wrapper) sidesteps this
//     entirely, and is what phase13 already uses for the same reason.
//   - The Approvals panel CAN now answer an approval request: this browser
//     pairs itself as an Ed25519 device (web/ui/pairing.mjs) and posts the
//     decision to the gateway's own device-gated resolve route. Two of the
//     three former blockers are gone (the device gate, and the hardcoded
//     `disabled` buttons). The third remains and is why step 3 raises its own
//     approval: the task/team loop's approval hook (tui/slash_dispatcher.mjs's
//     _makeInkApprove, used by /task tick) and the gateway's exec-approval
//     registry (what GET /approvals and this panel show) are still entirely
//     unconnected, so no task turn in this scenario can populate the panel.
//     Step 3 therefore raises a real approval through POST /exec/request — the
//     daemon's own approval path — and asserts the long-polling requester is
//     released with the paired deviceId as `by`. Nothing is soft-asserted.
//
// Daemon startup follows tests/phase16-dashboard-browser.spec.ts's own
// pattern (an explicit --port + matching --allow-origin, since a real
// browser sends Origin even for same-origin module-script fetches), not the
// brief's `spawn(..., '--port', '0')` snippet, which never gets to set
// --allow-origin at all and would 403 every /ui/*.mjs import.
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

// Fixture setup only — run against an isolated POMPOS_CONFIG_DIR before the
// browser ever opens a page, exactly like phase15/16's own runCli(). Never
// the operator's real config dir, and never called without one.
function runCli(args: string[], cfgDir: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir } });
  if (r.status !== 0) throw new Error(`runCli ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
}

// A minimal stub of Anthropic's Messages API — one queued canned reply per
// call, FIFO. Mirrors tests/phase13-mention-router.spec.ts's
// startMockAnthropic() exactly; that file is this repo's own established
// pattern for driving a real agent turn deterministically, offline, with no
// credentials, and phase13 IS the router this scenario's task tick runs.
interface StubReply { text: string; }
function startAnthropicStub(): Promise<{ baseUrl: string; queue: StubReply[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const queue: StubReply[] = [];
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const next = queue.shift();
        if (!next) { res.writeHead(500); res.end('queue empty'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: next.text }],
          stop_reason: 'end_turn',
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        queue,
        close: () => new Promise<void>((r) => { try { server.closeAllConnections(); } catch { /* node <18 */ } server.close(() => r()); }),
      });
    });
  });
}

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

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }

async function startDaemon(cfgDir: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Daemon> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [
    CLI, 'daemon', '--port', String(port), '--allow-origin', `http://127.0.0.1:${port}`,
  ], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...extraEnv },
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

// Answers a fixed, ordered sequence of native prompt() dialogs —
// agents.mjs/teams.mjs/tasks.mjs collect every field this way, not through
// form inputs (see the file banner). Once the queue is drained, any further
// dialog is dismissed (not silently accepted) so an unexpected extra prompt
// surfaces as a visibly wrong value rather than a laundered blank.
function queueDialogs(page: Page, answers: string[]) {
  const q = [...answers];
  page.on('dialog', async (d) => {
    if (q.length === 0) { await d.dismiss(); return; }
    await d.accept(q.shift());
  });
}

async function nav(page: Page, id: string) {
  await page.click(`.nav-item[data-id="${id}"]`);
  await expect(page.locator(`.nav-item[data-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
}

test.describe('Phase I — the operating-loop done bar', () => {
  let cfgDir: string;
  let stub: Awaited<ReturnType<typeof startAnthropicStub>>;
  let daemon: Daemon;

  test.beforeAll(async () => {
    cfgDir = tmpDir('opsloop');
    stub = await startAnthropicStub();
    // A throwaway auth profile so _resolveAuthKey('anthropic') returns
    // something non-empty — the stub itself never inspects it. Fixture setup
    // via the CLI against an isolated cfgDir, never the operator's real one.
    runCli(['auth', 'add', 'anthropic', 'sk-test-not-real', '--label', 'stub'], cfgDir);
    runCli(['auth', 'use', 'anthropic', 'stub'], cfgDir);
    daemon = await startDaemon(cfgDir, { POMPOS_ANTHROPIC_BASE_URL: stub.baseUrl });
  });

  test.afterAll(async () => {
    await daemon?.stop();
    await stub?.close();
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  test('a full operating loop runs without touching the terminal', async ({ page }) => {
    queueDialogs(page, [
      // + New agent (dev): name, provider, model, role — agents.mjs's
      // openAgentModal(), in that order.
      'dev', 'anthropic', 'claude-opus-4-7', '',
      // + New agent (qa)
      'qa', 'anthropic', 'claude-opus-4-7', '',
      // + New team: name, agents (comma-separated), lead, Slack channel —
      // teams.mjs's openTeamModal(). Blank channel keeps this offline.
      'crew', 'dev,qa', 'dev', '',
      // + Issue task: team, title — tasks.mjs's openIssueModal().
      'crew', 'ship the thing',
    ]);

    await page.goto(daemon.baseUrl + '/dashboard');

    // 1. Build a team of two agents.
    await nav(page, 'agents');
    await page.getByRole('button', { name: '+ New agent', exact: true }).click();
    await expect(page.locator('[data-agent="dev"]')).toBeVisible();
    await page.getByRole('button', { name: '+ New agent', exact: true }).click();
    await expect(page.locator('[data-agent="qa"]')).toBeVisible();

    await nav(page, 'teams');
    await page.getByRole('button', { name: '+ New team', exact: true }).click();
    await expect(page.locator('[data-team="crew"]')).toBeVisible();

    // 2. Give it work. Issuing only ever registers a 'pending' task — see the
    // file banner — so watching progress arrive means a real `/task tick`,
    // typed into Chat, the one browser-reachable path to it.
    await nav(page, 'tasks');
    await page.getByRole('button', { name: '+ Issue task', exact: true }).click();
    const row = page.locator('[data-task-title="ship the thing"]');
    await expect(row).toBeVisible();
    // Status cells render via dom.mjs's chip() — an icon glyph span followed
    // by the word, e.g. "○pending" — so this asserts the word is present,
    // not that it is the cell's entire text.
    await expect(row.locator('[data-f="status"]')).toContainText('pending');
    const taskId = await row.getAttribute('data-task-id');
    expect(taskId).toBeTruthy();

    // No [[TASK_DONE]] in this reply — the router ends this tick 'paused',
    // not 'done', which is the honest first transition for a task that
    // hasn't finished (see file banner re: 'failed' never being assigned).
    stub.queue.push({ text: 'looked into it, still working' });

    await nav(page, 'chat');
    await page.locator('#host textarea').fill(`/task tick ${taskId}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#chat-stream')).toContainText(`${taskId} → paused`, { timeout: 20_000 });

    await nav(page, 'tasks');
    await expect(row.locator('[data-f="status"]')).not.toContainText('pending');
    await expect(row.locator('[data-f="status"]')).toContainText('paused');

    // 3. Answer a real approval request from the browser. The approval is
    // raised through POST /exec/request — the daemon's own approval path,
    // which long-polls until a paired device decides — because the task/team
    // loop's approval hook and the gateway's exec-approval registry are still
    // two unconnected systems (see the file banner). Nothing is stubbed: the
    // decision travels browser → device token → gateway → the waiting
    // requester, and the requester's own answer is what this step asserts.
    // No AUTH_TOKEN exists in this file — the daemon in this spec starts
    // with no --auth-token (see startDaemon above), so the bearer gate is off.
    const port = new URL(daemon.baseUrl).port;
    const pending = fetch(`http://127.0.0.1:${port}/exec/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'bash', args: { cmd: 'rm -rf ./build' }, agentId: 'dev', summary: 'delete the build directory' }),
    }).then((r) => r.json())
      // Never let this float: if an assertion below fails first, the long-poll
      // is still in flight and afterAll's daemon.stop() severs it. Without this
      // the rejection surfaces unhandled at teardown, far from the real fault.
      .catch((e) => ({ __requestFailed: String(e) }));

    await nav(page, 'approvals');
    const approval = page.locator('[data-approval]').first();
    await expect(approval).toBeVisible({ timeout: 10_000 });
    await expect(approval).toContainText('delete the build directory');

    const approveBtn = approval.getByRole('button', { name: 'Approve', exact: true });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();

    // The requester is released with the decision AND the identity that made
    // it — `by` is the paired deviceId, which is the proof the browser acted
    // as a device rather than as a bearer-token holder.
    const decision = await pending;
    expect(decision.__requestFailed).toBeUndefined();
    expect(decision.approved).toBe(true);
    expect(decision.by).toMatch(/^sha256:[0-9a-f]{64}$/);

    // And the browser really is on the device roster now.
    await nav(page, 'gateway');
    await expect(page.locator('#host')).toContainText(decision.by.slice(0, 19), { timeout: 5_000 });

    // 4. Read the result — a real, current status. 'paused', not 'done' yet:
    // one tick with no [[TASK_DONE]] never reaches it. Then change a
    // setting.
    await nav(page, 'tasks');
    await expect(row.locator('[data-f="status"]')).toContainText('paused');

    await nav(page, 'config');
    await page.getByRole('button', { name: '+ Set key', exact: true }).click();
    await page.fill('input[name="config-key"]', 'maxTokens');
    await page.fill('textarea[name="config-value"]', '4096');
    await page.click('[data-action="config-set"]');
    await expect(page.locator('[data-config-key="maxTokens"]')).toContainText('4096', { timeout: 5_000 });

    // 5. Run it again. There is no task-retry action anywhere (no composer,
    // no button — see file banner), and the router refuses to re-tick a
    // 'done' task (ROUTER_CLOSED), so retrying a CLOSED task isn't an option
    // that exists either way. This is the real, honest equivalent: a second
    // `/task tick` resuming the same, still-open ('paused') task. This time
    // the reply closes it — and a completed turn also fires the router's
    // best-effort reflection + skill-synthesis calls (mas/mention_router.mjs's
    // autoReflect/autoSynthSkills), each its own call to the stub, confirmed
    // by driving a real daemon before writing this file — so two filler
    // replies are queued behind the real one rather than leaving the stub to
    // 500 on them (harmless either way, since both are best-effort and
    // swallowed, but this keeps the run's own output clean of a needless
    // logged failure).
    stub.queue.push({ text: 'shipped it [[TASK_DONE]]' });
    stub.queue.push({ text: 'reflection filler — never asserted on' });
    stub.queue.push({ text: 'skill-synthesis filler — never asserted on' });

    await nav(page, 'chat');
    await page.locator('#host textarea').fill(`/task tick ${taskId}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#chat-stream')).toContainText(`${taskId} → done`, { timeout: 20_000 });

    await nav(page, 'tasks');
    await expect(row.locator('[data-f="status"]')).not.toContainText('paused');
    await expect(row.locator('[data-f="status"]')).toContainText('done');
  });

  // Independent of the first test's data — builds its own agent/team so this
  // spec can run alone (e.g. via --grep) without depending on execution
  // order or on the first test having run first.
  test('a destructive action asks before it acts, and a decline changes nothing', async ({ page }) => {
    queueDialogs(page, [
      'solo', 'anthropic', '', '', // + New agent
      'squad', 'solo', 'solo', '', // + New team
    ]);
    await page.goto(daemon.baseUrl + '/dashboard');
    await nav(page, 'agents');
    await page.getByRole('button', { name: '+ New agent', exact: true }).click();
    await expect(page.locator('[data-agent="solo"]')).toBeVisible();
    await nav(page, 'teams');
    await page.getByRole('button', { name: '+ New team', exact: true }).click();
    await expect(page.locator('[data-team="squad"]')).toBeVisible();

    const removeBtn = page.locator('[data-team="squad"] [data-action="team-remove"]');
    const teamRow = page.locator('[data-team="squad"]');
    const scrim = page.locator('#modal-scrim');

    // Clicking Delete doesn't open the modal synchronously — runWrite() first
    // awaits a POST /slash round-trip for the CONFIRM_REQUIRED envelope, and
    // only then calls openModal(). Waiting on #modal-body's text alone is not
    // enough to prove THIS click's modal is the one open: closeModal() never
    // clears the body, so stale text from a PREVIOUS decline is still sitting
    // there (just visually hidden) until the next openModal() overwrites it.
    // Waiting on the scrim's own `data-open` attribute — the one flag every
    // open/close actually toggles — is what actually orders each step against
    // its own click, not a leftover render from the one before it.
    async function openRemoveModal() {
      await removeBtn.click();
      await expect(scrim).toHaveAttribute('data-open', '');
      await expect(page.locator('#modal-body')).toContainText('squad');
    }
    async function expectModalClosed() {
      await expect(scrim).not.toHaveAttribute('data-open', '');
      await expect(teamRow).toBeVisible();
    }

    // × button: dismissing this way must decline, not hang or silently
    // succeed — task-7-report.md's fix for exactly this bug. No automated
    // test before this spec has ever driven it through a real browser.
    await openRemoveModal();
    await page.click('#modal-x');
    await expectModalClosed();

    // Clicking the scrim itself (not the dialog box) must also decline.
    await openRemoveModal();
    await scrim.click({ position: { x: 5, y: 5 } });
    await expectModalClosed();

    // Escape must also decline.
    await openRemoveModal();
    await page.keyboard.press('Escape');
    await expectModalClosed();

    // The explicit Cancel button — a fourth decline path, same outcome.
    await openRemoveModal();
    await page.click('[data-action="cancel"]');
    await expectModalClosed();

    // Only Confirm actually removes it.
    await openRemoveModal();
    await page.click('[data-action="confirm"]');
    await expect(teamRow).toHaveCount(0);
  });
});
