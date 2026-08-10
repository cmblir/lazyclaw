// web/ui/confirm_dialog.mjs — the two-step destructive flow, in one place.
//
// Panels call runSlashConfirmed, never runSlash, so no panel can forget the
// confirmation. The prompt shown is the server's, which names the actual blast
// radius ("Remove team crew? Its members stay, the team does not.") rather than
// a generic "are you sure?".
import { el } from './dom.mjs';
import { openModal, closeModal } from './modal.mjs';
import { runSlash } from './slash_client.mjs';

/**
 * Default asker: a modal with Cancel focused, Confirm styled as the
 * dangerous action. Resolves true only if Confirm is clicked.
 *
 * modal.mjs's initModal() wires three OTHER ways to dismiss the modal — the
 * × button, clicking the scrim, and Escape — and all three call closeModal()
 * directly, bypassing whatever button the caller put in the footer. Without
 * watching for that, this promise would simply hang forever on any of those
 * paths. A MutationObserver on the scrim's `data-open` attribute (the same
 * flag those three paths clear) catches every dismissal path uniformly, so
 * "anything but Confirm" resolves false instead of leaving the caller stuck.
 */
function askInModal(prompt) {
  return new Promise((resolve) => {
    let settled = false;
    const scrim = document.getElementById('modal-scrim');
    const observer = new MutationObserver(() => {
      if (!scrim.hasAttribute('data-open')) decide(false);
    });
    function decide(approved) {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(approved);
    }
    // data-action is a test hook only (no behaviour change) — Playwright has
    // no other stable way to tell these two buttons apart from outside.
    const cancel = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel', 'data-action': 'cancel',
      onclick: () => { closeModal(); decide(false); } });
    const go = el('button', { class: 'btn btn-danger', type: 'button', text: 'Confirm', 'data-action': 'confirm',
      onclick: () => { closeModal(); decide(true); } });
    // openModal takes an object, not positional args: {title, body, foot}.
    openModal({ title: 'Confirm', body: el('p', { text: prompt }), foot: [cancel, go] });
    observer.observe(scrim, { attributes: true, attributeFilter: ['data-open'] });
    // Destructive default: the focused control is the safe one, so a stray
    // Enter key press declines rather than confirms.
    cancel.focus();
  });
}

/**
 * Run a slash line, handling a CONFIRM_REQUIRED answer by asking once.
 *
 * A decline returns {ok:false, code:'CANCELLED'} — distinct from every real
 * failure code the server can send, so a caller checking `out.ok` can never
 * read a cancellation as success, and one checking `out.code` can tell "the
 * user said no" apart from "the server rejected it" (SLASH_ERR etc).
 *
 * Any other envelope — including one with neither `ok` nor `code` (a 401 is
 * `{error:'unauthorized'}`) — is passed through exactly as runSlash returned
 * it: this function only ever branches on `code === 'CONFIRM_REQUIRED'`, so
 * it never has to guess what a missing `ok` means.
 *
 * @param {string} line
 * @param {{confirm?: (prompt: string) => Promise<boolean>}} [opts]
 * @returns {Promise<object>} the final envelope, or {ok:false, code:'CANCELLED'}
 */
export async function runSlashConfirmed(line, { confirm = askInModal } = {}) {
  const first = await runSlash(line);
  if (first.code !== 'CONFIRM_REQUIRED') return first;
  const approved = await confirm(first.prompt);
  if (!approved) return { ok: false, code: 'CANCELLED', error: 'cancelled' };
  // Exactly one retry: a second CONFIRM_REQUIRED means the token was rejected
  // (or something is issuing tokens that don't redeem), and asking again
  // would loop instead of surfacing the problem.
  return runSlash(line, { confirm: first.token });
}
