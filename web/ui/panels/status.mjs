// web/ui/panels/status.mjs — what this daemon is configured to use, plus the
// v5 subsystem summary (trainer / index / sandbox backend) and the raw JSON.
//
// The brief's reference implementation for this file queried
// { version, uptime, configDir, authToken } — fields GET /status does not
// return (verified against daemon/routes/meta.mjs: it returns
// { provider, model, keyMasked, v5 }). Rendering the brief's fields verbatim
// would show an all-placeholder page, so this recovers the real pre-Task-3
// rendering instead, converted to el()/banner().
import { el, phead, banner } from '../dom.mjs';
import { api } from '../api.mjs';

export async function render(host) {
  host.append(phead('Status', null));
  let card = el('div', { class: 'empty', text: 'Loading…' });
  host.append(card);

  try {
    const r = await api('/status');
    const v5 = r.v5 || {};
    const trainer = v5.trainer || {};
    const v5Banner = banner('ok', '✓',
      el('strong', { text: 'v5:' }), ' trainer: ',
      el('code', { text: `${trainer.provider || 'off'}/${trainer.model || '-'}` }),
      ' · index: ', el('code', { text: `${v5.indexRows ?? '?'} rows` }),
      ' · sandbox: ', el('code', { text: v5.sandboxBackend || 'local' }),
      v5.migrateBackup ? [' · backup: ', el('code', { text: v5.migrateBackup })] : null);
    card.replaceWith(card = el('div', {}, v5Banner,
      el('div', { class: 'card' }, el('pre', { text: JSON.stringify(r, null, 2) }))));
  } catch (e) {
    card.replaceWith(card = el('div', { class: 'empty', text: '⚠ ' + e.message }));
  }
}
