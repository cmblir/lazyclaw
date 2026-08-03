// tests/f-dashboard-dom.test.mjs — el() is the workhorse of every panel; a
// regression here breaks all 21 at once. Tested against a tiny DOM stub so it
// stays a node --test unit, no browser and no jsdom dependency.
import test from 'node:test';
import assert from 'node:assert/strict';

function stubDocument() {
  const mk = (tag) => ({
    tag, className: '', textContent: '', attrs: {}, kids: [], listeners: {},
    style: { cssText: '', _props: {}, setProperty(k, v) { this._props[k] = v; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(...xs) { this.kids.push(...xs); },
  });
  return { createElement: mk, createTextNode: (t) => ({ text: String(t) }) };
}

test('el() maps props onto the element and flattens children', async () => {
  globalThis.document = stubDocument();
  const { el } = await import('../web/ui/dom.mjs');

  const n = el('div', { class: 'card', 'data-id': 'x', '--i': 3, text: 'hi' });
  assert.equal(n.tag, 'div');
  assert.equal(n.className, 'card');
  assert.equal(n.attrs['data-id'], 'x');
  assert.equal(n.style._props['--i'], 3);
  assert.equal(n.textContent, 'hi');

  const parent = el('ul', {}, [el('li', {}), el('li', {})], null, false, undefined, 'tail');
  assert.equal(parent.kids.length, 3, 'nested arrays flatten; null/false/undefined are dropped');
});

test('el() drops null and false attribute values but keeps 0', async () => {
  globalThis.document = stubDocument();
  const { el } = await import('../web/ui/dom.mjs');
  const n = el('div', { hidden: null, disabled: false, tabindex: 0, checked: true });
  assert.equal('hidden' in n.attrs, false);
  assert.equal('disabled' in n.attrs, false);
  assert.equal(n.attrs.tabindex, 0);
  assert.equal(n.attrs.checked, '', 'true becomes a bare attribute');
});
