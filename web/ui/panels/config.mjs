// web/ui/panels/config.mjs — flat config key/value store: list (with
// validation banner + raw JSON), set/edit modal, delete. Nested stores
// (customProviders, rates, authProfiles, authActiveProfile) are read-only
// here — they have their own tabs. Writes go through the slash dispatcher
// (runSlashConfirmed + slash_actions.mjs), same grammar a user would type
// in the REPL — not a typed REST call.
import { el, phead, banner } from '../dom.mjs';
import { api, apiSoft } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { configSet, configUnset } from '../slash_actions.mjs';

const NESTED = new Set(['customProviders', 'rates', 'authProfiles', 'authActiveProfile']);

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Config', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ Set key', onclick: () => openConfigEditModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  // Cleared on every load() and every row-level write attempt (Delete); the
  // Set/Edit modal has its own inline `status` element instead, since it is
  // already open when its write runs.
  const errorBox = el('div', {});
  host.append(errorBox);
  let validateBox = el('div', {});
  host.append(validateBox);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);
  const raw = el('pre', {});
  host.append(el('details', { style: 'margin-top:12px;' },
    el('summary', { class: 'dim', style: 'cursor:pointer;', text: 'Raw JSON' }), raw));

  // Shared by the row-level Delete button — see agents.mjs's runWrite for
  // the full rationale (truthy `out.ok` check, CANCELLED is silent, hint
  // appended, and a thunk so a composer throw — e.g. a config key that
  // itself contains a `"` — lands inside this function instead of becoming
  // an unhandled rejection before it's ever called).
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

  async function load() {
    errorBox.replaceChildren();
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
        // data-config-key is a test hook only (no behaviour change).
        return el('tr', { 'data-config-key': k },
          el('td', {}, el('code', { text: k })),
          el('td', { text: display }),
          el('td', {}, nested
            ? el('span', { class: 'dim', style: 'font-size:11px;', text: 'use the dedicated tab' })
            : [
                el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Edit', onclick: () => openConfigEditModal(k, cfg[k]) }),
                el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: () => runWrite(() => configUnset(k)) }),
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
    // raw, for display only — see submitConfigEdit for what can actually be
    // saved through /config set.
    let display = '';
    if (typeof existingValue === 'string') display = existingValue;
    else if (existingValue != null) display = JSON.stringify(existingValue, null, 2);
    const status = el('div', { class: 'dim', style: 'font-size:12px;' });
    // name= on both inputs, and data-action on Save, are test hooks only (no
    // behaviour change) — neither existed before, and there is no other
    // stable way to address these two fields from outside the module.
    const keyInput = el('input', { name: 'config-key', placeholder: 'provider · model · api-key · skills · …', value: existingKey, readonly: !!existingKey || null });
    const valueInput = el('textarea', { name: 'config-value', rows: 6, text: display });
    openModal({
      title: existingKey ? `Edit config — ${existingKey}` : 'Set config key',
      body: [
        el('div', { class: 'dim', style: 'margin-bottom:12px;font-size:12px;' },
          'Mirrors ', el('code', { text: 'pompos config set <key> <value>' }),
          '. true, false, null and numbers are typed; everything else is stored as a plain string. ' +
          'Object/array values (e.g. a JSON array) cannot be set from here — edit config.json directly for those. ' +
          'Nested stores (customProviders, rates, authProfiles) have their own tabs — this form rejects them.'),
        el('div', { class: 'form-row' }, el('label', { text: 'Key' }), keyInput),
        el('div', { class: 'form-row' }, el('label', { text: 'Value' }), valueInput),
        status,
      ],
      foot: [
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel', onclick: () => closeModal() }),
        el('button', { class: 'btn', type: 'button', text: 'Save', 'data-action': 'config-set', onclick: () => submitConfigEdit(keyInput, valueInput, status) }),
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
    // tui/config_picker.mjs's coerce() — the real /config set's type
    // handling — only recognises true/false/null/number/string. An
    // object or array would silently be stored as a literal string instead
    // of the structured value the user typed, so this refuses rather than
    // corrupting it (the REST PUT this replaced could send arbitrary JSON;
    // /config set cannot — a real capability gap, not a UI restriction).
    if (value !== null && typeof value === 'object') {
      status.style.color = 'var(--err)';
      status.textContent = '✗ object/array values are not supported by /config set — edit config.json directly for this key.';
      return;
    }
    const valueStr = value === null ? 'null' : String(value);
    status.style.color = 'var(--dim)';
    status.textContent = 'Saving…';
    let line;
    try {
      line = configSet(key, valueStr);
    } catch (e) {
      status.style.color = 'var(--err)';
      status.textContent = '✗ ' + (e.message || String(e));
      return;
    }
    const out = await runSlashConfirmed(line);
    if (out.ok) {
      status.style.color = 'var(--ok)';
      status.textContent = '✓ saved';
      setTimeout(() => { closeModal(); load(); }, 600);
      return;
    }
    if (out.code === 'CANCELLED') { status.style.color = 'var(--dim)'; status.textContent = 'cancelled'; return; }
    status.style.color = 'var(--err)';
    status.textContent = `✗ ${out.hint ? `${out.error || 'failed'} — ${out.hint}` : (out.error || 'failed')}`;
  }

  await load();
}
