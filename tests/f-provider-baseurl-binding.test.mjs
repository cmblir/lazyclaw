// A registered provider's endpoint is bound once by the adapter. Callers forward
// `baseUrl` unconditionally (mas/agent_turn.mjs:261), so it arrives as undefined
// whenever nobody set one — and a spread let that undefined erase the binding,
// silently redirecting the request to the vendor's own endpoint. For a
// self-hosted or corporate gateway that means prompts leaving for a host the
// operator never configured.
import test from 'node:test';
import assert from 'node:assert/strict';

test('an undefined baseUrl in the call does not erase the provider binding', async () => {
  const seen = [];
  const base = { callOnce: async (opts) => { seen.push(opts.baseUrl); return { text: 'ok' }; } };
  const { _bindBaseUrl } = await import('../mas/provider_adapters.mjs');
  const bound = _bindBaseUrl(base, 'https://internal.example/v1');

  await bound.callOnce({ model: 'm' });                     // nothing set
  await bound.callOnce({ model: 'm', baseUrl: undefined }); // forwarded as undefined
  assert.deepEqual(seen, ['https://internal.example/v1', 'https://internal.example/v1'],
    'both calls must reach the configured endpoint');
});

test('an explicit baseUrl still wins — that part of the contract is real', async () => {
  const seen = [];
  const base = { callOnce: async (opts) => { seen.push(opts.baseUrl); return { text: 'ok' }; } };
  const { _bindBaseUrl } = await import('../mas/provider_adapters.mjs');
  const bound = _bindBaseUrl(base, 'https://internal.example/v1');
  await bound.callOnce({ baseUrl: 'https://override.example/v1' });
  assert.deepEqual(seen, ['https://override.example/v1']);
});

test('an explicit empty string is a caller error, not an override', async () => {
  // '' would resolve to the vendor default just as undefined did. Refusing it
  // is safer than honouring it, because no caller means "use the default" by
  // passing an empty string.
  const seen = [];
  const base = { callOnce: async (opts) => { seen.push(opts.baseUrl); return { text: 'ok' }; } };
  const { _bindBaseUrl } = await import('../mas/provider_adapters.mjs');
  const bound = _bindBaseUrl(base, 'https://internal.example/v1');
  await bound.callOnce({ baseUrl: '' });
  assert.deepEqual(seen, ['https://internal.example/v1']);
});
