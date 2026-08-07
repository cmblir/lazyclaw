// tests/f-setup-slack-handoff.test.mjs — the last mile of `/setup`'s Slack step.
//
// Before this, setup verified the bot token and stopped. The user was left with
// credentials on disk, an EMPTY pairing allowlist (so the gateway would answer
// anyone who could reach the channel — it logs a warning saying exactly that),
// no gateway running, and no indication of what to do next.
//
// finishSlackSetup closes that: pair the operator using the identity auth.test
// already returned, offer to start the gateway on its resolved port, and have
// the bot post one short confirmation so the user sees it working in Slack.
//
// Everything external is injected — no port is bound, no gateway spawned, no
// Slack call made.

import test from 'node:test';
import assert from 'node:assert/strict';
import { finishSlackSetup, buildAnnounce } from '../commands/setup_slack_handoff.mjs';

const IDENTITY = { userId: 'U123', teamId: 'T456', user: 'pompos', team: 'Acme' };

// Answers the wizard's yes/no and text prompts in order.
function scriptedIo(answers) {
  const asked = [];
  const out = [];
  return {
    asked,
    out,
    write: (s) => out.push(s),
    confirm: async (q) => { asked.push(q); return answers.shift(); },
    prompt: async (q) => { asked.push(q); return answers.shift(); },
    text: () => out.join(''),
  };
}

const baseDeps = (over = {}) => ({
  spawnGateway: async () => ({ ok: true, pid: 900, port: 19600 }),
  isPortListening: async () => false,
  sendMessage: async () => ({ ok: true }),
  writeConfig: () => {},
  ...over,
});

test('pairs the operator using the identity auth.test already returned', async () => {
  const cfg = {};
  const io = scriptedIo([true, '', false]);   // pair? yes; destination default; start? no
  await finishSlackSetup({ cfg, identity: IDENTITY, io, deps: baseDeps() });
  assert.deepEqual(cfg.pairing.map((p) => p.id), ['U123']);
  assert.match(cfg.pairing[0].label, /pompos/);
  // The operator is never asked to go find their own Slack ID.
  assert.ok(io.asked.some((q) => /U123/.test(q)), `the id should be offered, asked: ${JSON.stringify(io.asked)}`);
});

test('declining to pair writes nothing and says plainly what that means', async () => {
  const cfg = {};
  const io = scriptedIo([false, false]);      // pair? no; start? no
  await finishSlackSetup({ cfg, identity: IDENTITY, io, deps: baseDeps() });
  assert.equal(cfg.pairing, undefined, 'nothing may be written when the user declines');
  assert.match(io.text(), /anyone/i, 'an empty allowlist is an exposure — say so once, in plain words');
});

test('declining to start spawns nothing', async () => {
  let spawned = false;
  const cfg = {};
  const io = scriptedIo([false, false]);
  await finishSlackSetup({
    cfg, identity: IDENTITY, io,
    deps: baseDeps({ spawnGateway: async () => { spawned = true; return { ok: true }; } }),
  });
  assert.equal(spawned, false);
});

test('accepting start passes the resolved port through', async () => {
  let gotPort = null;
  const cfg = { gateway: { port: 19700 } };
  const io = scriptedIo([false, true, '']);  // pair? no; start? yes; announce dest default
  await finishSlackSetup({
    cfg, identity: IDENTITY, io,
    deps: baseDeps({ spawnGateway: async ({ port }) => { gotPort = port; return { ok: true, pid: 900, port }; } }),
  });
  assert.equal(gotPort, 19700, 'the configured port must be used, not the default');
});

test('a busy port offers an alternate and persists the choice', async () => {
  const cfg = {};
  let wrote = null;
  const io = scriptedIo([false, true, '19601', '']);  // pair? no; start? yes; new port; dest
  await finishSlackSetup({
    cfg, identity: IDENTITY, io,
    deps: baseDeps({
      isPortListening: async (p) => p === 19600,       // the default is taken
      spawnGateway: async ({ port }) => ({ ok: true, pid: 900, port }),
      writeConfig: (next) => { wrote = next; },
    }),
  });
  assert.equal(cfg.gateway.port, 19601, 'the alternate port must be persisted');
  assert.ok(wrote, 'the choice must go through writeConfig');
});

test('the announce reaches Slack through the injected sender', async () => {
  const sent = [];
  const cfg = { provider: 'claude-cli', model: 'claude-opus-5' };
  const io = scriptedIo([false, true, 'C999']);
  await finishSlackSetup({
    cfg, identity: IDENTITY, io,
    deps: baseDeps({ sendMessage: async (dest, text) => { sent.push({ dest, text }); return { ok: true }; } }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].dest, 'C999');
  assert.match(sent[0].text, /claude-cli/);
  assert.match(sent[0].text, /claude-opus-5/);
});

// The whole point of a bot that announces itself is that it posts a message the
// user can read — which makes it exactly the place a secret would leak. This
// test exists to fail if a future edit interpolates the wrong variable.
test('the announce contains NO secret', async () => {
  const sent = [];
  const cfg = { provider: 'claude-cli', model: 'm' };
  const io = scriptedIo([false, true, 'C999']);
  const SECRETS = {
    botToken: 'xoxb-SHOULD-NEVER-APPEAR',
    appToken: 'xapp-1-SHOULD-NEVER-APPEAR',
    authToken: 'deadbeefSHOULDNEVERAPPEAR',
  };
  await finishSlackSetup({
    cfg, identity: IDENTITY, io, secrets: SECRETS,
    deps: baseDeps({ sendMessage: async (dest, text) => { sent.push(text); return { ok: true }; } }),
  });
  const posted = sent.join('\n');
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!posted.includes(value), `the announce leaked ${name}`);
  }
  // And nothing token-shaped at all.
  assert.doesNotMatch(posted, /xox[bp]-|xapp-1-/, 'no Slack token shape may appear');
});

test('a failed announce is reported and setup still completes', async () => {
  const cfg = {};
  const io = scriptedIo([false, true, 'C999']);
  const res = await finishSlackSetup({
    cfg, identity: IDENTITY, io,
    deps: baseDeps({ sendMessage: async () => { throw new Error('channel_not_found'); } }),
  });
  assert.equal(res.ok, true, 'a bad channel id must not fail the whole wizard');
  assert.match(io.text(), /channel_not_found/, 'but the user must be told why it did not post');
});

test('a gateway that fails to start is reported without throwing', async () => {
  const cfg = {};
  const io = scriptedIo([false, true]);
  const res = await finishSlackSetup({
    cfg, identity: IDENTITY, io,
    deps: baseDeps({ spawnGateway: async () => ({ ok: false, reason: 'EADDRINUSE: address already in use' }) }),
  });
  assert.equal(res.ok, true);
  assert.match(io.text(), /EADDRINUSE/);
});

test('buildAnnounce names the provider and how to talk to it, and stays short', async () => {
  const msg = buildAnnounce({ provider: 'codex-cli', model: 'gpt-5.6-sol', paired: true });
  assert.match(msg, /codex-cli/);
  assert.match(msg, /gpt-5\.6-sol/);
  assert.ok(msg.split('\n').length <= 4, 'a setup confirmation should be a few lines, not a wall');
});

// The wiring itself. finishSlackSetup can be perfect while runChannelStep never
// calls it — this branch has been bitten three times by exactly that shape
// (a correct component behind an unpinned wiring line), so pin it for real:
// assert the hand-off actually ran by observing a dep it can only reach
// through runChannelStep.
test('runChannelStep invokes the Slack hand-off after a successful verify', async () => {
  const { runChannelStep } = await import('../commands/setup_channels.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-handoff-'));
  const prev = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  let probedPort = null;      // only _startGateway calls this
  let spawnedWith = null;     // only reached if the user said yes to starting
  try {
    await runChannelStep({
      cfgDir: dir,
      colors: { dim: (s) => s, ok: (s) => s, warn: (s) => s },
      write: () => {},
      pick: (() => { let n = 0; return async () => (n++ === 0 ? 'slack' : '__done__'); })(),
      // Credential prompts return a token; the hand-off's y/n prompts get "y",
      // and its destination prompt gets a channel id.
      prompt: async (label) => {
        if (/\[Y\/n\]/.test(label)) return 'y';
        if (/post its/.test(label)) return 'C999';
        return 'xoxb-test-token';
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, team: 'Acme', user: 'bot', user_id: 'U123' }) }),
      slackHandoff: {
        isPortListening: async (p) => { probedPort = p; return false; },
        spawnGateway: async (a) => { spawnedWith = a; return { ok: true, pid: 1, port: a.port }; },
        sendMessage: async () => ({ ok: true }),
        writeConfig: () => {},
      },
    });
  } finally {
    if (prev === undefined) delete process.env.LAZYCLAW_CONFIG_DIR;
    else process.env.LAZYCLAW_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(probedPort !== null, 'the hand-off never ran — runChannelStep did not call it');
  assert.ok(spawnedWith, 'the hand-off ran but never reached the gateway start');
  assert.equal(spawnedWith.port, 19600, 'the default port should be resolved from an empty config');
});
