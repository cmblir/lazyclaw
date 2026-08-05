// workflow/state_path.mjs — where a workflow session's state file lives, and
// the one guard that keeps it inside the state directory.
//
// Split out of persistent.mjs rather than added to it: that file was already at
// 499 of the repo's 500-line ceiling with no headroom, and this is a
// self-contained rule with its own tests, so it earns its own module.

import path from 'node:path';
// WorkflowError carries a `code`, and daemon/routes/workflows.mjs turns any
// `WF_`-prefixed code into a 400 rather than a 500. declarative.mjs imports only
// executor.mjs and nodes.mjs, so importing it here adds no cycle.
import { WorkflowError } from './declarative.mjs';

export const DEFAULT_DIR = '.workflow-state';

/**
 * Resolve a session's state file, refusing any sessionId that would land
 * outside `dir`.
 *
 * The guard lives at this level because statePath is the one choke point every
 * workflow-state read and write goes through. `POST /workflows/run` takes
 * `body.sessionId` straight from a JSON request body — unlike the
 * `/workflows/:id` routes, whose id comes from a URL matcher that already
 * rejects `..` and `/` — so an unguarded `../../../../tmp/pwned` made saveState
 * write attacker-influenced JSON anywhere the daemon user could write. Reaching
 * that route needs the daemon token, but a token holder should not thereby gain
 * an arbitrary-file-write primitive.
 *
 * @param {string} sessionId
 * @param {string} [dir]
 * @returns {string} the state file path, guaranteed to be under `dir`
 * @throws {WorkflowError} WF_BAD_SESSION_ID when the path would escape `dir`
 */
export function statePath(sessionId, dir = DEFAULT_DIR) {
  const id = String(sessionId ?? '');
  // A NUL byte surfaces as a less legible error deeper in fs, and no valid
  // session id contains one.
  if (!id || id.includes('\0')) throw badSessionId(id);

  const file = path.join(dir, `${id}.json`);
  // path.resolve normalises `..` away, so comparing resolved forms catches
  // traversal however it was spelled. The separator is appended so a sibling
  // like `/state-evil` cannot pass as being inside `/state`.
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(file);
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) throw badSessionId(id);
  return file;
}

function badSessionId(id) {
  return new WorkflowError(`invalid sessionId: ${JSON.stringify(id.slice(0, 40))}`, 'WF_BAD_SESSION_ID');
}
