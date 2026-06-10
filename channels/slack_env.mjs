// channels/slack_env.mjs — Slack env reading + validation, split out of
// slack.mjs (file-size ratchet) so the adapter file has room for the
// socket-mode transport. Re-exported from slack.mjs for compatibility.

const DEFAULT_API_BASE = 'https://slack.com/api';

export class SlackError extends Error {
  constructor(message, code, missing) {
    super(message);
    this.name = 'SlackError';
    this.code = code || 'SLACK_ERR';
    if (Array.isArray(missing)) this.missing = missing;
  }
}

export function readSlackEnv(env = process.env) {
  const out = {
    botToken: env.SLACK_BOT_TOKEN || null,
    appToken: env.SLACK_APP_TOKEN || null,
    signingSecret: env.SLACK_SIGNING_SECRET || null,
    apiBase: env.SLACK_API_BASE || DEFAULT_API_BASE,
  };
  return out;
}

export function validateEnv(env, { requireInbound = false } = {}) {
  const missing = [];
  if (!env.botToken) missing.push('SLACK_BOT_TOKEN');
  else if (!env.botToken.startsWith('xoxb-')) {
    throw new SlackError('SLACK_BOT_TOKEN must start with "xoxb-"', 'SLACK_BAD_TOKEN', ['SLACK_BOT_TOKEN']);
  }
  if (requireInbound) {
    // Socket Mode (the inbound path) authenticates the WebSocket with the
    // app-level token; SLACK_SIGNING_SECRET is only needed for the HTTP Events
    // API (request-signature verification), which this adapter does not use, so
    // it is NOT required here — requiring it blocked socket-mode setups.
    if (!env.appToken) missing.push('SLACK_APP_TOKEN');
    else if (!env.appToken.startsWith('xapp-')) {
      throw new SlackError('SLACK_APP_TOKEN must start with "xapp-"', 'SLACK_BAD_TOKEN', ['SLACK_APP_TOKEN']);
    }
  }
  if (missing.length) {
    throw new SlackError(`missing Slack env vars: ${missing.join(', ')}`, 'SLACK_MISSING_ENV', missing);
  }
}
