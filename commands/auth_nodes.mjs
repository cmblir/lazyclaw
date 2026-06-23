// Auth profiles, device pairing, node registry, message bus, and workspace
// commands, extracted from cli.mjs (Phase D3). Owns the _configFeatures
// lazy-load state (used only by this group).
import path from 'node:path';
import { configPath, readConfig, writeConfig } from '../lib/config.mjs';

let _configFeatures = null;
export async function _ensureConfigFeatures() {
  if (!_configFeatures) _configFeatures = await import('../config_features.mjs');
  return _configFeatures;
}

export async function cmdAuth(sub, positional, flags = {}) {
  const m = await _ensureConfigFeatures();
  const cfg = readConfig();
  switch (sub) {
    case undefined:
    case 'list': {
      const provider = positional[0];
      if (!provider) {
        // No provider given → return the active-label map for every
        // provider that has at least one profile so the user can see
        // their full auth state at once.
        const out = {};
        for (const p of Object.keys(cfg.authProfiles || {})) {
          out[p] = {
            active: (cfg.authActiveProfile || {})[p] || null,
            profiles: m.authList(cfg, p),
          };
        }
        console.log(JSON.stringify(out, null, 2));
        return;
      }
      const profiles = m.authList(cfg, provider);
      console.log(JSON.stringify({
        provider,
        active: (cfg.authActiveProfile || {})[provider] || null,
        profiles,
      }, null, 2));
      return;
    }
    case 'add': {
      const [provider, key] = positional;
      if (!provider || !key) {
        console.error('Usage: lazyclaw auth add <provider> <key> [--label <name>]');
        process.exit(2);
      }
      try {
        const lbl = m.authAdd(cfg, provider, key, flags.label);
        writeConfig(cfg);
        console.log(JSON.stringify({ ok: true, provider, label: lbl }));
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    case 'remove': {
      const [provider, label] = positional;
      if (!provider || !label) {
        console.error('Usage: lazyclaw auth remove <provider> <label>');
        process.exit(2);
      }
      try { m.authRemove(cfg, provider, label); writeConfig(cfg); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, provider, removed: label }));
      return;
    }
    case 'use': {
      const [provider, label] = positional;
      if (!provider || !label) {
        console.error('Usage: lazyclaw auth use <provider> <label>');
        process.exit(2);
      }
      try { m.authUse(cfg, provider, label); writeConfig(cfg); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, provider, active: label }));
      return;
    }
    case 'rotate': {
      const provider = positional[0];
      if (!provider) {
        console.error('Usage: lazyclaw auth rotate <provider>');
        process.exit(2);
      }
      const next = m.authRotate(cfg, provider);
      if (!next) {
        console.error(`error: need at least 2 profiles to rotate (provider "${provider}")`);
        process.exit(1);
      }
      writeConfig(cfg);
      console.log(JSON.stringify({ ok: true, provider, active: next }));
      return;
    }
    default:
      console.error('Usage: lazyclaw auth <list|add|remove|use|rotate> ...');
      process.exit(2);
  }
}

export async function cmdPairing(sub, positional, flags = {}) {
  const m = await _ensureConfigFeatures();
  const cfg = readConfig();
  switch (sub) {
    case undefined:
    case 'list':
      console.log(JSON.stringify(m.pairingList(cfg), null, 2));
      return;
    case 'add': {
      const id = positional[0];
      if (!id) {
        console.error('Usage: lazyclaw pairing add <id> [--label <name>]');
        process.exit(2);
      }
      try { m.pairingAdd(cfg, id, flags.label); writeConfig(cfg); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, id }));
      return;
    }
    case 'remove': {
      const id = positional[0];
      if (!id) {
        console.error('Usage: lazyclaw pairing remove <id>');
        process.exit(2);
      }
      try { m.pairingRemove(cfg, id); writeConfig(cfg); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, removed: id }));
      return;
    }
    default:
      console.error('Usage: lazyclaw pairing <list|add|remove> ...');
      process.exit(2);
  }
}

export async function cmdNodes(sub, positional, flags = {}) {
  const m = await _ensureConfigFeatures();
  const cfg = readConfig();
  switch (sub) {
    case undefined:
    case 'list':
      console.log(JSON.stringify(m.nodesList(cfg), null, 2));
      return;
    case 'register': {
      const id = positional[0];
      if (!id) {
        console.error('Usage: lazyclaw nodes register <id> [--platform macos|ios|android|web|cli] [--label <name>]');
        process.exit(2);
      }
      try { m.nodesRegister(cfg, id, flags.platform || 'cli', flags.label || ''); writeConfig(cfg); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, id, platform: flags.platform || 'cli' }));
      return;
    }
    case 'remove': {
      const id = positional[0];
      if (!id) {
        console.error('Usage: lazyclaw nodes remove <id>');
        process.exit(2);
      }
      try { m.nodesRemove(cfg, id); writeConfig(cfg); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, removed: id }));
      return;
    }
    // Device-gateway pairing (Phase 27) — distinct from the config-based
    // `nodes register` table above. These drive the Ed25519 PairingStore
    // a companion node authenticates against via `lazyclaw daemon`.
    case 'pending': {
      const { PairingStore } = await import('../gateway/device_auth.mjs');
      const store = new PairingStore(path.dirname(configPath()));
      console.log(JSON.stringify(store.pending(), null, 2));
      return;
    }
    case 'devices': {
      const { PairingStore } = await import('../gateway/device_auth.mjs');
      const store = new PairingStore(path.dirname(configPath()));
      console.log(JSON.stringify(store.devicesList(), null, 2));
      return;
    }
    case 'approve': {
      const requestId = positional[0];
      if (!requestId) {
        console.error('Usage: lazyclaw nodes approve <requestId>   (see `lazyclaw nodes pending`)');
        process.exit(2);
      }
      const { PairingStore } = await import('../gateway/device_auth.mjs');
      const store = new PairingStore(path.dirname(configPath()));
      try {
        const { deviceId } = store.approve(requestId);
        // The token is intentionally NOT printed — the device receives its
        // rotated token on its next /gateway/connect, so it never has to
        // pass through a terminal / shell history.
        console.log(JSON.stringify({ ok: true, approved: requestId, deviceId, note: 'device receives its token on next /gateway/connect' }));
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    case 'revoke': {
      const deviceId = positional[0];
      if (!deviceId) {
        console.error('Usage: lazyclaw nodes revoke <deviceId>');
        process.exit(2);
      }
      const { PairingStore } = await import('../gateway/device_auth.mjs');
      const store = new PairingStore(path.dirname(configPath()));
      console.log(JSON.stringify(store.revoke(deviceId)));
      return;
    }
    case 'rotate': {
      const deviceId = positional[0];
      if (!deviceId) {
        console.error('Usage: lazyclaw nodes rotate <deviceId> [--ttl <ms>]');
        process.exit(2);
      }
      const ttlRaw = flags.ttl;
      const ttlMs = (ttlRaw !== undefined && ttlRaw !== true) ? Number(ttlRaw) : undefined;
      const { PairingStore } = await import('../gateway/device_auth.mjs');
      const store = new PairingStore(path.dirname(configPath()));
      try {
        const { expiresAt } = store.rotate(deviceId, { ttlMs });
        // Like approve, the token is intentionally NOT printed — the device
        // receives its rotated token on its next /gateway/connect.
        console.log(JSON.stringify({ ok: true, rotated: deviceId, ...(expiresAt ? { expiresAt } : {}), note: 'device receives its new token on next /gateway/connect' }));
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    default:
      console.error('Usage: lazyclaw nodes <list|register|remove|pending|approve <requestId>|revoke <deviceId>|rotate <deviceId>|devices> ...');
      process.exit(2);
  }
}

export async function cmdMessage(sub, positional, flags = {}) {
  const m = await _ensureConfigFeatures();
  const cfg = readConfig();
  switch (sub) {
    case undefined:
    case 'list':
      console.log(JSON.stringify(m.messageList(cfg), null, 2));
      return;
    case 'add': {
      const [name, url] = positional;
      if (!name || !url) {
        console.error('Usage: lazyclaw message add <name> <webhook-url> [--kind slack|discord|generic]');
        process.exit(2);
      }
      try { m.messageAdd(cfg, name, url, flags.kind); writeConfig(cfg); }
      catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
      console.log(`✓ added "${name}" webhook.`);
      return;
    }
    case 'remove': {
      const name = positional[0];
      if (!name) {
        console.error('Usage: lazyclaw message remove <name>');
        process.exit(2);
      }
      try { m.messageRemove(cfg, name); writeConfig(cfg); }
      catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
      console.log(`✓ removed "${name}".`);
      return;
    }
    case 'send': {
      const [name, ...textParts] = positional;
      if (!name) {
        console.error('Usage: lazyclaw message send <name> <text|->');
        process.exit(2);
      }
      let text = textParts.join(' ');
      // `-` reads body from stdin so a long agent reply can be piped:
      //   lazyclaw agent "summarize foo" | lazyclaw message send team -
      if (text === '-' || (!text && !process.stdin.isTTY)) {
        text = await new Promise((resolve) => {
          let buf = '';
          process.stdin.on('data', (c) => { buf += c; });
          process.stdin.on('end', () => resolve(buf.trim()));
        });
      }
      if (!text) {
        console.error('error: empty message body');
        process.exit(1);
      }
      try {
        const r = await m.messageSend(cfg, name, text);
        console.log(`✓ sent to "${name}" (${r.kind}).`);
      } catch (e) {
        console.error(`✗ ${e.message}`); process.exit(1);
      }
      return;
    }
    default:
      console.error('Usage: lazyclaw message <list|add|remove|send> ...');
      process.exit(2);
  }
}

export async function cmdWorkspace(sub, positional, flags = {}) {
  const ws = await import('../workspace.mjs');
  const cfgDir = path.dirname(configPath());
  switch (sub) {
    case undefined:
    case 'list': {
      console.log(JSON.stringify(ws.listWorkspaces(cfgDir), null, 2));
      return;
    }
    case 'init': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw workspace init <name>'); process.exit(2); }
      try {
        const dir = ws.initWorkspace(cfgDir, name);
        console.log(JSON.stringify({ ok: true, name, dir, files: ws.WORKSPACE_FILES }));
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    case 'show': {
      const [name, fileName] = positional;
      if (!name) { console.error('Usage: lazyclaw workspace show <name> [<file>]'); process.exit(2); }
      try {
        if (fileName) process.stdout.write(ws.readWorkspaceFile(cfgDir, name, fileName));
        else          process.stdout.write(ws.composeWorkspacePrompt(cfgDir, name) + '\n');
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    case 'remove': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw workspace remove <name>'); process.exit(2); }
      try { ws.removeWorkspace(cfgDir, name); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      console.log(JSON.stringify({ ok: true, removed: name }));
      return;
    }
    case 'path': {
      const name = positional[0];
      if (!name) { console.log(ws.workspaceRoot(cfgDir)); return; }
      try { console.log(ws.workspaceDir(cfgDir, name)); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    default:
      console.error('Usage: lazyclaw workspace <list|init|show|remove|path> ...');
      process.exit(2);
  }
}
