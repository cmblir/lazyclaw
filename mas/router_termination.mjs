// Terminal-stop finalization for the mention router. Extracted from
// mention_router.mjs so a non-DONE exit (budget / abort / idle) lands the
// task on a terminal status AND posts a closing note to the thread, instead
// of leaving status 'running' forever (a perpetual run on the dashboard) and
// the thread silent. The DONE path flips status + posts a closing note; this
// mirrors that for the stranded exits. Lives in its own module to keep
// mention_router.mjs under its size ceiling.
//
// A non-DONE stop that wasn't an explicit abort (budget / idle / failed)
// also fires the post-failure learning trigger so a stranded team task
// teaches an anti-pattern skill. It's fire-and-forget (never awaited, never
// throws into the router) and degrades to a no-op when the caller hasn't
// threaded task/cfg through yet.

import { runLearning as defaultRunLearning } from './learning.mjs';

/**
 * Patch task status + post a stop note for a non-DONE terminal exit, and
 * fire post-failure learning for budget/idle/failed stops (not abort).
 * Returns the (possibly updated) task record. A 'done' stop is a no-op so
 * the caller can invoke this unconditionally.
 *
 * `task`, `cfg` and `runLearningImpl` are optional so mention_router.mjs
 * (not editable in this change) can keep its current call site; when
 * `task` is absent the learning trigger degrades to a no-op.
 *
 * @param {{ stoppedBy: string, iterations: number, current: any, configDir: string,
 *   tasksMod: { patchTask: Function }, postToThread: Function, slackSender: any,
 *   logger?: Function, task?: any, cfg?: any, runLearningImpl?: Function }} args
 */
export async function finalizeTerminalStop({ stoppedBy, iterations, current, configDir, tasksMod, postToThread, slackSender, logger, task, cfg, runLearningImpl }) {
  if (stoppedBy === 'done') return current;
  // Closest existing terminal vocabulary (tasks.mjs VALID_STATUSES): an
  // explicit abort maps to 'abandoned'; budget/idle didn't finish the work,
  // so 'failed'. No new status values are introduced.
  const terminalStatus = stoppedBy === 'abort' ? 'abandoned' : 'failed';
  const stopNote = stoppedBy === 'abort'
    ? ':octagonal_sign: task aborted.'
    : stoppedBy === 'budget'
      ? `:hourglass: stopped after ${iterations} turns (turn budget reached).`
      : ':warning: stopped — no agent had anything left to do.';
  const next = tasksMod.patchTask(current.id, { status: terminalStatus }, configDir);
  await postToThread({ task: next, agentRecord: null, text: stopNote, logger, sender: slackSender });

  // Fire-and-forget post-failure learning. Abort is a deliberate human
  // stop, not a failed attempt, so it never teaches an anti-pattern. We
  // only fire when a `task` was threaded through (degrade to no-op
  // otherwise) and never await/throw into the router.
  if (stoppedBy !== 'abort' && task) {
    const fire = typeof runLearningImpl === 'function' ? runLearningImpl : defaultRunLearning;
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => fire('post-failure', { task: task || next, configDir, cfg, agent: null }))
        .catch(() => { /* swallow — learning must never break a stop */ });
    });
  }
  return next;
}
