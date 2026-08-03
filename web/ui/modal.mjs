// web/ui/modal.mjs — one shared modal layer; only one open at a time.
import { clear } from './dom.mjs';

let returnFocusTo = null;

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
