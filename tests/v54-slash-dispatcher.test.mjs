// tests/v54-slash-dispatcher.test.mjs — v5.4 slash dispatcher coverage.
//
// For each of the 24 commands in SLASH_COMMANDS, assert dispatchSlash:
//   · does not throw on a happy-path mock ctx,
//   · returns the expected sentinel ('EXIT') or a non-empty string,
//   · mutates ctx getters/setters where applicable,
//   · /help lists every command from the SLASH_COMMANDS catalog.
//
// Module-level imports of fs-touching commands (memory, agents, teams, etc.)
// are isolated to a temp cfgDir so the test never writes to the user's real
// config directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import {
  dispatchSlash,
  parseSlashLine,
  SLASH_HANDLERS,
} from '../tui/slash_dispatcher.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────

function tmpCfgDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-slash-'));
}

function makeMockCtx(overrides = {}) {
  let messages = [];
  let provName = 'mockprov';
  let model = 'mockmodel';
  let sessionId = null;
  let charsSent = 0;
  let runningUsage = null;
  let prov = { sendMessage: async function* () { yield ''; } };

  const fakeRegistry = {
    PROVIDERS: { mockprov: prov, other: { sendMessage: async function* () {} } },
    maskApiKey: (k) => (k ? '***' : '(none)'),
    lookupProv: (name) => fakeRegistry.PROVIDERS[name] || null,
    parseSlashProviderModel: (s) => {
      const i = s.indexOf('/');
      if (i < 0) return { provider: null, model: s };
      return { provider: s.slice(0, i), model: s.slice(i + 1) };
    },
  };
  const fakeSessions = {
    resetSession: () => {},
    appendTurn: () => {},
    loadTurns: () => [],
  };
  const fakeSkills = {
    composeSystemPrompt: (names) => names.length ? `system for ${names.join('+')}` : null,
  };
  const cfgDir = overrides.cfgDir || tmpCfgDir();
  return {
    cfg: { 'api-key': 'sk-secret', rates: {} },
    cfgDir,
    version: '5.4.0-test',
    syntheticChatSessionId: 'chat-test',
    registryMod: fakeRegistry,
    sessionsMod: fakeSessions,
    skillsMod: fakeSkills,
    getMessages: () => messages,
    setMessages: (next) => { messages = next; },
    getProv: () => prov,
    setProv: (next) => { prov = next; },
    getActiveProvName: () => provName,
    setActiveProvName: (n) => { provName = n; },
    getActiveModel: () => model,
    setActiveModel: (m) => { model = m; },
    getSessionId: () => sessionId,
    setSessionId: (id) => { sessionId = id; },
    getCharsSent: () => charsSent,
    setCharsSent: (n) => { charsSent = n; },
    getRunningUsage: () => runningUsage,
    setRunningUsage: (u) => { runningUsage = u; },
    persistTurn: () => {},
    accumulateUsage: () => {},
    resolveAuthKey: () => 'sk-secret',
    ...overrides,
  };
}

// ─── parseSlashLine ──────────────────────────────────────────────────────

test('parseSlashLine: bare command', () => {
  assert.deepEqual(parseSlashLine('/help'), { cmd: '/help', args: '' });
});

test('parseSlashLine: command + args', () => {
  assert.deepEqual(parseSlashLine('/model gpt-4.1'), { cmd: '/model', args: 'gpt-4.1' });
});

test('parseSlashLine: strips trailing whitespace', () => {
  assert.deepEqual(parseSlashLine('/exit   '), { cmd: '/exit', args: '' });
});

test('parseSlashLine: multi-token args preserved', () => {
  const p = parseSlashLine('/loop "fix lint" --max 5');
  assert.equal(p.cmd, '/loop');
  assert.equal(p.args, '"fix lint" --max 5');
});

// ─── catalog coverage ────────────────────────────────────────────────────

test('every command in SLASH_COMMANDS has a handler', () => {
  for (const c of SLASH_COMMANDS) {
    assert.ok(SLASH_HANDLERS.has(c.cmd), `missing handler for ${c.cmd}`);
  }
});

test('/help lists every command in SLASH_COMMANDS', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/help', '', ctx);
  for (const c of SLASH_COMMANDS) {
    assert.ok(out.includes(c.cmd), `/help output missing ${c.cmd}`);
  }
});

// ─── trivial info commands ───────────────────────────────────────────────

test('/status reports provider, model, key, messages, session', async () => {
  // v5.4.4 — /status renders a human-readable block instead of JSON.
  // Old JSON.parse contract dropped; we assert each field appears.
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/status', '', ctx);
  assert.match(out, /provider:\s+mockprov/);
  assert.match(out, /model:\s+mockmodel/);
  assert.match(out, /api key:\s+\*\*\*/);
  assert.match(out, /messages:\s+0/);
  assert.match(out, /session:\s+\(none/);
});

test('/version returns version + node + platform', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/version', '', ctx);
  assert.match(out, /^lazyclaw 5\.4\.0-test \(node /);
  assert.ok(out.includes(process.platform));
});

test('/usage reports messageCount + charsSent in a human block', async () => {
  // v5.4.4 — human-readable instead of JSON.
  const ctx = makeMockCtx();
  ctx.setMessages([{ role: 'user', content: 'hi' }]);
  ctx.setCharsSent(42);
  const out = await dispatchSlash('/usage', '', ctx);
  assert.match(out, /messages:\s+1/);
  assert.match(out, /chars sent:\s+42/);
});

// ─── /exit + /quit ────────────────────────────────────────────────────────

test('/exit returns EXIT sentinel', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/exit', '', ctx);
  assert.equal(out, 'EXIT');
});

test('/quit returns EXIT sentinel', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/quit', '', ctx);
  assert.equal(out, 'EXIT');
});

// ─── /new + /reset ────────────────────────────────────────────────────────

test('/new clears messages + charsSent + runningUsage', async () => {
  const ctx = makeMockCtx();
  ctx.setMessages([{ role: 'user', content: 'hi' }]);
  ctx.setCharsSent(99);
  ctx.setRunningUsage({ inputTokens: 10 });
  const out = await dispatchSlash('/new', '', ctx);
  assert.match(out, /cleared/);
  assert.equal(ctx.getMessages().length, 0);
  assert.equal(ctx.getCharsSent(), 0);
  assert.equal(ctx.getRunningUsage(), null);
});

test('/reset is alias for /new', async () => {
  const ctx = makeMockCtx();
  ctx.setMessages([{ role: 'user', content: 'hi' }]);
  const out = await dispatchSlash('/reset', '', ctx);
  assert.match(out, /cleared/);
  assert.equal(ctx.getMessages().length, 0);
});

test('/clear is alias for /new (clears via setters)', async () => {
  const ctx = makeMockCtx();
  ctx.setMessages([{ role: 'user', content: 'hi' }]);
  ctx.setCharsSent(99);
  ctx.setRunningUsage({ inputTokens: 10 });
  const out = await dispatchSlash('/clear', '', ctx);
  assert.match(out, /cleared/);
  assert.equal(ctx.getMessages().length, 0);
  assert.equal(ctx.getCharsSent(), 0);
  assert.equal(ctx.getRunningUsage(), null);
});

// Regression guard for the legacy-REPL `/clear` lying no-op (Finding 1).
// The dispatcher's _newReset clears state via the ctx.set* setters. A
// legacy-shaped ctx exposes ONLY getters (getMessages, …) and NO setters —
// the exact shape of _legacyCtx in commands/chat.mjs. So if the legacy
// readline switch were to delegate `/clear` to the dispatcher (the old
// behavior), it would return 'cleared — new conversation' while leaving the
// conversation fully intact. This test pins that dispatcher-on-getters-only
// behavior so we don't forget WHY the legacy switch must own `/clear`
// directly (aliased to /new + /reset) instead of delegating it.
test('/clear via dispatcher is a no-op on a getters-only (legacy) ctx — why the legacy switch must own it', async () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const legacyShapedCtx = {
    cfg: {}, cfgDir: tmpCfgDir(),
    sessionsMod: { resetSession: () => {} },
    getMessages: () => messages,          // getter only
    getSessionId: () => null,
    getCharsSent: () => 7,
    getRunningUsage: () => ({ inputTokens: 5 }),
    // NO setMessages / setCharsSent / setRunningUsage — like _legacyCtx.
  };
  const out = await dispatchSlash('/clear', '', legacyShapedCtx, () => {});
  assert.match(out, /cleared — new conversation/, 'still CLAIMS it cleared');
  assert.equal(messages.length, 1, 'but the conversation is NOT actually cleared');
});

// ─── /provider + /model ───────────────────────────────────────────────────

test('/provider with arg mutates ctx', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/provider', 'other', ctx);
  assert.match(out, /provider → other/);
  assert.equal(ctx.getActiveProvName(), 'other');
});

test('/provider with unknown arg returns error, no mutation', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/provider', 'nope', ctx);
  assert.match(out, /unknown provider/);
  assert.equal(ctx.getActiveProvName(), 'mockprov');
});

test('/provider with no arg + no picker falls back to hint', async () => {
  // v5.4.3 — no ctx.openPicker → dispatcher returns the legacy hint
  // string so non-Ink callers (CLI / tests) aren't stranded.
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/provider', '', ctx);
  assert.match(out, /provider: mockprov/);
  assert.match(out, /pass an arg: \/provider/);
});

test('/provider with no arg + openPicker opens the modal and applies the pick', async () => {
  const ctx = makeMockCtx();
  ctx.openPicker = async (opts) => {
    if (opts.kind === 'model') return null; // skip the chained provider→model pick
    assert.equal(opts.kind, 'provider');
    return 'other';
  };
  const out = await dispatchSlash('/provider', '', ctx);
  assert.match(out, /provider → other/);
  assert.equal(ctx.getActiveProvName(), 'other');
});

test('/provider with no arg + cancelled picker returns "cancelled"', async () => {
  const ctx = makeMockCtx();
  ctx.openPicker = async () => null;
  const out = await dispatchSlash('/provider', '', ctx);
  assert.match(out, /cancelled/);
  assert.equal(ctx.getActiveProvName(), 'mockprov');
});

test('/model with arg mutates ctx', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/model', 'gpt-4.1', ctx);
  assert.match(out, /model → gpt-4\.1/);
  assert.equal(ctx.getActiveModel(), 'gpt-4.1');
});

test('/model with provider/model form switches both', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/model', 'other/claude-opus-4-7', ctx);
  assert.match(out, /model → claude-opus-4-7/);
  assert.equal(ctx.getActiveProvName(), 'other');
  assert.equal(ctx.getActiveModel(), 'claude-opus-4-7');
});

test('/model with no arg shows hint', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/model', '', ctx);
  assert.match(out, /model: mockmodel/);
});

// ─── /skill + /skills ─────────────────────────────────────────────────────

test('/skill <names> inserts system message', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/skill', 'review,style', ctx);
  assert.match(out, /active skills: review, style/);
  const msgs = ctx.getMessages();
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /review\+style/);
});

test('/skill (no arg) clears system message', async () => {
  const ctx = makeMockCtx();
  ctx.setMessages([{ role: 'system', content: 'old' }, { role: 'user', content: 'hi' }]);
  const out = await dispatchSlash('/skill', '', ctx);
  assert.match(out, /cleared system prompt/);
  const msgs = ctx.getMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
});

test('/skills is alias for /skill', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/skills', 'review', ctx);
  assert.match(out, /active skills: review/);
});

// ─── /tools ───────────────────────────────────────────────────────────────

test('/tools does not throw', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/tools', '', ctx);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

// ─── /recall ──────────────────────────────────────────────────────────────

test('/recall with no arg shows usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/recall', '', ctx);
  assert.match(out, /usage: \/recall/);
});

test('/recall with arg does not throw on empty memory', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/recall', 'foobar', ctx);
  assert.equal(typeof out, 'string');
  // Either matches (no results message) or returns something non-empty.
  assert.ok(out.length > 0);
});

// ─── /memory ──────────────────────────────────────────────────────────────

test('/memory (no arg) → core, does not throw on empty', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/memory', '', ctx);
  assert.equal(typeof out, 'string');
});

test('/memory recent returns a readable list (or empty marker)', async () => {
  // v5.4.4 — human-readable instead of JSON.
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/memory', 'recent', ctx);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('/memory episodic (no topic) returns a readable list (or empty marker)', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/memory', 'episodic', ctx);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('/memory garbage shows usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/memory', 'garbage', ctx);
  assert.match(out, /usage: \/memory/);
});

// ─── /dream ───────────────────────────────────────────────────────────────

test('/dream does not throw, returns string', async () => {
  // memory.dream returns { topics: [] } when there is no session content,
  // so this should resolve cleanly without hitting the network.
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/dream', '', ctx, () => {});
  assert.equal(typeof out, 'string');
});

// ─── /agent ───────────────────────────────────────────────────────────────

test('/agent list returns no-agents message on empty cfgDir', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/agent', '', ctx);
  assert.match(out, /no agents registered/);
});

test('/agent show without name returns usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/agent', 'show', ctx);
  assert.match(out, /usage: \/agent show/);
});

// ─── /team ────────────────────────────────────────────────────────────────

test('/team list returns no-teams message on empty cfgDir', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/team', '', ctx);
  assert.match(out, /no teams registered/);
});

test('/team show without name returns usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/team', 'show', ctx);
  assert.match(out, /usage: \/team show/);
});

// ─── /loop ────────────────────────────────────────────────────────────────

test('/loop with no arg returns usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/loop', '', ctx);
  assert.match(out, /usage: \/loop/);
});

// ─── /goal ────────────────────────────────────────────────────────────────

test('/goal (no arg) returns no-goals message on empty cfgDir', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/goal', '', ctx);
  assert.match(out, /no active goals/);
});

test('/goal list returns JSON array', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/goal', 'list', ctx);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
});

test('/goal add without name returns usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/goal', 'add', ctx);
  assert.match(out, /usage: \/goal add/);
});

test('/goal show without name returns usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/goal', 'show', ctx);
  assert.match(out, /usage: \/goal show/);
});

// ─── /handoff ─────────────────────────────────────────────────────────────

test('/handoff without args returns usage', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/handoff', '', ctx);
  assert.match(out, /usage: \/handoff/);
});

test('/handoff with args but no bound thread returns error', async () => {
  const ctx = makeMockCtx();
  // Ensure no stale replState from another test.
  delete globalThis.__lazyclawReplState;
  const out = await dispatchSlash('/handoff', 'slack C123', ctx);
  assert.match(out, /handoff: no thread bound/);
});

// ─── /personality + /task + /trainer (hint-only in v5.4) ─────────────────

test('/personality returns hint', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/personality', '', ctx);
  assert.match(out, /personality/);
});

test('/task returns hint', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/task', '', ctx);
  assert.match(out, /task/);
});

test('/trainer returns hint', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/trainer', '', ctx);
  assert.match(out, /trainer/);
});

// ─── unknown commands ────────────────────────────────────────────────────

test('unknown slash command returns friendly error', async () => {
  const ctx = makeMockCtx();
  const out = await dispatchSlash('/xyz', '', ctx);
  assert.match(out, /unknown slash command: \/xyz/);
});

// ─── full coverage: every command in SLASH_COMMANDS resolves without throwing ──

test('every command in SLASH_COMMANDS executes without throwing', async () => {
  for (const c of SLASH_COMMANDS) {
    const ctx = makeMockCtx();
    // /handoff would still resolve (returns usage), but ensure replState is clean.
    delete globalThis.__lazyclawReplState;
    let out;
    try {
      out = await dispatchSlash(c.cmd, '', ctx, () => {});
    } catch (err) {
      assert.fail(`${c.cmd} threw: ${err?.message || err}`);
    }
    // /exit + /quit return the sentinel; everything else returns a string.
    if (c.cmd === '/exit' || c.cmd === '/quit') {
      assert.equal(out, 'EXIT', `${c.cmd} should return EXIT`);
    } else {
      assert.equal(typeof out, 'string', `${c.cmd} should return a string, got ${typeof out}`);
      assert.ok(out.length > 0, `${c.cmd} returned empty string`);
    }
  }
});
