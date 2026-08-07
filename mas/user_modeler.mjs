// User modeler — Phase B (v5 §4.10, §9.2, §0.1 C6).
//
// Honcho-equivalent. At session end, take the session's turns and ask
// the trainer to produce a dialectic update for ~/.pompos/memory/USER.md:
//
//   ## Thesis      — durable facts the user just confirmed
//   ## Antithesis  — contradictions to prior model (if any)
//   ## Synthesis   — the reconciled, persisted summary
//
// The synthesis block is also fed to mas/index_db.mjs as a row of
// fts_memories with kind='user_model' so recall() can pull user facts
// at prompt assembly time.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runTextCompletion } from './provider_adapters.mjs';
import { redactSecrets, neutralizeRoleLabels } from './redact.mjs';

const USER_MD_REL = path.join('memory', 'USER.md');
const MAX_TRANSCRIPT_CHARS = 16 * 1024;
const MAX_USER_MD_BYTES = 32 * 1024;

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.pompos');
}

export function userModelPath(configDir = defaultConfigDir()) {
  return path.join(configDir, USER_MD_REL);
}

export function readUserModel(configDir = defaultConfigDir()) {
  const p = userModelPath(configDir);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function flattenTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return '';
  const text = turns
    .map((t) => {
      const who = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : (t.role || 'unknown');
      return `[${who}] ${neutralizeRoleLabels(String(t.content || ''))}`;
    })
    .join('\n\n');
  return redactSecrets(text).slice(0, MAX_TRANSCRIPT_CHARS);
}

export async function updateUserModel({
  sessionTurns,
  provider,
  model,
  apiKey,
  baseUrl,
  fetchImpl,
  configDir = defaultConfigDir(),
  ts = new Date(),
} = {}) {
  const transcript = flattenTurns(sessionTurns);
  if (!transcript.trim()) return null;

  const prior = readUserModel(configDir).slice(-8 * 1024);
  const userMessage =
    `Below is a recent session transcript and the current USER model. ` +
    `Update the model using a dialectic structure. Reply in EXACTLY this format:\n\n` +
    `## Thesis\n<bullets of new durable facts about the user>\n\n` +
    `## Antithesis\n<bullets of contradictions with the prior model, if any; "(none)" if none>\n\n` +
    `## Synthesis\n<the reconciled model, ≤ 20 bullets, suitable for permanent storage>\n\n` +
    `Prior USER model (may be empty):\n\n` + (prior || '(empty)') + `\n\n` +
    `Session transcript:\n\n` + transcript;

  let raw;
  try {
    raw = await runTextCompletion({
      provider, model, system: 'You maintain a durable user model.',
      userMessage, apiKey, baseUrl, fetchImpl,
    });
  } catch (err) {
    return { path: userModelPath(configDir), error: String(err?.message || err) };
  }
  const cleaned = redactSecrets(String(raw || '')).trim();
  if (!cleaned || !/##\s*Synthesis/i.test(cleaned)) return null;

  const date = (ts instanceof Date ? ts : new Date(ts)).toISOString().slice(0, 10);
  const header = `# USER\n\n_Last updated ${date}_\n\n`;
  let body = header + cleaned + '\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_USER_MD_BYTES) {
    body = Buffer.from(body, 'utf8').subarray(0, MAX_USER_MD_BYTES).toString('utf8') + '\n…[truncated]\n';
  }

  const p = userModelPath(configDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, p);

  // Best-effort FTS5 mirror — only the Synthesis section is indexed.
  try {
    const synth = (cleaned.match(/##\s*Synthesis\s*\n([\s\S]*?)(?=\n##\s|$)/i) || [, ''])[1].trim();
    if (synth) {
      const idx = await import('./index_db.mjs');
      idx.openIndex(configDir);
      idx.indexMemory({ topic: 'USER', kind: 'user_model', content: synth }, configDir);
    }
  } catch { /* non-fatal */ }

  return { path: p, body };
}
