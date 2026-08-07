import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

async function loadSlack() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'channels', 'slack.mjs')).href;
  return await import(url) as typeof import('../channels/slack.mjs');
}

test.describe('Phase 19.1 — Slack inbound self-message filter', () => {
  test('legacy bot_message subtype is skipped (the pre-v4.2.0 happy path)', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    expect(shouldDispatchEvent({
      type: 'message', subtype: 'bot_message', text: 'hi from bot',
      channel: 'C1', ts: '1700.0', bot_id: 'B999',
    })).toBe(false);
  });

  test('legacy bot_id alone (no subtype) is also skipped', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    expect(shouldDispatchEvent({
      type: 'message', text: 'hi', channel: 'C1', ts: '1700.0', bot_id: 'B999',
    })).toBe(false);
  });

  test('chat:write.customize message that strips bot_id is caught by selfUserId', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    // This is the exact wire shape that v4.2.0 missed: no bot_id /
    // subtype, but the `user` field equals our cached auth.test user_id
    // because the bot's User identity still drives the customize post.
    const event = {
      type: 'message', text: 'agent reply', channel: 'C1', ts: '1700.1',
      user: 'U0SELF',
      username: 'Planner agent',
    };
    expect(shouldDispatchEvent(event, { selfUserId: 'U0SELF' })).toBe(false);
    // Same event without the cached self id — pre-fix behavior: the
    // event would have slipped through. That's what we patched.
    expect(shouldDispatchEvent(event, { selfUserId: null })).toBe(true);
  });

  test('selfBotId matches bot_id and bot_profile.id', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    expect(shouldDispatchEvent({
      type: 'message', text: 'x', channel: 'C1', ts: '1700.2',
      bot_id: 'B0SELF',
    }, { selfBotId: 'B0SELF' })).toBe(false);
    expect(shouldDispatchEvent({
      type: 'message', text: 'x', channel: 'C1', ts: '1700.3',
      bot_profile: { id: 'B0SELF', name: 'pompos' },
    }, { selfBotId: 'B0SELF' })).toBe(false);
  });

  test('empty / whitespace-only text is skipped (avoids the "(empty message)" loop)', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    expect(shouldDispatchEvent({ type: 'message', text: '', channel: 'C1', ts: '1700.4', user: 'U1' })).toBe(false);
    expect(shouldDispatchEvent({ type: 'message', text: '   \n\t', channel: 'C1', ts: '1700.5', user: 'U1' })).toBe(false);
  });

  test('non-message-shaped events are skipped', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    expect(shouldDispatchEvent({ type: 'reaction_added', channel: 'C1', ts: '1700.6' })).toBe(false);
    expect(shouldDispatchEvent({ type: 'team_join', user: 'U2' })).toBe(false);
    expect(shouldDispatchEvent(null)).toBe(false);
    expect(shouldDispatchEvent('not an object' as unknown as Record<string, unknown>)).toBe(false);
  });

  test('a real user message with normal text passes through', async () => {
    const { shouldDispatchEvent } = await loadSlack();
    expect(shouldDispatchEvent({
      type: 'message',
      text: 'hi @pompos',
      channel: 'C1',
      ts: '1700.7',
      user: 'U_human',
    }, { selfUserId: 'U0SELF', selfBotId: 'B0SELF' })).toBe(true);
    expect(shouldDispatchEvent({
      type: 'app_mention',
      text: '<@U0SELF> hello',
      channel: 'C1',
      ts: '1700.8',
      user: 'U_human',
    }, { selfUserId: 'U0SELF', selfBotId: 'B0SELF' })).toBe(true);
  });
});
