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

test('loader: isPluginName accepts only @cmblir/channel-<slug>', () => {
  assert.equal(isPluginName('@cmblir/channel-discord'), true);
  assert.equal(isPluginName('@cmblir/channel-foo-bar'), true);
  assert.equal(isPluginName('discord'), false);
  assert.equal(isPluginName('@evil/channel-x'), false);
  assert.equal(isPluginName('@cmblir/something-else'), false);
});

test('loader: registers a local fake plugin via file: spec without network', async () => {
  const cfgDir = tmpDir();
  const pkgDir = path.join(tmpDir(), 'fakeplug');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@cmblir/channel-fake', version: '0.0.1', type: 'module', main: 'index.mjs',
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
  await loader.loadFromPath('@cmblir/channel-fake', pkgDir);
  const factory = loader.getFactory('fake');
  assert.equal(typeof factory, 'function');
  const ch = factory({});
  assert.equal(ch.name, 'fake');
});

test('loader: listInstalled reads node_modules and ignores non-plugin packages', () => {
  const cfgDir = tmpDir();
  const nm = path.join(cfgDir, 'node_modules', '@cmblir');
  fs.mkdirSync(nm, { recursive: true });
  fs.mkdirSync(path.join(nm, 'channel-discord'));
  fs.writeFileSync(path.join(nm, 'channel-discord', 'package.json'),
    JSON.stringify({ name: '@cmblir/channel-discord', version: '1.2.3' }));
  fs.mkdirSync(path.join(cfgDir, 'node_modules', 'left-pad'));
  fs.writeFileSync(path.join(cfgDir, 'node_modules', 'left-pad', 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.0.0' }));
  const out = listInstalled(cfgDir);
  assert.deepEqual(out, [{ name: '@cmblir/channel-discord', version: '1.2.3' }]);
});

test('loader: rejects unsafe package names before invoking npm', async () => {
  const loader = createLoader({ configDir: tmpDir() });
  await assert.rejects(loader.install('rm -rf /'), /INVALID_PLUGIN_NAME/);
  await assert.rejects(loader.install('@cmblir/not-a-channel'), /INVALID_PLUGIN_NAME/);
});
