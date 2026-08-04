// web/ui/modal.mjs — one shared modal layer; only one open at a time.
import { clear } from './dom.mjs';

let returnFocusTo = null;
let wired = false;

export function openModal({ title, body, foot }) {
  returnFocusTo = document.activeElement;
  document.getElementById('modal-title').textContent = title;
  clear(document.getElementById('modal-body')).append(...[body].flat().filter(Boolean));
  clear(document.getElementById('modal-foot')).append(...[foot].flat().filter(Boolean));
  document.getElementById('modal-scrim').setAttribute('data-open', '');
  const first = document.querySelector('#modal-body input, #modal-body select, #modal-body textarea, #modal-body button');
  if (first) first.focus();
}

export function closeModal() {
  document.getElementById('modal-scrim').removeAttribute('data-open');
  if (returnFocusTo && returnFocusTo.isConnected) returnFocusTo.focus();
  returnFocusTo = null;
}

// Wires the three ways to dismiss the modal that dashboard.html's old inline
// onclick= / global keydown handled before Task 3 deleted them along with
// the rest of dashboard.js: the × button, clicking the scrim itself (not a
// click that bubbled up from inside .modal), and Escape. The shell calls
// this once at startup — kept here (not in shell.mjs) because the modal
// owns its own dismissal behaviour, same as it owns open/close state.
//
// Escape is scoped to "modal is open" so it never fires when the modal is
// closed, and so shell.mjs's own Escape-closes-drawer handler can check the
// same attribute and skip itself when the modal is on top — Escape closes
// exactly one layer, whichever is topmost.
export function initModal() {
  if (wired) return;
  wired = true;
  const scrim = document.getElementById('modal-scrim');
  document.getElementById('modal-x').addEventListener('click', closeModal);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && scrim.hasAttribute('data-open')) closeModal();
  });
}
