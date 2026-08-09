// tests/f-config-merge-safety.test.mjs
//
// Four commands preserve unrelated config keys by reading, merging and writing
// back. Each swallowed a parse failure and started from {} — so a corrupt
// config.json was not preserved, it was REPLACED with just the block being
// set, and the command reported success. A missing file is fresh; an
// unreadable one is not ours to discard.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = [];
function tmpCfg(contents) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-merge-'));
  dirs.push(d);
  if (contents !== undefined) fs.writeFileSync(path.join(d, 'config.json'), contents);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const CORRUPT = '{ "provider": "claude-cli", "maxTokens": 4096, BROKEN';

function mkCtx(cfgDir) {
  return { cfgDir, cfg: {}, readConfig: () => ({}), writeConfig: () => {} };
}

test('/trainer set refuses to overwrite a config it could not parse', async () => {
  const dir = tmpCfg(CORRUPT);
  const { _trainer } = await import('../tui/slash_trainer.mjs');
  const ctx = mkCtx(dir);
  const out = await _trainer('set claude-cli', ctx);
  assert.doesNotMatch(String(out), /^✓/, 'must not claim success');
  assert.match(String(out), /config\.json/, 'the message must name the file the operator has to fix');
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), CORRUPT,
    'the unreadable file is left exactly as it was — a misplaced comma is recoverable until something overwrites it');
  // The dispatcher's HTTP adapter (daemon/lib/slash_http.mjs's finalizeEnvelope)
  // turns a truthy ctx.__persistFailed into {ok:false, code:'PERSIST_FAILED'}
  // — the same signal /provider and /model already use for a write that did
  // not land. Without it, a returned error string alone still reaches the
  // dashboard as {ok:true}, which is the exact class of bug this phase exists
  // to close.
  assert.ok(ctx.__persistFailed, 'refusal must set ctx.__persistFailed so the HTTP envelope reports ok:false');
});

test('/personality use refuses the same way', async () => {
  const dir = tmpCfg(CORRUPT);
  // The corrupt-config refusal lives inside _personalityUse, which is only
  // reached once the named personality file exists — `fs.existsSync` on a
  // missing file returns "personality not installed" before config.json is
  // ever touched, which would make this test pass trivially (unchanged file,
  // no leading ✓) regardless of whether the read-merge-write fix works. The
  // file must exist so the corrupt-config path actually runs.
  fs.mkdirSync(path.join(dir, 'personalities'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'personalities', 'anything.md'), '# anything');
  const { dispatchSlash } = await import('../tui/slash_dispatcher.mjs');
  const ctx = mkCtx(dir);
  const out = await dispatchSlash('/personality', 'use anything', ctx, () => {});
  assert.doesNotMatch(String(out), /^✓/);
  assert.match(String(out), /config\.json/, 'the message must name the file the operator has to fix');
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), CORRUPT);
  assert.ok(ctx.__persistFailed, 'refusal must set ctx.__persistFailed so the HTTP envelope reports ok:false');
});

test('a MISSING config is still treated as fresh, and the write lands', async () => {
  // The distinction is the whole point: absent means start clean, unreadable
  // means stop. Conflating them is what caused the loss.
  const dir = tmpCfg(undefined);
  const { _trainer } = await import('../tui/slash_trainer.mjs');
  const ctx = mkCtx(dir);
  const out = await _trainer('set claude-cli', ctx);
  assert.match(String(out), /^✓/, 'no file to protect — this must still work');
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(written.trainer.provider, 'claude-cli');
  assert.equal(ctx.__persistFailed, undefined, 'a successful write must not trip the failure signal');
});

test('a VALID config keeps its unrelated keys, which is what the merge is for', async () => {
  const dir = tmpCfg(JSON.stringify({ provider: 'claude-cli', maxTokens: 4096 }));
  const { _trainer } = await import('../tui/slash_trainer.mjs');
  const ctx = mkCtx(dir);
  await _trainer('set claude-cli', ctx);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(written.maxTokens, 4096, 'the unrelated key survives');
  assert.equal(written.provider, 'claude-cli');
  assert.equal(written.trainer.provider, 'claude-cli');
  assert.equal(ctx.__persistFailed, undefined);
});
