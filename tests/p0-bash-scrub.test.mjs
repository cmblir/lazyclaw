// P0 security — the bash tool must not hand inherited secrets to the child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEnv, isSecretKey } from '../mas/scrub_env.mjs';
import * as bash from '../mas/tools/bash.mjs';

test('scrubEnv drops secret-shaped keys and keeps operational ones', () => {
  const src = {
    ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y', BRAVE_API_KEY: 'b',
    GITHUB_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'o', SLACK_BOT_SECRET: 's',
    DB_PASSWORD: 'p', AWS_ACCESS_KEY: 'a',
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'C', TERM: 'xterm', FOO: 'bar',
  };
  const out = scrubEnv(src);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BRAVE_API_KEY', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_BOT_SECRET', 'DB_PASSWORD', 'AWS_ACCESS_KEY']) {
    assert.equal(out[k], undefined, `${k} must be scrubbed`);
  }
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'FOO']) {
    assert.equal(out[k], src[k], `${k} must be kept`);
  }
  // original object is not mutated
  assert.equal(src.ANTHROPIC_API_KEY, 'sk-x');
});

test('scrubEnv allow-list opts a specific key back in', () => {
  const out = scrubEnv({ MY_TOKEN: 'keep', OTHER_TOKEN: 'drop' }, { allow: ['MY_TOKEN'] });
  assert.equal(out.MY_TOKEN, 'keep');
  assert.equal(out.OTHER_TOKEN, undefined);
});

test('isSecretKey classification', () => {
  for (const k of ['X_API_KEY', 'X_APIKEY', 'Y_TOKEN', 'Z_SECRET', 'A_PASSWORD', 'B_PRIVATE_KEY', 'C_ACCESS_KEY']) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ['PATH', 'HOME', 'KEYBOARD', 'TOKENIZER', 'MODEL']) {
    assert.equal(isSecretKey(k), false, k);
  }
});

test('isSecretKey catches the previously-missed real secret names', () => {
  // The old final-segment-noun regex let these through.
  for (const k of ['SUPABASE_KEY', 'ENCRYPTION_KEY', 'STRIPE_SECRET_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'DATABASE_URL', 'GH_TOKEN']) {
    assert.equal(isSecretKey(k), true, k);
  }
  // …without over-matching benign names.
  for (const k of ['KEYBOARD', 'TOKENIZER', 'MODEL', 'MONKEY', 'BASE_URL', 'PUBLIC_URL', 'PATH']) {
    assert.equal(isSecretKey(k), false, k);
  }
});

test('scrubEnv drops a value that is a credential-bearing URL even under a benign name', () => {
  const out = scrubEnv({ BASE_URL: 'https://api.example.com', SOME_URL: 'postgres://user:p4ss@host:5432/db' });
  assert.equal(out.BASE_URL, 'https://api.example.com', 'a plain URL is kept');
  assert.equal(out.SOME_URL, undefined, 'a URL with embedded user:password must be scrubbed');
});

test('bash child cannot read an inherited secret env var', async () => {
  process.env.LZ_TEST_API_KEY = 'SHHH-SECRET-123';
  process.env.LZ_TEST_PLAIN = 'keepme-456';
  try {
    const r = await bash.exec({ command: 'echo "secret=[$LZ_TEST_API_KEY]" "plain=[$LZ_TEST_PLAIN]"' }, {});
    assert.equal(r.ok, true);
    assert.ok(!r.stdout.includes('SHHH-SECRET-123'), 'secret must not reach the child env');
    assert.match(r.stdout, /secret=\[\]/, 'secret var should be empty in the child');
    assert.ok(r.stdout.includes('keepme-456'), 'non-secret operational var should pass through');
  } finally {
    delete process.env.LZ_TEST_API_KEY;
    delete process.env.LZ_TEST_PLAIN;
  }
});
