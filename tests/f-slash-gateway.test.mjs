// tests/f-slash-gateway.test.mjs — /gateway status|start|stop inside the chat
// REPL. Everything external (pidfile probe, health fetch, child spawn) is
// injected so the test never touches a real port or process.
import test from 'node:test';
import assert from 'node:assert/strict';

import { gatewaySlash } from '../tui/slash_gateway.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

const ctx = { cfgDir: '/cfg', cfg: { channels: { slack: { enabled: true }, telegram: { enabled: false } } } };

test('/gateway is in the catalog and has a handler', () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.cmd === '/gateway'), 'catalog row missing');
  assert.ok(SLASH_HANDLERS.has('/gateway'), 'handler not registered');
});

test('status reports a stopped gateway', async () => {
  const out = await gatewaySlash('', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    readToken: () => null,
  });
  assert.match(out, /not running/);
  assert.match(out, /\/gateway start/);
});

test('status reports a running gateway with health, port and channels', async () => {
  const out = await gatewaySlash('status', ctx, {
    status: () => ({ running: true, pid: 4242, port: 19600 }),
    readToken: () => 'tok',
    fetch: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:19600/health');
      assert.equal(opts.headers.authorization, 'Bearer tok');
      return { ok: true, status: 200 };
    },
  });
  assert.match(out, /running/);
  assert.match(out, /pid:\s+4242/);
  assert.match(out, /19600/);
  assert.match(out, /healthy/);
  assert.match(out, /slack/);
  assert.doesNotMatch(out, /telegram/, 'disabled channels must not be listed as enabled');
});

test('status reports a listening-but-unauthorized gateway distinctly', async () => {
  const out = await gatewaySlash('status', ctx, {
    status: () => ({ running: true, pid: 1, port: 19600 }),
    readToken: () => 'stale',
    fetch: async () => ({ ok: false, status: 401 }),
  });
  assert.match(out, /auth token mismatch/);
});

test('status survives a health probe that never answers', async () => {
  const out = await gatewaySlash('status', ctx, {
    status: () => ({ running: true, pid: 1, port: 19600 }),
    readToken: () => null,
    fetch: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.match(out, /unreachable/);
});

test('start refuses when a gateway is already running', async () => {
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: true, pid: 7, port: 19600 }),
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.match(out, /already running/);
});

test('start spawns a detached gateway and waits for it to come up', async () => {
  let spawned = null;
  let probes = 0;
  const out = await gatewaySlash('start', ctx, {
    status: () => (probes++ === 0 ? { running: false, pid: null, port: null }
                                  : { running: true, pid: 900, port: 19600 }),
    spawn: (cmd, argv, opts) => {
      spawned = { cmd, argv, opts };
      return { unref() {} };
    },
    sleep: async () => {},
  });
  assert.ok(spawned, 'spawn was not called');
  assert.deepEqual(spawned.argv.slice(-1), ['gateway']);
  assert.equal(spawned.opts.detached, true, 'the gateway must outlive this chat session');
  // stderr is PIPED, not ignored: a gateway that cannot bind says why in one
  // line and exits, and discarding that left only a generic timeout. stdin and
  // stdout stay ignored — we want the reason, not its whole log.
  assert.deepEqual(spawned.opts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.match(out, /started/);
  assert.match(out, /pid 900/);
});

test('start --port <N> passes a one-off override to the spawned child, without persisting', async () => {
  let spawned = null;
  let probes = 0;
  let wrote = false;
  const localCtx = { ...ctx, writeConfig: () => { wrote = true; } };
  const out = await gatewaySlash('start --port 5050', localCtx, {
    status: () => (probes++ === 0 ? { running: false, pid: null, port: null }
                                  : { running: true, pid: 901, port: 5050 }),
    spawn: (cmd, argv, opts) => {
      spawned = { cmd, argv, opts };
      return { unref() {} };
    },
    sleep: async () => {},
  });
  assert.ok(spawned, 'spawn was not called');
  const pi = spawned.argv.indexOf('--port');
  assert.ok(pi >= 0, 'the spawned child must receive --port');
  assert.equal(spawned.argv[pi + 1], '5050');
  assert.match(out, /started/);
  assert.equal(wrote, false, 'a one-off start override must not persist to config');
});

test('start reports a spawn that fails outright', async () => {
  // Distinct from "spawned but never came up": here the child never starts at
  // all (bad node path, EACCES, EMFILE). The handler must report it rather than
  // sit through the 6s start poll waiting for something that will never exist.
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    spawn: () => { throw new Error('EACCES: permission denied'); },
    sleep: async () => { throw new Error('must not poll after a failed spawn'); },
  });
  assert.match(out, /could not spawn/);
  assert.match(out, /EACCES/);
});

test('start reports a gateway that never came up instead of hanging', async () => {
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    spawn: () => ({ unref() {} }),
    sleep: async () => {},
  });
  assert.match(out, /did not come up/);
});

test('stop signals a running gateway', async () => {
  const out = await gatewaySlash('stop', ctx, {
    stop: () => ({ running: true, pid: 4242, port: 19600, killed: true, exitCode: 0 }),
  });
  assert.match(out, /stopped/);
  assert.match(out, /4242/);
});

test('stop on a stopped gateway is not an error', async () => {
  const out = await gatewaySlash('stop', ctx, {
    stop: () => ({ running: false, pid: null, port: null, killed: false, exitCode: 0 }),
  });
  assert.match(out, /not running/);
});

test('an unknown subcommand lists the valid ones', async () => {
  const out = await gatewaySlash('bogus', ctx, {});
  assert.match(out, /status/);
  assert.match(out, /start/);
  assert.match(out, /stop/);
});

// A gateway that fails to bind (the common case: the dashboard already holds
// port 19600) exits within a second with a one-line reason on stderr. The
// original implementation spawned with stdio:'ignore', so that reason was
// discarded and the user got "spawned but did not come up within 6s — run
// `lazyclaw gateway` in a terminal to see why", which is the tool asking the
// user to do its job. Capture the child's stderr and report it.
test('start surfaces the child\'s own failure reason instead of a generic timeout', async () => {
  const listeners = {};
  const child = {
    unref() {},
    stderr: { on: (ev, fn) => { listeners[`stderr:${ev}`] = fn; } },
    on: (ev, fn) => { listeners[ev] = fn; },
  };
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    spawn: () => child,
    sleep: async () => {
      // Mimic the real sequence: the child writes its reason, then exits 2.
      listeners['stderr:data']?.(Buffer.from(
        'gateway: listen EADDRINUSE: address already in use 127.0.0.1:19600\n',
      ));
      listeners.exit?.(2, null);
    },
  });
  assert.match(out, /EADDRINUSE/, 'the bind failure must reach the user');
  assert.match(out, /19600/, 'and so must the port it collided on');
  assert.doesNotMatch(out, /did not come up within/, 'a real reason must replace the generic timeout');
});

test('start still reports a silent no-show when the child says nothing', async () => {
  const child = { unref() {}, stderr: { on() {} }, on() {} };
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    spawn: () => child,
    sleep: async () => {},
  });
  assert.match(out, /did not come up/, 'the timeout path must survive for a child that hangs silently');
});

test('start tolerates a spawn result with no stderr stream', async () => {
  // Defensive: a stubbed/older spawn may not expose stderr at all.
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    spawn: () => ({ unref() {} }),
    sleep: async () => {},
  });
  assert.match(out, /did not come up/);
});

// ---- /gateway port [N] — read/write the configured port through the ctx
// readConfig/writeConfig seam, the same pattern tui/hud.mjs's hudSlash uses.

function fakeCtx(initialCfg) {
  const store = { cfg: initialCfg };
  return {
    cfgDir: '/cfg',
    cfg: store.cfg,
    readConfig: () => store.cfg,
    writeConfig: (c) => { store.cfg = c; },
    _store: store,
  };
}

test('/gateway port with no argument reports the effective port and its source (default)', async () => {
  const out = await gatewaySlash('port', fakeCtx({}), { isPortListening: async () => false });
  assert.match(out, /19600/);
  assert.match(out, /default/);
});

test('/gateway port with no argument reports the configured value and source (config)', async () => {
  const out = await gatewaySlash('port', fakeCtx({ gateway: { port: 7777 } }), { isPortListening: async () => false });
  assert.match(out, /7777/);
  assert.match(out, /config/);
});

test('/gateway port <N> persists to cfg.gateway.port, reports old -> new, and mirrors onto ctx.cfg', async () => {
  const localCtx = fakeCtx({});
  const out = await gatewaySlash('port 6001', localCtx, { isPortListening: async () => false });
  assert.match(out, /19600/, 'the old value must be reported');
  assert.match(out, /6001/, 'the new value must be reported');
  assert.match(out, /restart/i);
  assert.equal(localCtx._store.cfg.gateway.port, 6001, 'must be persisted through ctx.writeConfig');
  assert.equal(localCtx.cfg.gateway.port, 6001, 'must mirror onto ctx.cfg for a live getStatus');
});

test('/gateway port <N> refuses a non-numeric value and writes nothing', async () => {
  const localCtx = fakeCtx({});
  const out = await gatewaySlash('port abc', localCtx, {});
  assert.match(out, /invalid/i);
  assert.equal(localCtx._store.cfg.gateway, undefined, 'nothing should have been written');
});

test('/gateway port <N> refuses an out-of-range value and writes nothing', async () => {
  const localCtx = fakeCtx({});
  const out = await gatewaySlash('port 80', localCtx, {});
  assert.match(out, /invalid/i);
  assert.match(out, /1024/);
  assert.equal(localCtx._store.cfg.gateway, undefined);
});

test('/gateway port <N> refuses a port already listening elsewhere and writes nothing', async () => {
  const localCtx = fakeCtx({});
  const out = await gatewaySlash('port 6002', localCtx, { isPortListening: async () => true });
  assert.match(out, /already in use/i);
  assert.equal(localCtx._store.cfg.gateway, undefined);
});

test('/gateway status reports whether the configured port came from config or the default', async () => {
  const outDefault = await gatewaySlash('status', fakeCtx({ channels: {} }), {
    status: () => ({ running: true, pid: 4242, port: 19600 }),
    readToken: () => null,
    fetch: async () => ({ ok: true, status: 200 }),
  });
  assert.match(outDefault, /default/);

  const outConfigured = await gatewaySlash('status', fakeCtx({ gateway: { port: 7000 }, channels: {} }), {
    status: () => ({ running: true, pid: 4242, port: 7000 }),
    readToken: () => null,
    fetch: async () => ({ ok: true, status: 200 }),
  });
  assert.match(outConfigured, /config/);
  assert.match(outConfigured, /7000/);
});
