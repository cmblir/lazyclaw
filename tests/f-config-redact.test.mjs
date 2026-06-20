// tests/f-config-redact.test.mjs — GET /config on the (default-unauthenticated)
// daemon must not serve credential material. configGet only masked the
// top-level 'api-key' on a shallow copy, leaking customProviders[].apiKey,
// authProfiles key material, and channel bot tokens in cleartext to any local
// process. redactConfigTree deep-masks every secret-named STRING value while
// leaving structure and non-secret values (incl. numeric budgets) intact.

import test from 'node:test';
import assert from 'node:assert/strict';
import { redactConfigTree } from '../mas/redact.mjs';
import { configGet, configKeyGet } from '../daemon/routes/config.mjs';

// Minimal res capturing writeHead(status)/end(body) like daemon/lib/respond.js.
function mockRes() {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(status) { out.status = status; return this; },
    end(body) { out.body = body; },
  };
}

const sampleConfig = () => ({
  provider: 'openai',
  model: 'gpt-4.1',
  'api-key': 'sk-topsecret1234567890',
  customProviders: [{ name: 'nim', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-abcdef1234567890' }],
  authProfiles: { openai: [{ label: 'work', apiKey: 'sk-work9999000011' }] },
  chatWindow: { turns: 40, tokens: 16000 },
  channels: { slack: { enabled: true, botToken: 'xoxb-leak-9999' } },
});

test('redactConfigTree masks every nested secret string and preserves the rest', () => {
  const cfg = sampleConfig();
  const r = redactConfigTree(cfg);
  const dump = JSON.stringify(r);
  // No secret material survives anywhere in the tree.
  for (const leak of ['sk-topsecret1234567890', 'nvapi-abcdef1234567890', 'sk-work9999000011', 'xoxb-leak-9999']) {
    assert.ok(!dump.includes(leak), `secret must not leak: ${leak}`);
  }
  // Non-secret values and structure intact.
  assert.equal(r.provider, 'openai');
  assert.equal(r.model, 'gpt-4.1');
  assert.equal(r.customProviders[0].baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(r.customProviders[0].name, 'nim');
  assert.equal(r.channels.slack.enabled, true);
  // Numeric token budget is NOT a secret — must stay a number.
  assert.equal(r.chatWindow.tokens, 16000);
  assert.equal(r.chatWindow.turns, 40);
});

test('redactConfigTree does not mutate the input config', () => {
  const cfg = sampleConfig();
  redactConfigTree(cfg);
  assert.equal(cfg.customProviders[0].apiKey, 'nvapi-abcdef1234567890', 'source config untouched');
  assert.equal(cfg['api-key'], 'sk-topsecret1234567890');
});

test('redactConfigTree applies a supplied mask fn (hinted masking)', () => {
  const r = redactConfigTree({ 'api-key': 'sk-abcdefgh12345678' }, (s) => `MASK(${s.length})`);
  assert.equal(r['api-key'], 'MASK(19)');
});

test('GET /config (configGet) does not leak any nested credential', async () => {
  const res = mockRes();
  await configGet({ ctx: { readConfig: () => sampleConfig() }, res });
  assert.equal(res.out.status, 200);
  for (const leak of ['sk-topsecret1234567890', 'nvapi-abcdef1234567890', 'sk-work9999000011', 'xoxb-leak-9999']) {
    assert.ok(!res.out.body.includes(leak), `GET /config leaked ${leak}`);
  }
  const parsed = JSON.parse(res.out.body);
  assert.equal(parsed.provider, 'openai');
  assert.equal(parsed.chatWindow.tokens, 16000);
});

test('GET /config/customProviders (configKeyGet) deep-masks the nested apiKey', async () => {
  const res = mockRes();
  await configKeyGet({
    ctx: { readConfig: () => sampleConfig() },
    res,
    configKeyMatch: [null, 'customProviders'],
  });
  assert.equal(res.out.status, 200);
  assert.ok(!res.out.body.includes('nvapi-abcdef1234567890'), 'customProviders apiKey leaked');
  const parsed = JSON.parse(res.out.body);
  assert.equal(parsed.value[0].baseUrl, 'https://integrate.api.nvidia.com/v1', 'non-secret fields preserved');
});
