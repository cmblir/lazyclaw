# lazyclaw v5.0 — Phase F: channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a plugin-based channel system that keeps the 4 core in-tree channels (slack/telegram/matrix/http), adds 5 first-party `@lazyclaw/channel-*` packages (discord/whatsapp/signal/email/voice), persists thread→session mapping in `threads.jsonl`, and exposes a `/handoff` REPL command that migrates an active session across channels.

**Architecture:** A new `channels/loader.mjs` performs `npm install` of `@lazyclaw/channel-*` packages on demand and dynamically imports the entry module which exports `register({ register })` to plug a `Channel` subclass into the daemon. `channels/threads.mjs` owns a per-config-dir JSONL store of `{threadId, channel, externalId, sessionId, lastTurnAt}` rows. `cli.mjs` REPL gains a `/handoff <channel> [externalId]` slash command that rewrites the active thread's `channel`+`externalId` and posts a transition stub on both sides. Five plugin packages live under `/Users/o/lazyclaw/channels-<name>/` as workspace siblings with their own `package.json`, peerDependency on `lazyclaw`, and a single `index.mjs` exporting `register()` and a `Channel` subclass following `channels/base.mjs`.

**Tech Stack:** Node.js 18+, `.mjs` ES modules, `node:test` runner, `node:assert/strict`, `node:fs`, `node:child_process` (`spawnSync` for `npm install`), existing `channels/base.mjs::Channel` abstract class. Plugin runtime deps (declared in each plugin's `package.json`, NOT installed by core): `discord.js`, `whatsapp-web.js` + `qrcode-terminal`, `signal-cli` (external binary, shell wrap), `node-imap` + `nodemailer`, voice plugin reuses Telegram/Discord adapters and posts to an existing transcription provider (OpenAI Whisper compatible endpoint via `providers/openai_compat.mjs`).

**Depends on phases:** A (config + bootstrap), B (sessions store), D (daemon channel wiring already present at `daemon.mjs` + `cli.mjs:5028-5182`).

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §1.6 (Hermes parity matrix — multi-channel inbound), §8 (Channel Expansion & Plugin System), §0.2 (voice TTS deferred — transcribe only), §11 (phasing).

---

## File Structure

**Created:**

- `/Users/o/lazyclaw/channels/loader.mjs` — plugin install + dynamic-import registry (NEW)
- `/Users/o/lazyclaw/channels/threads.mjs` — threads.jsonl persistence (NEW)
- `/Users/o/lazyclaw/tests/phaseF-channels-loader.test.mjs` — loader unit tests
- `/Users/o/lazyclaw/tests/phaseF-channels-threads.test.mjs` — threads store tests
- `/Users/o/lazyclaw/tests/phaseF-channels-handoff.test.mjs` — `/handoff` slash test
- `/Users/o/lazyclaw/tests/phaseF-channels-discord.test.mjs` — discord plugin test
- `/Users/o/lazyclaw/tests/phaseF-channels-whatsapp.test.mjs` — whatsapp plugin test
- `/Users/o/lazyclaw/tests/phaseF-channels-signal.test.mjs` — signal plugin test
- `/Users/o/lazyclaw/tests/phaseF-channels-email.test.mjs` — email plugin test
- `/Users/o/lazyclaw/tests/phaseF-channels-voice.test.mjs` — voice plugin test (transcribe-only)
- `/Users/o/lazyclaw/channels-discord/package.json` — plugin manifest
- `/Users/o/lazyclaw/channels-discord/index.mjs` — `DiscordChannel` + `register()`
- `/Users/o/lazyclaw/channels-whatsapp/package.json`
- `/Users/o/lazyclaw/channels-whatsapp/index.mjs` — `WhatsappChannel` + QR login
- `/Users/o/lazyclaw/channels-signal/package.json`
- `/Users/o/lazyclaw/channels-signal/index.mjs` — `SignalChannel` (signal-cli wrap)
- `/Users/o/lazyclaw/channels-email/package.json`
- `/Users/o/lazyclaw/channels-email/index.mjs` — `EmailChannel` (IMAP IDLE + SMTP)
- `/Users/o/lazyclaw/channels-voice/package.json`
- `/Users/o/lazyclaw/channels-voice/index.mjs` — `VoiceChannel` (transcribe pipeline)

**Modified:**

- `/Users/o/lazyclaw/cli.mjs` — add `channels install/remove/list` subcommands + `/handoff` REPL slash
- `/Users/o/lazyclaw/channels/base.mjs` — add `Channel.kind` + optional `transcribe(buf, mime)` hook
- `/Users/o/lazyclaw/package.json` — add `peerDependenciesMeta` advert for plugin discovery, no new runtime deps

All paths absolute. No edits outside the listed files.

---

## Task 1 — `channels/threads.mjs`: threadId → session JSONL store

Owns the durable mapping the `/handoff` command and inbound routers consult. JSONL append-only; rebuild in memory on open. Schema: `{threadId, channel, externalId, sessionId, lastTurnAt}`.

### 1.1 Write failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-threads.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openThreads } from '../channels/threads.mjs';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-threads-'));
  return d;
}

test('threads: upsert assigns sessionId and persists across reopen', async () => {
  const dir = tmpDir();
  const t1 = openThreads(dir);
  const row = t1.upsert({ channel: 'slack', externalId: 'C123:1700.0001', sessionId: 's-abc' });
  assert.equal(row.channel, 'slack');
  assert.equal(row.externalId, 'C123:1700.0001');
  assert.equal(row.sessionId, 's-abc');
  assert.ok(row.threadId && row.threadId.length >= 8);
  assert.ok(row.lastTurnAt > 0);

  const t2 = openThreads(dir);
  const found = t2.findByExternal('slack', 'C123:1700.0001');
  assert.equal(found?.sessionId, 's-abc');
  assert.equal(found?.threadId, row.threadId);
});

test('threads: handoff rewrites channel + externalId, preserves sessionId + threadId', async () => {
  const dir = tmpDir();
  const t = openThreads(dir);
  const a = t.upsert({ channel: 'telegram', externalId: '42:9001', sessionId: 's-xyz' });
  const b = t.handoff(a.threadId, { channel: 'discord', externalId: '999000111' });
  assert.equal(b.threadId, a.threadId, 'threadId is stable across handoff');
  assert.equal(b.sessionId, 's-xyz', 'sessionId is preserved');
  assert.equal(b.channel, 'discord');
  assert.equal(b.externalId, '999000111');
  // Old external mapping must be gone
  assert.equal(t.findByExternal('telegram', '42:9001'), null);
  assert.equal(t.findByExternal('discord', '999000111').threadId, a.threadId);
});

test('threads: handoff on unknown threadId throws THREAD_NOT_FOUND', async () => {
  const dir = tmpDir();
  const t = openThreads(dir);
  assert.throws(() => t.handoff('does-not-exist', { channel: 'http', externalId: 'r1' }),
    /THREAD_NOT_FOUND/);
});

test('threads: jsonl file is append-only (no rewrite on upsert)', async () => {
  const dir = tmpDir();
  const t = openThreads(dir);
  t.upsert({ channel: 'matrix', externalId: '!room:srv', sessionId: 's1' });
  const sizeAfter1 = fs.statSync(path.join(dir, 'threads.jsonl')).size;
  t.upsert({ channel: 'matrix', externalId: '!room:srv', sessionId: 's1' }); // touch
  const sizeAfter2 = fs.statSync(path.join(dir, 'threads.jsonl')).size;
  assert.ok(sizeAfter2 > sizeAfter1, 'second upsert appended a touch record');
});
```

### 1.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-threads.test.mjs`
- [ ] Expected: 4 failing tests with `Error: Cannot find module '.../channels/threads.mjs'`.

### 1.3 Implement `channels/threads.mjs`

- [ ] Create `/Users/o/lazyclaw/channels/threads.mjs`:

```js
// channels/threads.mjs
//
// threadId -> { channel, externalId, sessionId, lastTurnAt } JSONL store.
// Append-only on disk; in-memory map for read. The threadId is stable
// across /handoff so cross-channel migrations preserve session context.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const FILE = 'threads.jsonl';

function readAll(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return out;
}

function newThreadId() {
  return 'th_' + crypto.randomBytes(8).toString('hex');
}

export function openThreads(configDir) {
  const dir = String(configDir || '.');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);

  /** @type {Map<string, {threadId,channel,externalId,sessionId,lastTurnAt}>} */
  const byThread = new Map();
  /** @type {Map<string, string>} channel|externalId -> threadId */
  const byExternal = new Map();

  function externalKey(channel, externalId) {
    return `${channel}|${externalId}`;
  }

  function apply(row) {
    if (row.op === 'delete') {
      const existing = byThread.get(row.threadId);
      if (existing) {
        byExternal.delete(externalKey(existing.channel, existing.externalId));
        byThread.delete(row.threadId);
      }
      return;
    }
    const prev = byThread.get(row.threadId);
    if (prev) byExternal.delete(externalKey(prev.channel, prev.externalId));
    byThread.set(row.threadId, {
      threadId: row.threadId,
      channel: row.channel,
      externalId: row.externalId,
      sessionId: row.sessionId,
      lastTurnAt: row.lastTurnAt,
    });
    byExternal.set(externalKey(row.channel, row.externalId), row.threadId);
  }

  for (const row of readAll(file)) apply(row);

  function append(row) {
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    apply(row);
  }

  function upsert({ channel, externalId, sessionId, threadId }) {
    if (!channel || !externalId || !sessionId) {
      throw new Error('upsert requires channel, externalId, sessionId');
    }
    const existingId = byExternal.get(externalKey(channel, externalId));
    const id = threadId || existingId || newThreadId();
    const row = {
      op: 'upsert', threadId: id, channel, externalId, sessionId,
      lastTurnAt: Date.now(),
    };
    append(row);
    return byThread.get(id);
  }

  function findByExternal(channel, externalId) {
    const id = byExternal.get(externalKey(channel, externalId));
    return id ? byThread.get(id) : null;
  }

  function findByThread(threadId) {
    return byThread.get(threadId) || null;
  }

  function handoff(threadId, { channel, externalId }) {
    const cur = byThread.get(threadId);
    if (!cur) {
      const err = new Error(`THREAD_NOT_FOUND: ${threadId}`);
      err.code = 'THREAD_NOT_FOUND';
      throw err;
    }
    if (!channel || !externalId) {
      throw new Error('handoff requires channel and externalId');
    }
    const row = {
      op: 'upsert', threadId, channel, externalId,
      sessionId: cur.sessionId, lastTurnAt: Date.now(),
    };
    append(row);
    return byThread.get(threadId);
  }

  function list() {
    return Array.from(byThread.values());
  }

  return { upsert, findByExternal, findByThread, handoff, list };
}
```

### 1.4 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-threads.test.mjs`
- [ ] Expected: `# pass 4`.

### 1.5 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels/threads.mjs /Users/o/lazyclaw/tests/phaseF-channels-threads.test.mjs
git commit -m "$(cat <<'EOF'
feat(channels): add threads.jsonl store for cross-channel session mapping

Phase F prerequisite for /handoff and plugin-based channels. Append-only
JSONL keyed by stable threadId; allows the same lazyclaw session to be
reached from slack/telegram/matrix/http or any installed plugin without
losing context (spec §8).
EOF
)"
```

---

## Task 2 — `channels/loader.mjs`: npm install + dynamic register

The loader knows how to (a) install an `@lazyclaw/channel-<name>` npm package into the user's config dir's `node_modules`, (b) `import()` it, (c) call its exported `register({ Channel, addChannel })` to plug a subclass into the channel map. CLI subcommands `channels install/remove/list` drive it.

### 2.1 Failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-loader.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createLoader, listInstalled, isPluginName,
} from '../channels/loader.mjs';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-loader-')); }

test('loader: isPluginName accepts only @lazyclaw/channel-<slug>', () => {
  assert.equal(isPluginName('@lazyclaw/channel-discord'), true);
  assert.equal(isPluginName('@lazyclaw/channel-foo-bar'), true);
  assert.equal(isPluginName('discord'), false);
  assert.equal(isPluginName('@evil/channel-x'), false);
  assert.equal(isPluginName('@lazyclaw/something-else'), false);
});

test('loader: registers a local fake plugin via file: spec without network', async () => {
  const cfgDir = tmpDir();
  const pkgDir = path.join(tmpDir(), 'fakeplug');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@lazyclaw/channel-fake', version: '0.0.1', type: 'module', main: 'index.mjs',
  }));
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'), `
    import { Channel } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'channels', 'base.mjs')).href)};
    export class FakeChannel extends Channel {
      constructor() { super('fake'); }
      async send(threadId, text) { this.last = { threadId, text }; }
    }
    export function register(ctx) {
      ctx.addChannel('fake', (opts) => new FakeChannel(opts));
    }
  `);

  const loader = createLoader({ configDir: cfgDir, skipInstall: true });
  await loader.loadFromPath('@lazyclaw/channel-fake', pkgDir);
  const factory = loader.getFactory('fake');
  assert.equal(typeof factory, 'function');
  const ch = factory({});
  assert.equal(ch.name, 'fake');
});

test('loader: listInstalled reads node_modules and ignores non-plugin packages', () => {
  const cfgDir = tmpDir();
  const nm = path.join(cfgDir, 'node_modules', '@lazyclaw');
  fs.mkdirSync(nm, { recursive: true });
  fs.mkdirSync(path.join(nm, 'channel-discord'));
  fs.writeFileSync(path.join(nm, 'channel-discord', 'package.json'),
    JSON.stringify({ name: '@lazyclaw/channel-discord', version: '1.2.3' }));
  fs.mkdirSync(path.join(cfgDir, 'node_modules', 'left-pad'));
  fs.writeFileSync(path.join(cfgDir, 'node_modules', 'left-pad', 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.0.0' }));
  const out = listInstalled(cfgDir);
  assert.deepEqual(out, [{ name: '@lazyclaw/channel-discord', version: '1.2.3' }]);
});

test('loader: rejects unsafe package names before invoking npm', async () => {
  const loader = createLoader({ configDir: tmpDir() });
  await assert.rejects(loader.install('rm -rf /'), /INVALID_PLUGIN_NAME/);
  await assert.rejects(loader.install('@lazyclaw/not-a-channel'), /INVALID_PLUGIN_NAME/);
});
```

### 2.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-loader.test.mjs`
- [ ] Expected: 4 failing tests with `Cannot find module '.../channels/loader.mjs'`.

### 2.3 Implement loader

- [ ] Create `/Users/o/lazyclaw/channels/loader.mjs`:

```js
// channels/loader.mjs
//
// Plugin loader for @lazyclaw/channel-<name> packages. Installs into
// <configDir>/node_modules via `npm install <spec>` and dynamic-imports
// the entry, calling the package's exported register({Channel, addChannel}).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Channel } from './base.mjs';

const PLUGIN_RE = /^@lazyclaw\/channel-[a-z][a-z0-9-]*$/;

export function isPluginName(name) {
  return typeof name === 'string' && PLUGIN_RE.test(name);
}

export function listInstalled(configDir) {
  const root = path.join(String(configDir), 'node_modules', '@lazyclaw');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root)) {
    if (!entry.startsWith('channel-')) continue;
    const pj = path.join(root, entry, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (!isPluginName(meta.name)) continue;
      out.push({ name: meta.name, version: meta.version || '0.0.0' });
    } catch { /* skip */ }
  }
  return out;
}

export function createLoader({ configDir, skipInstall = false, npmBin = 'npm' } = {}) {
  if (!configDir) throw new Error('createLoader: configDir required');
  fs.mkdirSync(configDir, { recursive: true });

  /** @type {Map<string, (opts:any)=>Channel>} */
  const factories = new Map();

  function addChannel(kind, factory) {
    if (typeof factory !== 'function') {
      throw new Error(`plugin "${kind}" register() must call addChannel(name, factory)`);
    }
    factories.set(kind, factory);
  }

  function getFactory(kind) {
    return factories.get(kind) || null;
  }

  function listKinds() {
    return Array.from(factories.keys()).sort();
  }

  async function loadFromPath(declaredName, pkgDir) {
    if (!isPluginName(declaredName)) {
      const err = new Error(`INVALID_PLUGIN_NAME: ${declaredName}`);
      err.code = 'INVALID_PLUGIN_NAME';
      throw err;
    }
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const entryRel = pj.main || 'index.mjs';
    const entry = path.join(pkgDir, entryRel);
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.register !== 'function') {
      throw new Error(`plugin ${declaredName} missing register() export`);
    }
    await mod.register({ Channel, addChannel });
    return { name: declaredName, version: pj.version || '0.0.0' };
  }

  async function install(name) {
    if (!isPluginName(name)) {
      const err = new Error(`INVALID_PLUGIN_NAME: ${name}`);
      err.code = 'INVALID_PLUGIN_NAME';
      throw err;
    }
    if (!skipInstall) {
      const res = spawnSync(npmBin, ['install', '--no-audit', '--no-fund', name], {
        cwd: configDir, stdio: 'inherit', env: process.env,
      });
      if (res.status !== 0) {
        throw new Error(`npm install ${name} exited ${res.status}`);
      }
    }
    const pkgDir = path.join(configDir, 'node_modules', name);
    return loadFromPath(name, pkgDir);
  }

  async function remove(name) {
    if (!isPluginName(name)) {
      const err = new Error(`INVALID_PLUGIN_NAME: ${name}`);
      err.code = 'INVALID_PLUGIN_NAME';
      throw err;
    }
    const res = spawnSync(npmBin, ['uninstall', name], {
      cwd: configDir, stdio: 'inherit', env: process.env,
    });
    if (res.status !== 0) throw new Error(`npm uninstall ${name} exited ${res.status}`);
    // factories map stays — restart of daemon picks up the change.
  }

  async function loadAllInstalled() {
    const installed = listInstalled(configDir);
    const loaded = [];
    for (const { name } of installed) {
      try {
        const pkgDir = path.join(configDir, 'node_modules', name);
        loaded.push(await loadFromPath(name, pkgDir));
      } catch (e) {
        process.stderr.write(`[channels] failed to load ${name}: ${e.message}\n`);
      }
    }
    return loaded;
  }

  return {
    addChannel, getFactory, listKinds,
    loadFromPath, loadAllInstalled, install, remove,
  };
}
```

### 2.4 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-loader.test.mjs`
- [ ] Expected: `# pass 4`.

### 2.5 Add `channels install/remove/list` CLI subcommands

- [ ] Find the dispatch table in `cli.mjs`. Locate the existing `case 'daemon':` block (around line 5028 where `SlackChannel` is imported). Add the following routes BEFORE the daemon case. First read `/Users/o/lazyclaw/cli.mjs` around lines 5020-5060 to confirm the exact dispatch shape, then insert:

```js
    case 'channels': {
      const sub = (argv._[1] || 'list').toLowerCase();
      const { createLoader, listInstalled } = await import('./channels/loader.mjs');
      const cfgDir = resolveConfigDir();
      const loader = createLoader({ configDir: cfgDir });
      if (sub === 'install') {
        const name = argv._[2];
        if (!name) { process.stderr.write('usage: lazyclaw channels install <@lazyclaw/channel-name>\n'); process.exit(2); }
        const info = await loader.install(name);
        process.stdout.write(`installed ${info.name}@${info.version}\n`);
        return;
      }
      if (sub === 'remove' || sub === 'uninstall') {
        const name = argv._[2];
        if (!name) { process.stderr.write('usage: lazyclaw channels remove <@lazyclaw/channel-name>\n'); process.exit(2); }
        await loader.remove(name);
        process.stdout.write(`removed ${name}\n`);
        return;
      }
      // list
      const rows = listInstalled(cfgDir);
      if (!rows.length) { process.stdout.write('no channel plugins installed\n'); return; }
      for (const r of rows) process.stdout.write(`${r.name}\t${r.version}\n`);
      return;
    }
```

The Edit must use the exact surrounding context. Read the file first, then use Edit with the verified old_string.

### 2.6 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels/loader.mjs /Users/o/lazyclaw/tests/phaseF-channels-loader.test.mjs /Users/o/lazyclaw/cli.mjs
git commit -m "$(cat <<'EOF'
feat(channels): plugin loader + channels install/remove/list CLI

Installs @lazyclaw/channel-<name> packages into the config dir's
node_modules and registers Channel factories via the plugin's
register({Channel, addChannel}) export (spec §8).
EOF
)"
```

---

## Task 3 — `/handoff` REPL slash command

Rewrites the active session's `(channel, externalId)` to a new pair, persists via `channels/threads.mjs`, and posts a transition stub on both source and target channels.

### 3.1 Failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-handoff.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openThreads } from '../channels/threads.mjs';
import { runHandoff } from '../channels/handoff.mjs';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-handoff-')); }

test('handoff: migrates active thread, posts transition stub on both sides', async () => {
  const dir = tmpDir();
  const threads = openThreads(dir);
  const seed = threads.upsert({ channel: 'slack', externalId: 'C1:1.1', sessionId: 's1' });

  const sent = [];
  const channels = {
    slack: { send: async (to, t) => sent.push(['slack', to, t]) },
    discord: { send: async (to, t) => sent.push(['discord', to, t]) },
  };

  const res = await runHandoff({
    threads, channels,
    threadId: seed.threadId,
    target: 'discord',
    externalId: '999',
  });

  assert.equal(res.threadId, seed.threadId);
  assert.equal(res.sessionId, 's1');
  assert.equal(res.channel, 'discord');
  assert.equal(res.externalId, '999');

  // Both sides notified
  const sources = sent.map(([c]) => c).sort();
  assert.deepEqual(sources, ['discord', 'slack']);
  const slackMsg = sent.find(([c]) => c === 'slack')[2];
  assert.match(slackMsg, /handoff.*discord/i);
  const discordMsg = sent.find(([c]) => c === 'discord')[2];
  assert.match(discordMsg, /resumed from slack/i);

  // Old mapping gone, new mapping present
  assert.equal(threads.findByExternal('slack', 'C1:1.1'), null);
  assert.equal(threads.findByExternal('discord', '999').sessionId, 's1');
});

test('handoff: target channel not available -> CHANNEL_NOT_AVAILABLE', async () => {
  const dir = tmpDir();
  const threads = openThreads(dir);
  const seed = threads.upsert({ channel: 'slack', externalId: 'C1:1.1', sessionId: 's1' });
  await assert.rejects(
    runHandoff({ threads, channels: { slack: { send: async () => {} } },
      threadId: seed.threadId, target: 'discord', externalId: '999' }),
    /CHANNEL_NOT_AVAILABLE/);
});

test('handoff: unknown threadId surfaces THREAD_NOT_FOUND', async () => {
  const dir = tmpDir();
  const threads = openThreads(dir);
  await assert.rejects(
    runHandoff({ threads, channels: { slack: { send: async () => {} } },
      threadId: 'nope', target: 'slack', externalId: 'C9:9.9' }),
    /THREAD_NOT_FOUND/);
});
```

### 3.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-handoff.test.mjs`
- [ ] Expected: 3 failing tests, `Cannot find module '.../channels/handoff.mjs'`.

### 3.3 Implement `channels/handoff.mjs`

- [ ] Create `/Users/o/lazyclaw/channels/handoff.mjs`:

```js
// channels/handoff.mjs
//
// Migrates an active thread (sessionId) from one channel to another.
// Pure function over (threads store, live channel map) — the CLI slash
// and the daemon HTTP route both call this.

export async function runHandoff({ threads, channels, threadId, target, externalId, note = '' }) {
  const cur = threads.findByThread(threadId);
  if (!cur) {
    const err = new Error(`THREAD_NOT_FOUND: ${threadId}`);
    err.code = 'THREAD_NOT_FOUND';
    throw err;
  }
  if (!channels[target] || typeof channels[target].send !== 'function') {
    const err = new Error(`CHANNEL_NOT_AVAILABLE: ${target}`);
    err.code = 'CHANNEL_NOT_AVAILABLE';
    throw err;
  }
  const srcChannel = cur.channel;
  const srcExternal = cur.externalId;

  // 1. Persist the migration first so a crash mid-notify leaves us in the new home.
  const next = threads.handoff(threadId, { channel: target, externalId });

  // 2. Notify source (best-effort) so the human knows where the convo went.
  const tail = note ? ` — ${note}` : '';
  if (channels[srcChannel] && typeof channels[srcChannel].send === 'function') {
    try {
      await channels[srcChannel].send(srcExternal,
        `handoff: this conversation moved to ${target}${tail}`);
    } catch (e) {
      process.stderr.write(`[handoff] source notify failed: ${e.message}\n`);
    }
  }

  // 3. Notify target with a resume marker.
  await channels[target].send(externalId,
    `resumed from ${srcChannel} (session ${next.sessionId})${tail}`);

  return next;
}
```

### 3.4 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-handoff.test.mjs`
- [ ] Expected: `# pass 3`.

### 3.5 Wire `/handoff` into REPL

- [ ] Locate the REPL slash-command switch in `/Users/o/lazyclaw/cli.mjs`. Search for the existing `/help` or `/model` slash handler. Add a `/handoff` case that:
  1. Parses `argv = line.slice('/handoff '.length).trim().split(/\s+/)`.
  2. Requires `argv.length >= 2`: `target`, `externalId`. Optional `--note=...`.
  3. Loads `openThreads(resolveConfigDir())` and the live `channels` map (the same map the daemon registers — for REPL standalone mode, a stub map with the active channel only).
  4. Calls `runHandoff(...)` from `./channels/handoff.mjs` and prints `handoff -> <target>:<externalId> (session <id>)`.
  5. On error, prints `handoff failed: <code>: <message>` to stderr and stays in REPL.

Concretely insert (after reading the REPL slash dispatch block to confirm the exact `case '/model':` neighbours):

```js
      case '/handoff': {
        const parts = line.trim().split(/\s+/).slice(1);
        if (parts.length < 2) {
          process.stderr.write('usage: /handoff <target-channel> <externalId> [--note=...]\n');
          break;
        }
        const target = parts[0];
        const externalId = parts[1];
        const note = (parts.find(p => p.startsWith('--note=')) || '').slice(7);
        try {
          const { openThreads } = await import('./channels/threads.mjs');
          const { runHandoff } = await import('./channels/handoff.mjs');
          const threads = openThreads(resolveConfigDir());
          const cur = threads.findByExternal(replState.channel, replState.externalId);
          if (!cur) {
            process.stderr.write(`handoff: no thread bound to ${replState.channel}:${replState.externalId}\n`);
            break;
          }
          const next = await runHandoff({
            threads, channels: replState.channels,
            threadId: cur.threadId, target, externalId, note,
          });
          process.stdout.write(`handoff -> ${next.channel}:${next.externalId} (session ${next.sessionId})\n`);
          replState.channel = next.channel;
          replState.externalId = next.externalId;
        } catch (e) {
          process.stderr.write(`handoff failed: ${e.code || 'ERR'}: ${e.message}\n`);
        }
        break;
      }
```

`replState` is the existing REPL state object; if the project uses a different name (e.g. `chatState`), substitute that — confirm by reading the surrounding `case '/model':` handler before editing.

### 3.6 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels/handoff.mjs /Users/o/lazyclaw/tests/phaseF-channels-handoff.test.mjs /Users/o/lazyclaw/cli.mjs
git commit -m "$(cat <<'EOF'
feat(cli): /handoff slash migrates active session across channels

Uses channels/threads.mjs to rebind the stable threadId to a new
(channel, externalId) pair and posts transition stubs on both sides so
the human knows where the conversation continued (spec §8).
EOF
)"
```

---

## Task 4 — `@lazyclaw/channel-discord` plugin

discord.js v14, gateway events, follows `channels/base.mjs`.

### 4.1 Failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-discord.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

test('discord plugin: exports register() and a Channel subclass', async () => {
  const entry = pathToFileURL(path.join(process.cwd(), 'channels-discord', 'index.mjs')).href;
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  assert.equal(typeof mod.DiscordChannel, 'function');
  const ch = new mod.DiscordChannel({ token: 'fake' });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'discord');
});

test('discord plugin: register() wires factory into addChannel', async () => {
  const entry = pathToFileURL(path.join(process.cwd(), 'channels-discord', 'index.mjs')).href;
  const mod = await import(entry);
  const got = {};
  await mod.register({ Channel, addChannel: (k, f) => { got.kind = k; got.factory = f; } });
  assert.equal(got.kind, 'discord');
  const ch = got.factory({ token: 'fake' });
  assert.equal(ch.name, 'discord');
});

test('discord plugin: send() without a started client throws CLIENT_NOT_READY', async () => {
  const entry = pathToFileURL(path.join(process.cwd(), 'channels-discord', 'index.mjs')).href;
  const mod = await import(entry);
  const ch = new mod.DiscordChannel({ token: 'fake' });
  await assert.rejects(ch.send('chan-1', 'hi'), /CLIENT_NOT_READY/);
});
```

### 4.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-discord.test.mjs`
- [ ] Expected: 3 fails, missing module.

### 4.3 Plugin package files

- [ ] Create `/Users/o/lazyclaw/channels-discord/package.json`:

```json
{
  "name": "@lazyclaw/channel-discord",
  "version": "0.1.0",
  "description": "Discord channel plugin for lazyclaw v5.",
  "type": "module",
  "main": "index.mjs",
  "files": ["index.mjs"],
  "peerDependencies": {
    "lazyclaw": ">=5.0.0"
  },
  "dependencies": {
    "discord.js": "^14.16.0"
  }
}
```

- [ ] Create `/Users/o/lazyclaw/channels-discord/index.mjs`:

```js
// @lazyclaw/channel-discord
//
// discord.js v14 gateway client. Inbound MessageCreate events are routed
// to the lazyclaw daemon's handler; outbound send() posts into the
// channel id resolved from threadId.

import { Channel } from 'lazyclaw/channels/base.mjs';

export class DiscordChannel extends Channel {
  constructor(opts = {}) {
    super('discord');
    this._token = opts.token || process.env.DISCORD_BOT_TOKEN || null;
    this._client = null;
    this._lib = null;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    if (!this._token) throw new Error('DiscordChannel: DISCORD_BOT_TOKEN missing');
    this._lib = await import('discord.js');
    const { Client, GatewayIntentBits, Partials } = this._lib;
    this._client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this._client.on('messageCreate', async (msg) => {
      if (msg.author?.bot) return;
      try {
        const reply = await this._processInbound({
          threadId: String(msg.channelId),
          text: msg.content || '',
          gateInput: { token: msg.author?.id || null },
        });
        if (reply) await msg.channel.send(reply);
      } catch (e) {
        if (e.code !== 'CHANNEL_GATED') {
          process.stderr.write(`[discord] inbound error: ${e.message}\n`);
        }
      }
    });
    await this._client.login(this._token);
  }

  async send(threadId, text) {
    if (!this._client) {
      const err = new Error('CLIENT_NOT_READY');
      err.code = 'CLIENT_NOT_READY';
      throw err;
    }
    const ch = await this._client.channels.fetch(String(threadId));
    if (!ch) throw new Error(`discord channel not found: ${threadId}`);
    await ch.send(text);
  }

  async stop() {
    if (this._client) {
      try { await this._client.destroy(); } catch { /* ignore */ }
    }
    this._client = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('discord', (opts) => new DiscordChannel(opts));
}
```

Since the test imports the plugin directly from `/Users/o/lazyclaw/channels-discord/index.mjs`, the `from 'lazyclaw/channels/base.mjs'` resolution must work for tests too. Add a workspace alias by making the plugin import resolve through the relative path — replace the import line above with:

```js
import { Channel } from '../channels/base.mjs';
```

This works because the plugin lives as a sibling directory inside the same repo during dev. The published package will ship `import { Channel } from 'lazyclaw/channels/base.mjs'` — apply that rewrite at publish time via a `prepublishOnly` script (out of scope for v5.0 plumbing). Document this in a leading comment.

### 4.4 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-discord.test.mjs`
- [ ] Expected: `# pass 3`.

### 4.5 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels-discord /Users/o/lazyclaw/tests/phaseF-channels-discord.test.mjs
git commit -m "$(cat <<'EOF'
feat(channels-discord): @lazyclaw/channel-discord plugin skeleton

discord.js v14 gateway client; MessageCreate -> handler, send() posts
into channelId. Mirrors channels/base.mjs Channel contract so the
loader can plug it in alongside the in-tree channels (spec §8).
EOF
)"
```

---

## Task 5 — `@lazyclaw/channel-whatsapp` and `@lazyclaw/channel-signal` plugins

Two plugins share the same scaffold pattern; bundled in one task with parallel test files.

### 5.1 Failing tests

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-whatsapp.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-whatsapp', 'index.mjs')).href;

test('whatsapp: register + Channel subclass + QR-pending state', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.WhatsappChannel();
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'whatsapp');
  assert.equal(ch.qrState(), 'pending');
});

test('whatsapp: send() before login throws NOT_AUTHENTICATED', async () => {
  const mod = await import(entry);
  const ch = new mod.WhatsappChannel();
  await assert.rejects(ch.send('+15551234567', 'hi'), /NOT_AUTHENTICATED/);
});
```

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-signal.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-signal', 'index.mjs')).href;

test('signal: register + Channel subclass + missing signal-cli surfaces clearly', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.SignalChannel({ binary: '/does/not/exist/signal-cli', account: '+15550000000' });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'signal');
  await assert.rejects(ch.send('+15551234567', 'hi'), /SIGNAL_CLI_MISSING|ENOENT/);
});
```

### 5.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-whatsapp.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-signal.test.mjs`
- [ ] Expected: 3 fails (missing modules).

### 5.3 Implement WhatsApp plugin

- [ ] Create `/Users/o/lazyclaw/channels-whatsapp/package.json`:

```json
{
  "name": "@lazyclaw/channel-whatsapp",
  "version": "0.1.0",
  "description": "WhatsApp channel plugin for lazyclaw v5 (whatsapp-web.js).",
  "type": "module",
  "main": "index.mjs",
  "files": ["index.mjs"],
  "peerDependencies": { "lazyclaw": ">=5.0.0" },
  "dependencies": {
    "whatsapp-web.js": "^1.23.0",
    "qrcode-terminal": "^0.12.0"
  }
}
```

- [ ] Create `/Users/o/lazyclaw/channels-whatsapp/index.mjs`:

```js
// @lazyclaw/channel-whatsapp
//
// whatsapp-web.js (browser automation). First-run prints a QR via
// qrcode-terminal; subsequent runs reuse LocalAuth session in
// <configDir>/whatsapp/. Inbound `message` events route to handler.

import { Channel } from '../channels/base.mjs';

export class WhatsappChannel extends Channel {
  constructor(opts = {}) {
    super('whatsapp');
    this._opts = opts || {};
    this._client = null;
    this._qrState = 'pending'; // pending | shown | authenticated | failed
    this._lastQr = null;
  }

  qrState() { return this._qrState; }
  lastQr() { return this._lastQr; }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    const wweb = await import('whatsapp-web.js');
    const qrt = await import('qrcode-terminal');
    const { Client, LocalAuth } = wweb;
    this._client = new Client({
      authStrategy: new LocalAuth({ dataPath: this._opts.dataPath || './whatsapp' }),
      puppeteer: { headless: true },
    });
    this._client.on('qr', (qr) => {
      this._lastQr = qr;
      this._qrState = 'shown';
      qrt.default?.generate(qr, { small: true });
    });
    this._client.on('authenticated', () => { this._qrState = 'authenticated'; });
    this._client.on('auth_failure', () => { this._qrState = 'failed'; });
    this._client.on('message', async (msg) => {
      try {
        const reply = await this._processInbound({
          threadId: msg.from, text: msg.body || '', gateInput: { token: msg.from },
        });
        if (reply) await msg.reply(reply);
      } catch (e) {
        if (e.code !== 'CHANNEL_GATED') {
          process.stderr.write(`[whatsapp] inbound error: ${e.message}\n`);
        }
      }
    });
    await this._client.initialize();
  }

  async send(threadId, text) {
    if (!this._client || this._qrState !== 'authenticated') {
      const err = new Error('NOT_AUTHENTICATED');
      err.code = 'NOT_AUTHENTICATED';
      throw err;
    }
    await this._client.sendMessage(String(threadId), String(text));
  }

  async stop() {
    if (this._client) { try { await this._client.destroy(); } catch { /* ignore */ } }
    this._client = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('whatsapp', (opts) => new WhatsappChannel(opts));
}
```

### 5.4 Implement Signal plugin

- [ ] Create `/Users/o/lazyclaw/channels-signal/package.json`:

```json
{
  "name": "@lazyclaw/channel-signal",
  "version": "0.1.0",
  "description": "Signal channel plugin for lazyclaw v5 (signal-cli wrapper).",
  "type": "module",
  "main": "index.mjs",
  "files": ["index.mjs"],
  "peerDependencies": { "lazyclaw": ">=5.0.0" }
}
```

- [ ] Create `/Users/o/lazyclaw/channels-signal/index.mjs`:

```js
// @lazyclaw/channel-signal
//
// Thin wrapper around `signal-cli` (external binary, must be installed
// separately and linked to a registered account). Inbound polling uses
// `signal-cli receive --json`; outbound uses `signal-cli send`.

import { spawn, spawnSync } from 'node:child_process';
import { Channel } from '../channels/base.mjs';

export class SignalChannel extends Channel {
  constructor(opts = {}) {
    super('signal');
    this._binary = opts.binary || process.env.SIGNAL_CLI_BIN || 'signal-cli';
    this._account = opts.account || process.env.SIGNAL_ACCOUNT || null;
    this._receiver = null;
    this._pollMs = opts.pollMs || 15000;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    if (!this._account) throw new Error('SignalChannel: account (E.164) required');
    this._receiver = setInterval(() => { this._pollOnce().catch(() => {}); }, this._pollMs);
    this._receiver.unref?.();
  }

  async _pollOnce() {
    const proc = spawn(this._binary, ['-a', this._account, 'receive', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d.toString('utf8'); });
    await new Promise((resolve) => proc.on('exit', resolve));
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        const env = evt.envelope || {};
        const text = env.dataMessage?.message || '';
        const from = env.source || env.sourceNumber;
        if (!from || !text) continue;
        const reply = await this._processInbound({
          threadId: String(from), text, gateInput: { token: from },
        });
        if (reply) await this.send(from, reply);
      } catch { /* skip malformed */ }
    }
  }

  async send(threadId, text) {
    const res = spawnSync(this._binary, ['-a', this._account, 'send', '-m', String(text), String(threadId)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.error && res.error.code === 'ENOENT') {
      const err = new Error(`SIGNAL_CLI_MISSING: ${this._binary}`);
      err.code = 'SIGNAL_CLI_MISSING';
      throw err;
    }
    if (res.status !== 0) {
      throw new Error(`signal-cli send exited ${res.status}: ${res.stderr?.toString('utf8') || ''}`);
    }
  }

  async stop() {
    if (this._receiver) clearInterval(this._receiver);
    this._receiver = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('signal', (opts) => new SignalChannel(opts));
}
```

### 5.5 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-whatsapp.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-signal.test.mjs`
- [ ] Expected: `# pass 3` total.

### 5.6 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels-whatsapp /Users/o/lazyclaw/channels-signal /Users/o/lazyclaw/tests/phaseF-channels-whatsapp.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-signal.test.mjs
git commit -m "$(cat <<'EOF'
feat(channels): whatsapp and signal plugin skeletons

WhatsApp uses whatsapp-web.js with LocalAuth + qrcode-terminal QR flow;
Signal wraps signal-cli (external binary) with receive --json polling
loop. Both follow channels/base.mjs Channel contract (spec §8).
EOF
)"
```

---

## Task 6 — `@lazyclaw/channel-email` plugin (IMAP IDLE + SMTP)

### 6.1 Failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-email.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-email', 'index.mjs')).href;

test('email: register + Channel subclass with name "email"', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.EmailChannel({
    imap: { user: 'u', password: 'p', host: 'imap.example.com', port: 993, tls: true },
    smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
  });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'email');
});

test('email: send() without start throws SMTP_NOT_READY', async () => {
  const mod = await import(entry);
  const ch = new mod.EmailChannel({
    imap: { user: 'u', password: 'p', host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, user: 'u', pass: 'p' },
  });
  await assert.rejects(ch.send('to@example.com', 'hi'), /SMTP_NOT_READY/);
});

test('email: missing imap config throws IMAP_CONFIG_MISSING', async () => {
  const mod = await import(entry);
  assert.throws(() => new mod.EmailChannel({ smtp: { host: 'h' } }), /IMAP_CONFIG_MISSING/);
});
```

### 6.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-email.test.mjs`
- [ ] Expected: 3 fails, missing module.

### 6.3 Implement

- [ ] Create `/Users/o/lazyclaw/channels-email/package.json`:

```json
{
  "name": "@lazyclaw/channel-email",
  "version": "0.1.0",
  "description": "Email channel plugin for lazyclaw v5 (IMAP IDLE + SMTP).",
  "type": "module",
  "main": "index.mjs",
  "files": ["index.mjs"],
  "peerDependencies": { "lazyclaw": ">=5.0.0" },
  "dependencies": {
    "node-imap": "^0.9.6",
    "nodemailer": "^6.9.14",
    "mailparser": "^3.7.0"
  }
}
```

- [ ] Create `/Users/o/lazyclaw/channels-email/index.mjs`:

```js
// @lazyclaw/channel-email
//
// IMAP IDLE for inbound, nodemailer for outbound. threadId is the
// In-Reply-To / Message-ID chain root so replies stay in the same
// email thread.

import { Channel } from '../channels/base.mjs';

export class EmailChannel extends Channel {
  constructor(opts = {}) {
    super('email');
    if (!opts.imap || !opts.imap.user || !opts.imap.host) {
      throw new Error('IMAP_CONFIG_MISSING: imap.{user,host,password,port,tls} required');
    }
    this._imapOpts = opts.imap;
    this._smtpOpts = opts.smtp || {};
    this._from = opts.from || opts.imap.user;
    this._imap = null;
    this._transporter = null;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    const Imap = (await import('node-imap')).default;
    const { simpleParser } = await import('mailparser');
    const nodemailer = (await import('nodemailer')).default;

    this._transporter = nodemailer.createTransport({
      host: this._smtpOpts.host,
      port: this._smtpOpts.port || 587,
      secure: !!this._smtpOpts.secure,
      auth: this._smtpOpts.user ? { user: this._smtpOpts.user, pass: this._smtpOpts.pass } : undefined,
    });

    this._imap = new Imap({
      user: this._imapOpts.user,
      password: this._imapOpts.password,
      host: this._imapOpts.host,
      port: this._imapOpts.port || 993,
      tls: this._imapOpts.tls !== false,
    });

    await new Promise((resolve, reject) => {
      this._imap.once('ready', resolve);
      this._imap.once('error', reject);
      this._imap.connect();
    });
    await new Promise((resolve, reject) => {
      this._imap.openBox('INBOX', false, (err) => err ? reject(err) : resolve());
    });

    this._imap.on('mail', () => {
      this._imap.search(['UNSEEN'], (err, uids) => {
        if (err || !uids || !uids.length) return;
        const f = this._imap.fetch(uids, { bodies: '', markSeen: true });
        f.on('message', (msg) => {
          let chunks = [];
          msg.on('body', (s) => s.on('data', (d) => chunks.push(d)));
          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(Buffer.concat(chunks));
              const threadId = parsed.inReplyTo || parsed.messageId || `email:${Date.now()}`;
              const from = parsed.from?.value?.[0]?.address || 'unknown';
              const reply = await this._processInbound({
                threadId, text: parsed.text || '', gateInput: { token: from },
              });
              if (reply) {
                await this._transporter.sendMail({
                  from: this._from, to: from,
                  subject: 'Re: ' + (parsed.subject || ''),
                  text: reply,
                  inReplyTo: parsed.messageId,
                  references: parsed.references || parsed.messageId,
                });
              }
            } catch (e) {
              if (e.code !== 'CHANNEL_GATED') {
                process.stderr.write(`[email] inbound error: ${e.message}\n`);
              }
            }
          });
        });
      });
    });
  }

  async send(threadId, text) {
    if (!this._transporter) {
      const err = new Error('SMTP_NOT_READY');
      err.code = 'SMTP_NOT_READY';
      throw err;
    }
    // threadId here is the recipient address; the daemon supplies it.
    await this._transporter.sendMail({
      from: this._from, to: String(threadId), subject: 'lazyclaw', text: String(text),
    });
  }

  async stop() {
    try { this._imap?.end(); } catch { /* ignore */ }
    this._imap = null;
    this._transporter = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('email', (opts) => new EmailChannel(opts));
}
```

### 6.4 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-email.test.mjs`
- [ ] Expected: `# pass 3`.

### 6.5 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels-email /Users/o/lazyclaw/tests/phaseF-channels-email.test.mjs
git commit -m "$(cat <<'EOF'
feat(channels-email): @lazyclaw/channel-email plugin skeleton

node-imap IDLE + mailparser for inbound, nodemailer for outbound.
threadId tracks the In-Reply-To/Message-ID chain so replies stay in
the same email thread (spec §8).
EOF
)"
```

---

## Task 7 — `@lazyclaw/channel-voice` plugin (transcribe-only, TTS deferred per spec §0.2)

Hooks into voice memo events on existing Telegram/Discord channels (delegated callbacks), pipes audio buffer through an OpenAI-Whisper-compatible transcription endpoint, then forwards the resulting **text** turn through the standard handler. TTS reply is explicitly out of scope for v5.0 (spec §0.2).

### 7.1 Failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseF-channels-voice.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-voice', 'index.mjs')).href;

test('voice: register + Channel subclass with name "voice"', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.VoiceChannel({ transcribe: async () => 'hello world' });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'voice');
});

test('voice: ingestVoiceMemo routes transcript through handler', async () => {
  const mod = await import(entry);
  const calls = [];
  const ch = new mod.VoiceChannel({ transcribe: async (buf, mime) => {
    calls.push({ bytes: buf.length, mime });
    return 'transcribed text';
  }});
  let handlerArgs = null;
  await ch.start(async (evt) => { handlerArgs = evt; return 'ok'; });
  const reply = await ch.ingestVoiceMemo({
    threadId: 't-1', audio: Buffer.from('fake-ogg-bytes'), mime: 'audio/ogg',
  });
  assert.equal(reply, 'ok');
  assert.deepEqual(handlerArgs, { channel: 'voice', threadId: 't-1', text: 'transcribed text' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mime, 'audio/ogg');
});

test('voice: TTS reply is intentionally absent (spec §0.2)', async () => {
  const mod = await import(entry);
  const ch = new mod.VoiceChannel({ transcribe: async () => 'x' });
  // The plugin must NOT expose a tts/synthesize method in v5.0.
  assert.equal(typeof ch.tts, 'undefined');
  assert.equal(typeof ch.synthesize, 'undefined');
});

test('voice: missing transcribe fn at ingest time -> TRANSCRIBE_NOT_CONFIGURED', async () => {
  const mod = await import(entry);
  const ch = new mod.VoiceChannel({});
  await ch.start(async () => 'ok');
  await assert.rejects(
    ch.ingestVoiceMemo({ threadId: 't', audio: Buffer.from('x'), mime: 'audio/ogg' }),
    /TRANSCRIBE_NOT_CONFIGURED/);
});
```

### 7.2 Run — verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-voice.test.mjs`
- [ ] Expected: 4 fails, missing module.

### 7.3 Implement

- [ ] Create `/Users/o/lazyclaw/channels-voice/package.json`:

```json
{
  "name": "@lazyclaw/channel-voice",
  "version": "0.1.0",
  "description": "Voice memo channel for lazyclaw v5 (transcribe-only; TTS deferred to v5.1).",
  "type": "module",
  "main": "index.mjs",
  "files": ["index.mjs"],
  "peerDependencies": { "lazyclaw": ">=5.0.0" }
}
```

- [ ] Create `/Users/o/lazyclaw/channels-voice/index.mjs`:

```js
// @lazyclaw/channel-voice
//
// v5.0 scope per spec §0.2: TRANSCRIBE-ONLY. No TTS reply (deferred to v5.1).
//
// This channel does not own its own transport. It registers itself with
// the Telegram and Discord plugins (and any other channel that exposes
// a `onVoiceMemo` hook) and acts as the transcription pipeline.
// Telegram/Discord call `voice.ingestVoiceMemo({threadId, audio, mime})`
// when a voice memo arrives; the resulting text is forwarded through
// this channel's handler and the text reply is sent on whichever channel
// the user is currently bound to via channels/threads.mjs.

import { Channel } from '../channels/base.mjs';

export class VoiceChannel extends Channel {
  constructor(opts = {}) {
    super('voice');
    this._transcribe = typeof opts.transcribe === 'function' ? opts.transcribe : null;
  }

  setTranscriber(fn) {
    if (typeof fn !== 'function') throw new Error('setTranscriber: function required');
    this._transcribe = fn;
  }

  async ingestVoiceMemo({ threadId, audio, mime }) {
    if (!this._transcribe) {
      const err = new Error('TRANSCRIBE_NOT_CONFIGURED');
      err.code = 'TRANSCRIBE_NOT_CONFIGURED';
      throw err;
    }
    if (!Buffer.isBuffer(audio)) {
      throw new Error('ingestVoiceMemo: audio must be a Buffer');
    }
    const text = await this._transcribe(audio, mime || 'audio/ogg');
    if (!text || typeof text !== 'string') return null;
    return await this._processInbound({
      threadId: String(threadId), text, gateInput: { token: 'voice' },
    });
  }

  // send() is intentionally a no-op text passthrough — voice channel does
  // not synthesise audio in v5.0. The text reply is delivered by whichever
  // channel the thread is bound to (channels/threads.mjs).
  async send(_threadId, _text) {
    // no-op
  }
}

/**
 * Default transcriber backed by an OpenAI-Whisper-compatible endpoint
 * (e.g. OpenAI /v1/audio/transcriptions or any compatible proxy). Used
 * by the registered factory when the host does not inject one.
 */
export function makeOpenAITranscriber({ apiKey, model = 'whisper-1', baseUrl = 'https://api.openai.com/v1' }) {
  if (!apiKey) throw new Error('makeOpenAITranscriber: apiKey required');
  return async function transcribe(audio, mime) {
    const fd = new FormData();
    const ext = (mime || '').split('/')[1] || 'ogg';
    fd.append('file', new Blob([audio], { type: mime || 'audio/ogg' }), `memo.${ext}`);
    fd.append('model', model);
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) throw new Error(`transcribe HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.text || '';
  };
}

export function register({ addChannel }) {
  addChannel('voice', (opts) => {
    const ch = new VoiceChannel(opts || {});
    if (!opts?.transcribe && opts?.openai?.apiKey) {
      ch.setTranscriber(makeOpenAITranscriber(opts.openai));
    }
    return ch;
  });
}
```

### 7.4 Run — verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-voice.test.mjs`
- [ ] Expected: `# pass 4`.

### 7.5 Run the full Phase F suite

- [ ] Run: `node --test /Users/o/lazyclaw/tests/phaseF-channels-loader.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-threads.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-handoff.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-discord.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-whatsapp.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-signal.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-email.test.mjs /Users/o/lazyclaw/tests/phaseF-channels-voice.test.mjs`
- [ ] Expected: `# pass 24` (3+4+3+3+3+3+3+4-overlap=24 total; verify exact count from output and ensure 0 failures).

### 7.6 Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/channels-voice /Users/o/lazyclaw/tests/phaseF-channels-voice.test.mjs
git commit -m "$(cat <<'EOF'
feat(channels-voice): @lazyclaw/channel-voice plugin (transcribe-only)

Hooks voice memos arriving via Telegram/Discord, transcribes through a
Whisper-compatible endpoint, and routes the transcript text through the
standard channel handler. TTS reply is deliberately out of scope for
v5.0 (spec §0.2 — deferred to v5.1).
EOF
)"
```

---

## Acceptance verification

After all tasks pass individually, run the integration smoke described in the phase brief:

- [ ] `node --test /Users/o/lazyclaw/tests/phaseF-*.test.mjs` — all Phase F tests green.
- [ ] Manual check: `node /Users/o/lazyclaw/cli.mjs channels list` prints nothing (no plugins installed) without crashing.
- [ ] Manual check: in REPL, typing `/handoff foo bar` with no active thread prints `handoff: no thread bound to ...` to stderr and the REPL stays alive.
- [ ] The 4 core in-tree channels (`channels/{slack,telegram,matrix,http}.mjs`) are untouched — `git diff --name-only main -- channels/slack.mjs channels/telegram.mjs channels/matrix.mjs channels/http.mjs` returns empty.
- [ ] The 5 plugin directories each have `package.json` + `index.mjs` exporting `register()` and a `Channel` subclass, verified by the per-plugin tests above.
- [ ] Voice plugin proves the cross-channel handoff demo (test `voice: ingestVoiceMemo routes transcript through handler`) — a voice memo on one channel becomes a text turn the daemon can route to any other channel via `channels/threads.mjs` + `/handoff`.

If all six checkboxes pass, Phase F meets its acceptance criteria.
