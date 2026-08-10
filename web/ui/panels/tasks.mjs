// web/ui/panels/tasks.mjs — task list with issue/mark-done/abandon actions.
// Writes go through the slash dispatcher (runSlashConfirmed +
// slash_actions.mjs), same grammar a user would type in the REPL — not a
// typed REST call.
import { el, phead, chip, banner, clear, kvlist } from '../dom.mjs';
import { api, apiRaw } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';
import { reconcile } from '../reconcile.mjs';
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { taskIssue, taskAbandon, taskDone } from '../slash_actions.mjs';

// Same columns table() would have used — kept here so the header can be
// built once, up front, instead of every load().
const COLS = ['id', 'title', 'team', 'lead', 'origin', 'permission', 'status', 'turns', 'opened', ''];

// `class: 'status status-' + t.status` used to render here — no CSS rule
// ever matched either class, so a task's status has been unstyled text
// since Task 7 flagged it. chip() is the repo's styled status primitive, and
// status is never colour-alone: every tone below still shows the word.
const STATUS_TONE = { pending: '', running: 'live', paused: 'warn', done: 'ok', failed: 'err', abandoned: 'warn' };

function statusChip(status) {
  return chip(status, STATUS_TONE[status] ?? '');
}

// Where a task came from. A channel-originated task carries the channel and
// the thread timestamp, so the row can point back at the conversation.
function originChip(t) {
  if (!t.slackChannel) return chip('started in the CLI', '');
  return el('span', { class: 'chip is-live', title: 'slackThreadTs ' + (t.slackThreadTs || '—') },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: '⇄' }),
    t.slackChannel);
}

// The permission posture the task actually ran with, three states:
//   - attended (a human started it): ok, whatever mode is configured.
//   - unattended but still read-only (the fail-closed gate held, mode
//     "plan"): neutral. This is the SAFE outcome, not a warning — flagging
//     it would train the operator to ignore the strip color entirely.
//   - unattended AND allowed to write/exec (the operator opted into
//     security.unattendedExec): err. This is the one case that deserves
//     attention — an inbound, untrusted message running with host access —
//     and fix round 1 caught that the code below used to score it "ok".
function permissionChip(t) {
  if (t.attended) return chip(t.permissionMode, 'ok');
  if (t.permissionMode === 'plan') return chip('read-only · ' + t.permissionMode, '');
  return chip('unattended · ' + t.permissionMode, 'err');
}

// True only for the dangerous combination this feature exists to surface: no
// human in the loop AND the task was allowed to write files / run host
// commands anyway. Shared by the panel banner and the transcript modal so
// both fire on the exact same condition.
function isUnattendedWithExec(t) {
  return !t.attended && t.permissionMode !== 'plan';
}

function turnsText(t) {
  return String(Array.isArray(t.turns) ? t.turns.length : 0);
}

// GET /tasks/:id/transcript has always existed; nothing in the UI ever
// called it. Exported so Recall (web/ui/panels/recall.mjs) can open the same
// modal for a `task:` search hit.
export async function transcriptModal(t) {
  // The transcript route's default format is plain text (see
  // daemon/routes/registry.mjs taskTranscript), not JSON — apiSoft() always
  // tries r.json() and swallows a parse failure to null, so it can never
  // return this body as a string. Fetch it the same way sessions.mjs /
  // skills.mjs read a text endpoint: apiRaw() + r.text().
  const r = await apiRaw(`/tasks/${encodeURIComponent(t.id)}/transcript`);
  const status = r.status;
  const text = await r.text().catch(() => '');
  openModal({
    title: t.id + ' — transcript',
    // `.frow`/`.val`/a `.raw` pre class and a `.ghost` button appear nowhere
    // in dashboard.css or any other panel — kvlist() (dom.mjs), a bare <pre>
    // (styled globally, see sessions.mjs's own export modal), and
    // `btn btn-secondary` (every other panel's modal Close/Cancel button)
    // are this repo's real, styled equivalents.
    body: [
      kvlist([['Origin', t.slackChannel
        ? `${t.slackChannel} · thread ${t.slackThreadTs || '—'}`
        : 'pompos task start · no channel', true]]),
      // Three states here too, matching permissionChip. The modal is where an
      // operator inspects one task, so the safe unattended case is worth stating
      // rather than leaving blank — silence reads as "nothing to know", and
      // "ran with no human watching, and could not write anything" is something
      // to know. Only the execution-enabled case escalates to err.
      isUnattendedWithExec(t)
        ? banner('err', '✗', el('b', { text: 'Ran unattended with execution enabled. ' }),
            `permission mode "${t.permissionMode}" — no human was watching this channel task, and it could write files or run host commands.`)
        : t.attended ? null
          : banner('', '○', el('b', { text: 'Ran unattended, read-only. ' }),
              `No human was watching this channel task, so the surface failed closed to permission mode "${t.permissionMode}" — it could not write files or run commands.`),
      status === 200
        ? el('pre', { text })
        : banner('err', '✗', 'Could not load the transcript (HTTP ' + status + ').'),
      el('div', { class: 'note-inline' }, el('b', { text: 'Also searchable. ' }),
        'Every turn is mirrored into the search index as ',
        el('code', { text: 'session_id = task:' + t.id }), ', so Recall finds it by content.'),
    ],
    foot: [el('button', { class: 'btn btn-secondary', type: 'button', text: 'Close', onclick: closeModal })],
  });
}

export async function render(host) {
  host.append(phead('Tasks', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ Issue task', onclick: () => openIssueModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() })));

  // Cleared on every load() and every write attempt; holds the one error
  // banner for whichever write just failed (never for a cancellation). Kept
  // separate from postureBanner below, which reflects the fetched data, not
  // the outcome of the last write.
  const errorBox = el('div', {});
  host.append(errorBox);

  // Cleared and re-populated by load(): a banner appears only while at least
  // one listed task ran unattended AND allowed to write/exec (see
  // isUnattendedWithExec above and withPosture in
  // daemon/routes/registry.mjs), and disappears again once it doesn't. A
  // task that ran unattended but stayed read-only is the safe outcome and
  // does not trigger this.
  const postureBanner = el('div', {});
  host.append(postureBanner);

  // Shared by issue/mark-done/abandon — see agents.mjs's runWrite for the
  // full rationale (truthy `out.ok` check, CANCELLED is silent, hint
  // appended). `out.ok` is checked for truthiness, not `=== true`: a 401
  // body is {error:'unauthorized'} with no `ok` field at all.
  //
  // Takes a thunk, not an already-composed line, so a composer throw (e.g.
  // taskIssue's title containing an unrepresentable `"`) lands inside this
  // function and shows as a failure, instead of throwing before runWrite
  // ever starts and becoming a silent unhandled rejection.
  async function runWrite(compose) {
    errorBox.replaceChildren();
    let line;
    try {
      line = compose();
    } catch (e) {
      errorBox.replaceChildren(banner('err', '✗', e.message || String(e)));
      return;
    }
    const out = await runSlashConfirmed(line);
    if (out.ok) { load(); return; }
    if (out.code === 'CANCELLED') return;
    const msg = out.hint ? `${out.error || 'failed'} — ${out.hint}` : (out.error || 'failed');
    errorBox.replaceChildren(banner('err', '✗', msg));
  }

  async function openIssueModal() {
    // Guide the flow the same way teams.mjs does for its own create modal:
    // list registered teams so the operator picks a real one instead of
    // guessing a name /task start would then reject.
    let teams = [];
    try { teams = (await api('/teams')).map((t) => t.name); } catch { /* fall through with empty list */ }
    if (teams.length === 0) {
      alert('Create a team first (Teams tab → + New team). A task needs a team to run it.');
      return;
    }
    const team = (prompt(`Team (one of ${teams.join(', ')}):`, teams[0]) || '').trim();
    if (!team) return;
    const title = (prompt('Task title:') || '').trim();
    if (!title) return;
    await runWrite(() => taskIssue({ team, title }));
  }

  // The table shell is built once; only its rows are reconciled per load(),
  // so an in-place status change no longer discards every other row's node.
  const tbody = el('tbody', {});
  const tableWrap = el('div', { class: 'scroll' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, COLS.map((c) => el('th', { text: c })))), tbody));

  let shown = el('div', { class: 'empty', text: 'Loading…' });
  host.append(shown);
  function show(node) { shown.replaceWith(shown = node); }

  // Transcript is always available — even (especially) for a finished task —
  // so it is unconditional; Mark done / Abandon only apply to open statuses.
  function actionsFor(t) {
    const kids = [el('button', { class: 'btn btn-secondary', type: 'button', text: 'Transcript', onclick: () => transcriptModal(t) })];
    if (t.status === 'running' || t.status === 'pending' || t.status === 'paused') {
      kids.push(
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Mark done', onclick: () => runWrite(() => taskDone(t.id)) }),
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Abandon', onclick: () => runWrite(() => taskAbandon(t.id)) }));
    }
    return el('div', {}, kids);
  }

  function createRow(t) {
    return el('tr', { '--i': t.i },
      el('td', {}, el('code', { text: t.id })),
      el('td', {}, t.title),
      el('td', {}, t.team),
      el('td', {}, t.lead),
      el('td', {}, originChip(t)),
      el('td', { 'data-f': 'permission' }, permissionChip(t)),
      el('td', { 'data-f': 'status' }, statusChip(t.status)),
      el('td', { 'data-f': 'turns', text: turnsText(t) }),
      el('td', {}, el('span', { class: 'dim', text: (t.createdAt || '').slice(0, 19) })),
      el('td', { 'data-f': 'actions' }, actionsFor(t)));
  }

  // Only the fields that can actually change after a task is opened: its
  // permission posture (the operator can flip security.unattendedExec
  // between loads), status, turn count, and the actions available for that
  // status. slackChannel/slackThreadTs (origin) never change once set.
  function updateRow(tr, t) {
    tr.querySelector('[data-f="permission"]').replaceChildren(permissionChip(t));
    tr.querySelector('[data-f="status"]').replaceChildren(statusChip(t.status));
    tr.querySelector('[data-f="turns"]').textContent = turnsText(t);
    tr.querySelector('[data-f="actions"]').replaceChildren(actionsFor(t));
  }

  async function load() {
    try {
      const arr = await api('/tasks');
      clear(postureBanner);
      if (arr.length === 0) {
        show(el('div', { class: 'empty' }, 'No tasks yet. Click + Issue task above, or run /task start in the REPL.'));
        return;
      }
      if (arr.some(isUnattendedWithExec)) {
        postureBanner.append(banner('err', '✗', el('b', { text: 'A channel task is running unattended with execution enabled. ' }),
          'An inbound surface has no human watching it — confirm ',
          el('code', { text: 'security.unattendedExec = true' }), ' is intentional for this task.'));
      }
      if (shown !== tableWrap) show(tableWrap);
      reconcile(tbody, arr.map((t, i) => ({ ...t, i })), (t) => t.id, createRow, updateRow);
    } catch (e) {
      show(el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  await load();
}
