// web/ui/panels/config.mjs — flat config key/value store: list (with
// validation banner + raw JSON), set/edit modal, delete. Nested stores
// (customProviders, rates, authProfiles, authActiveProfile) are read-only
// here — they have their own tabs.
import { el, phead } from '../dom.mjs';
import { api, apiRaw, apiSoft } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';

const NESTED = new Set(['customProviders', 'rates', 'authProfiles', 'authActiveProfile']);

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Config', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ Set key', onclick: () => openConfigEditModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let validateBox = el('div', {});
  host.append(validateBox);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);
  const raw = el('pre', {});
  host.append(el('details', { style: 'margin-top:12px;' },
    el('summary', { class: 'dim', style: 'cursor:pointer;', text: 'Raw JSON' }), raw));

  async function load() {
    validateBox.replaceChildren();
    raw.textContent = '';
    try {
      const [cfg, validate] = await Promise.all([api('/config'), apiSoft('/config/validate')]);
      const keys = Object.keys(cfg);
      meta.textContent = `${keys.length} key${keys.length === 1 ? '' : 's'}`;
      if (validate.body) {
        const v = validate.body;
        if (v.ok && !(v.warnings || []).length) {
          validateBox.replaceChildren(el('div', { class: 'banner ok', text: 'Config valid.' }));
        } else {
          const items = [...(v.issues || []), ...(v.warnings || [])].map((i) => el('li', { text: typeof i === 'string' ? i : JSON.stringify(i) }));
          validateBox.replaceChildren(el('div', { class: 'banner ' + (v.ok ? 'warn' : 'err') },
            el('div', {}, el('strong', { text: v.ok ? 'Warnings' : 'Validation issues' }), el('ul', {}, items))));
        }
      }
      if (keys.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty' }, 'No config yet. Run ', el('code', { text: 'pompos onboard' }), '.'));
        return;
      }
      const rows = keys.sort().map((k) => {
        const v = cfg[k];
        const display = v && typeof v === 'object' ? JSON.stringify(v) : String(v);
        const nested = NESTED.has(k);
        return el('tr', {},
          el('td', {}, el('code', { text: k })),
          el('td', { text: display }),
          el('td', {}, nested
            ? el('span', { class: 'dim', style: 'font-size:11px;', text: 'use the dedicated tab' })
            : [
                el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Edit', onclick: () => openConfigEditModal(k, cfg[k]) }),
                el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: () => deleteConfigKey(k) }),
              ]));
      });
      list.replaceWith(list = el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, el('th', { style: 'width:25%', text: 'Key' }), el('th', { text: 'Value' }), el('th', { style: 'width:160px' }))),
        el('tbody', {}, rows)));
      raw.textContent = JSON.stringify(cfg, null, 2);
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  function openConfigEditModal(existingKey = '', existingValue = '') {
    // Stringify for the editor; objects/arrays become JSON, primitives stay
    // raw. Submitter parses JSON when the value looks like JSON, else sends
    // a string verbatim — same behaviour as `pompos config set`.
    let display = '';
    if (typeof existingValue === 'string') display = existingValue;
    else if (existingValue != null) display = JSON.stringify(existingValue, null, 2);
    const status = el('div', { class: 'dim', style: 'font-size:12px;' });
    const keyInput = el('input', { placeholder: 'provider · model · api-key · skills · …', value: existingKey, readonly: !!existingKey || null });
    const valueInput = el('textarea', { rows: 6, text: display });
    openModal({
      title: existingKey ? `Edit config — ${existingKey}` : 'Set config key',
      body: [
        el('div', { class: 'dim', style: 'margin-bottom:12px;font-size:12px;' },
          'Mirrors ', el('code', { text: 'pompos config set <key> <value>' }),
          '. Values that look like JSON (start with {, [, ", true, false, or a number) are parsed; ' +
          'everything else is stored as a plain string. Nested stores (customProviders, rates, authProfiles) ' +
          'have their own tabs — this form rejects them.'),
        el('div', { class: 'form-row' }, el('label', { text: 'Key' }), keyInput),
        el('div', { class: 'form-row' }, el('label', { text: 'Value' }), valueInput),
        status,
      ],
      foot: [
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel', onclick: () => closeModal() }),
        el('button', { class: 'btn', type: 'button', text: 'Save', onclick: () => submitConfigEdit(keyInput, valueInput, status) }),
      ],
    });
  }

  async function submitConfigEdit(keyInput, valueInput, status) {
    const key = keyInput.value.trim();
    const rawVal = valueInput.value;
    if (!key) { status.style.color = 'var(--err)'; status.textContent = 'Key is required.'; return; }
    let value;
    const trimmed = rawVal.trim();
    if (trimmed === '') value = '';
    else {
      try { value = JSON.parse(trimmed); }
      catch { value = rawVal; }
    }
    status.style.color = 'var(--dim)';
    status.textContent = 'Saving…';
    try {
      const r = await apiRaw('/config/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const body = await r.json();
      if (!r.ok) {
        status.style.color = 'var(--err)';
        const issues = (body.issues || []).map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ');
        status.textContent = `✗ ${body.error || issues || `${r.status} ${r.statusText}`}`;
        return;
      }
      status.style.color = 'var(--ok)';
      status.textContent = '✓ saved';
      setTimeout(() => { closeModal(); load(); }, 600);
    } catch (e) {
      status.style.color = 'var(--err)';
      status.textContent = '✗ ' + (e.message || String(e));
    }
  }

  async function deleteConfigKey(key) {
    if (!confirm(`Delete config key "${key}"?`)) return;
    try {
      const r = await apiRaw('/config/' + encodeURIComponent(key), { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `${r.status}`);
      }
      load();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  await load();
}
