// tests/f-config-slash-splash.test.mjs — the /config slash (re-run setup from
// chat) and the shared splash props that make the setup wizard render the same
// lazyclaw splash the chat REPL does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { gatherToolAndSkillGroups, splashPropsForSetup, renderSplashToString } from '../tui/splash_props.mjs';
import { legacySlashRoute } from '../commands/chat.mjs';

test('/config signals the host (ctx.requestSetup) and unmounts (EXIT)', async () => {
  const ctx = {};
  const r = await dispatchSlash('/config', '', ctx, () => {});
  assert.equal(r, 'EXIT', '/config must return the EXIT sentinel so the REPL unmounts');
  assert.equal(ctx.requestSetup, true, '/config must set ctx.requestSetup so chat.mjs runs the wizard');
});

test('/config is registered in the slash catalog', () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.cmd === '/config'), '/config must appear in SLASH_COMMANDS');
});

// ── Legacy (non-Ink) readline path ──────────────────────────────────────
// Regression: the legacy handleSlash switch had no /config case, so /config
// fell through to `default:` ("unknown slash") and never set requestSetup —
// making the post-loop `if (_legacyCtx.requestSetup) ... cmdSetup(...)` guard
// dead code on any terminal that takes the legacy path (<60 cols, non-TTY,
// LAZYCLAW_NO_INK=1, or any Ink failure). The legacy switch's /config case now
// delegates to legacySlashRoute, so driving that exported helper exercises the
// exact code the legacy path runs.
test('legacy path: /config sets ctx.requestSetup and returns EXIT (breaks the loop)', () => {
  const ctx = {};
  const r = legacySlashRoute('/config', ctx);
  assert.equal(r, 'EXIT', 'legacy /config must return EXIT so the readline for-await loop breaks (chat.mjs)');
  assert.equal(ctx.requestSetup, true, 'legacy /config must set ctx.requestSetup so the post-loop guard re-runs cmdSetup');
});

test('legacy path: legacySlashRoute leaves unowned commands to the caller (undefined)', () => {
  const ctx = {};
  // A command the helper does not own must return undefined (no EXIT, no
  // requestSetup) so the legacy switch keeps its existing per-command behavior.
  assert.equal(legacySlashRoute('/help', ctx), undefined, '/help is not owned by legacySlashRoute');
  assert.equal(ctx.requestSetup, undefined, 'unowned commands must not set requestSetup');
});

test('gatherToolAndSkillGroups returns tool + skill arrays (never throws)', async () => {
  const { tools, skills } = await gatherToolAndSkillGroups(process.cwd());
  assert.ok(Array.isArray(tools), 'tools is an array');
  assert.ok(Array.isArray(skills), 'skills is an array');
});

test('splashPropsForSetup builds props that render the real splash', async () => {
  const props = await splashPropsForSetup({ version: '9.9.9' });
  assert.equal(props.version, '9.9.9');
  assert.ok(Array.isArray(props.tools) && Array.isArray(props.skills));
  const out = renderSplashToString(props, { columns: 120 });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0, 'splash renders non-empty');
  assert.match(out, /9\.9\.9/, 'the version label appears in the wide splash');
});
