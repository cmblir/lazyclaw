// daemon/routes/slash.mjs — the dashboard's single write path.
//
// Everything the dashboard changes goes through here, so the CLI and the
// browser cannot drift: both run the same dispatcher over the same commands.
import { readJson, writeJson } from './_deps.mjs';
import { makeSlashRunner, listCommands } from '../lib/slash_http.mjs';
import { makeConfirmStore } from '../lib/confirm_tokens.mjs';

// One store per daemon process: a token issued by one request is redeemed by
// the next, so it cannot live inside a handler call.
const confirmStore = makeConfirmStore();

export async function slashRun(c) {
  const { req, res, gwConfigDir } = c;
  let body;
  try { body = await readJson(req); }
  catch (e) { return writeJson(res, 400, { ok: false, error: e?.message || String(e), code: 'SLASH_ERR' }); }

  const runner = makeSlashRunner({ cfgDir: gwConfigDir, confirmStore });
  const out = await runner.run({ line: body?.line, confirm: body?.confirm });
  // Every envelope the adapter can return is forwarded unchanged; only the
  // status code is decided here. CONFIRM_REQUIRED -> 409: the request
  // conflicts with a policy the client can resolve and retry, which is
  // exactly what a confirmation is. Any other failure code (SLASH_ERR,
  // NO_SESSION, NEEDS_TERMINAL, CONFIG_DIR_MISMATCH, PERSIST_FAILED, or a
  // future code this route doesn't know about yet) -> 400, so a client can
  // still branch on `body.code` without this route inventing a status per
  // code or swallowing one it doesn't recognise. ok:true -> 200.
  const status = out.ok ? 200 : (out.code === 'CONFIRM_REQUIRED' ? 409 : 400);
  return writeJson(res, status, out);
}

export async function slashCommands(c) {
  return writeJson(c.res, 200, listCommands());
}
