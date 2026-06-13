import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSplashTip, renderSplashToString } from '../tui/splash.mjs';

// The splash tip used to hardcode a Claude-Pro/Max "$0 learning" pitch for
// EVERY provider, so an openai/gemini/ollama user saw an irrelevant
// Claude-subscription line. The tip must be provider-aware.

const CLAUDE_PITCH_RE = /Pro|Max|\$0/;

test('claude-cli provider gets the Pro/Max $0 trainer pitch', () => {
  const tip = pickSplashTip({ provider: 'claude-cli', trainer: {} });
  assert.match(tip, /Claude Pro/);
  assert.match(tip, /\$0/);
});

test('claude-cli trainer (mixed chat provider) still gets the $0 pitch', () => {
  // The pitch is about the learning-loop trainer, so the trainer provider wins.
  const tip = pickSplashTip({ provider: 'openai', trainer: { provider: 'claude-cli' } });
  assert.match(tip, /\$0/);
});

for (const provider of ['openai', 'gemini', 'ollama']) {
  test(`${provider} provider does NOT see the Claude Pro/Max $0 pitch`, () => {
    const tip = pickSplashTip({ provider, trainer: {} });
    assert.doesNotMatch(tip, CLAUDE_PITCH_RE);
    assert.match(tip, /\/help/); // neutral, relevant tip
  });
}

// End-to-end: the rendered splash must not leak the Claude pitch for a
// non-Claude provider (pins the pre-fix bug: pitch showed for every provider).
test('rendered WIDE splash for openai omits the Claude $0 pitch', () => {
  const out = renderSplashToString(
    { provider: 'openai', model: 'gpt-4o', trainer: {}, version: '1.0.0', tools: [], skills: [] },
    { columns: 140 },
  );
  assert.doesNotMatch(out, /Claude Pro subscription at \$0/);
});

test('rendered WIDE splash for claude-cli keeps the $0 pitch', () => {
  const out = renderSplashToString(
    { provider: 'claude-cli', model: 'sonnet-4.7', trainer: {}, version: '1.0.0', tools: [], skills: [] },
    { columns: 140 },
  );
  assert.match(out, /\$0/);
});
