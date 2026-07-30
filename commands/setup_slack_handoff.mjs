// commands/setup_slack_handoff.mjs — the last mile of `/setup`'s Slack step.
//
// Setup used to verify the bot token and stop, which left the user with
// credentials on disk, an EMPTY pairing allowlist, no gateway running, and no
// idea what to do next. An empty allowlist is not a nag: the gateway answers
// whoever can reach the channel, and it logs a warning saying so.
//
// This module closes that gap in three steps, each declinable:
//   1. pair the operator, defaulting to the identity Slack's auth.test already
//      returned so nobody has to go dig their own member ID out of the app;
//   2. start the gateway on its resolved port, offering an alternate when that
//      port is taken (a stale dashboard holding 19600 is how this surfaced);
//   3. have the bot post one short confirmation, so success is visible in Slack
//      rather than asserted by the wizard.
//
// Everything with a side effect — spawning, probing a port, posting to Slack,
// writing config — arrives through `deps` so this is testable without binding a
// port, spawning a gateway, or calling Slack.
//
// NOTHING here may print or post a secret. buildAnnounce takes only non-secret
// facts by construction, and tests assert the posted text carries no token.

import { pairingAdd } from '../config_features.mjs';
import { resolvePort } from '../lib/ports.mjs';

// Kept deliberately short: this lands in a chat channel, not a terminal.
export function buildAnnounce({ provider, model, paired }) {
  const who = `${provider || 'the configured provider'}${model ? ` · ${model}` : ''}`;
  return [
    '✅ lazyclaw is connected.',
    `Running ${who}.`,
    'Message me here and I answer in-thread.',
    paired ? '' : '⚠️ No paired senders — anyone who can message me gets an answer.',
  ].filter(Boolean).join('\n');
}

async function _pairOperator({ cfg, identity, io, deps }) {
  const suggested = identity && identity.userId;
  if (!suggested) {
    io.write('  Slack did not return a member id, so there is nobody to pair automatically.\n');
    return false;
  }
  const label = [identity.user, identity.team].filter(Boolean).join('@');
  const yes = await io.confirm(`  Pair you (${suggested}${label ? ` — ${label}` : ''}) so only you can drive the agent?`);
  if (!yes) {
    io.write('  Not paired. Anyone who can message the bot will get an answer from it.\n');
    io.write('  Add yourself later with: lazyclaw pairing add <your-slack-id>\n');
    return false;
  }
  try {
    pairingAdd(cfg, suggested, label);
    if (deps.writeConfig) deps.writeConfig(cfg);
    io.write(`  ✓ paired ${suggested}\n`);
    return true;
  } catch (e) {
    // Already paired is a success from the user's point of view.
    io.write(`  pairing: ${e?.message || e}\n`);
    return /already paired/.test(String(e?.message || ''));
  }
}

async function _startGateway({ cfg, io, deps }) {
  const yes = await io.confirm('  Start the gateway now so the bot is live?');
  if (!yes) {
    io.write('  Not started. Run it later with: lazyclaw gateway   (or /gateway start)\n');
    return null;
  }
  let port = resolvePort('gateway', {}, cfg);
  if (await deps.isPortListening(port)) {
    io.write(`  Port ${port} is already in use by something else.\n`);
    const answer = (await io.prompt(`  Another port for the gateway [Enter to try ${port} anyway]: `) || '').trim();
    if (answer) {
      const n = Number.parseInt(answer, 10);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        io.write(`  "${answer}" is not a port between 1024 and 65535 — keeping ${port}.\n`);
      } else {
        port = n;
        cfg.gateway = cfg.gateway && typeof cfg.gateway === 'object' ? cfg.gateway : {};
        cfg.gateway.port = port;
        if (deps.writeConfig) deps.writeConfig(cfg);
        io.write(`  ✓ gateway port set to ${port}\n`);
      }
    }
  }
  const res = await deps.spawnGateway({ port });
  if (!res || !res.ok) {
    io.write(`  Gateway did not start: ${(res && res.reason) || 'unknown reason'}\n`);
    io.write('  Run `lazyclaw gateway` in a terminal to see the full output.\n');
    return null;
  }
  io.write(`  ✓ gateway running (pid ${res.pid}) on port ${res.port ?? port}\n`);
  return res;
}

async function _announce({ cfg, identity, io, deps, paired }) {
  const dmDefault = paired && identity && identity.userId ? identity.userId : '';
  const hint = dmDefault ? ` [Enter for your DM, ${dmDefault}]` : ' [Enter to skip]';
  const dest = ((await io.prompt(`  Where should the bot post its "I'm connected" message?${hint}: `)) || '').trim()
    || dmDefault;
  if (!dest) {
    io.write('  Skipped the confirmation message.\n');
    return;
  }
  const text = buildAnnounce({ provider: cfg.provider, model: cfg.model, paired });
  try {
    await deps.sendMessage(dest, text);
    io.write(`  ✓ posted a confirmation to ${dest}\n`);
  } catch (e) {
    // A wrong channel id must not cost the user the whole wizard run.
    io.write(`  Could not post to ${dest}: ${e?.message || e}\n`);
    io.write('  The gateway is unaffected — fix the destination and message the bot directly.\n');
  }
}

/**
 * Run the pair → start → announce hand-off. Never throws: every failure is
 * reported through `io` and setup continues.
 *
 * @param {object}   a
 * @param {object}   a.cfg       live config object (mutated, then written via deps.writeConfig)
 * @param {object}   a.identity  { userId, teamId, user, team } from verifyChannel
 * @param {object}   a.io        { write, confirm, prompt }
 * @param {object}   a.deps      { spawnGateway, isPortListening, sendMessage, writeConfig }
 * @returns {Promise<{ok: true, paired: boolean, started: boolean}>}
 */
export async function finishSlackSetup({ cfg, identity, io, deps }) {
  const paired = await _pairOperator({ cfg, identity, io, deps });
  const started = await _startGateway({ cfg, io, deps });
  if (started) await _announce({ cfg, identity, io, deps, paired });
  return { ok: true, paired, started: !!started };
}
