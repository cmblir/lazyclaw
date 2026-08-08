// channels/loader.mjs
//
// Plugin loader for @cmblir/channel-<name> packages. Installs into
// <configDir>/node_modules via `npm install <spec>` and dynamic-imports
// the entry, calling the package's exported register({Channel, addChannel}).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Channel } from './base.mjs';

const PLUGIN_RE = /^@cmblir\/channel-[a-z][a-z0-9-]*$/;

export function isPluginName(name) {
  return typeof name === 'string' && PLUGIN_RE.test(name);
}

export function listInstalled(configDir) {
  const root = path.join(String(configDir), 'node_modules', '@cmblir');
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
