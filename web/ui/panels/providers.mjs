// web/ui/panels/providers.mjs — registered LLM providers: list, test
// connectivity, add a custom OpenAI-compat provider, remove a custom one.
import { el, phead } from '../dom.mjs';
import { api, apiRaw } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Providers', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ Add custom OpenAI-compat', onclick: () => openAddProviderModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  async function load() {
    try {
      const r = await api('/providers');
      const arr = r.providers || r;
      meta.textContent = `${arr.length} registered`;
      const cards = arr.map((p) => {
        const tag = p.requiresApiKey ? el('span', { class: 'pill warn', text: 'api key' }) : el('span', { class: 'pill ok', text: 'no key' });
        const customTag = p.custom ? el('span', { class: 'pill', style: 'background:rgba(217,179,90,0.18);color:var(--accent);', text: 'custom' }) : null;
        const builtinCompat = p.builtinOpenAICompat ? el('span', { class: 'pill', style: 'background:rgba(74,222,128,0.12);color:var(--ok);', text: 'openai-compat' }) : null;
        const models = (p.suggestedModels || []).slice(0, 6).join(' · ') || null;
        const out = el('div', { class: 'dim', 'data-test-result': '', style: 'margin-top:6px;font-size:11px;' });
        return el('div', { class: 'card' },
          el('div', { class: 'row', style: 'border:0;padding:0;' },
            el('div', { class: 'name', text: p.name }), tag, customTag, builtinCompat,
            el('div', { class: 'dim row-actions', text: p.endpoint || '' }),
            el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Test', onclick: () => testProvider(p.name, out) }),
            p.custom ? el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Remove', onclick: () => removeProvider(p.name) }) : null),
          el('div', { class: 'dim', style: 'margin-top:6px;', text: p.docs || '' }),
          el('div', { style: 'margin-top:8px;font-size:12px;' }, models || el('span', { class: 'dim', text: '(default)' })),
          out);
      });
      list.replaceWith(list = el('div', {}, cards));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  async function testProvider(name, out) {
    out.textContent = '⏳ probing…';
    out.style.color = 'var(--dim)';
    try {
      const r = await apiRaw('/providers/' + encodeURIComponent(name) + '/test');
      const body = await r.json();
      if (body.ok) {
        out.style.color = 'var(--ok)';
        const reply = (body.reply || '').replace(/\s+/g, ' ').slice(0, 120);
        out.textContent = `✓ ok · ${body.model} · ${body.durationMs}ms${reply ? ' · ' + reply : ''}`;
      } else {
        out.style.color = 'var(--err)';
        out.textContent = `✗ ${body.error || 'failed'} · ${body.code || r.status}`;
      }
    } catch (e) {
      out.style.color = 'var(--err)';
      out.textContent = '✗ ' + (e.message || String(e));
    }
  }

  async function removeProvider(name) {
    if (!confirm(`Remove custom provider "${name}"?`)) return;
    try {
      const r = await apiRaw('/providers/' + encodeURIComponent(name), { method: 'DELETE' });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `${r.status}`);
      load();
    } catch (e) {
      alert('Remove failed: ' + e.message);
    }
  }

  function openAddProviderModal() {
    const status = el('div', { class: 'dim', style: 'font-size:12px;' });
    const nameInput = el('input', { placeholder: 'e.g. my-vllm', autofocus: true });
    const baseUrlInput = el('input', { placeholder: 'https://integrate.api.nvidia.com/v1' });
    const apiKeyInput = el('input', { type: 'password', placeholder: 'nvapi-…' });
    const modelInput = el('input', { placeholder: 'meta/llama-3.1-405b-instruct' });
    openModal({
      title: 'Add custom OpenAI-compat provider',
      body: [
        el('div', { class: 'dim', style: 'margin-bottom:14px;font-size:12px;' },
          'Works with any service that speaks the OpenAI v1 wire format ' +
          '(vLLM · LM Studio · private gateways · self-hosted DeepInfra). ' +
          'Built-in aliases (nim, openrouter, groq, …) can be overridden by ' +
          'registering a custom entry of the same name.'),
        el('div', { class: 'form-row' }, el('label', { text: 'Name (short id, e.g. "nim", "openrouter")' }), nameInput),
        el('div', { class: 'form-row' }, el('label', { text: 'Base URL (must end in /v1)' }), baseUrlInput),
        el('div', { class: 'form-row' }, el('label', { text: 'API key (blank for auth-less endpoints)' }), apiKeyInput),
        el('div', { class: 'form-row' }, el('label', { text: 'Default model id (optional)' }), modelInput),
        status,
      ],
      foot: [
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel', onclick: () => closeModal() }),
        el('button', {
          class: 'btn', type: 'button', text: 'Save',
          onclick: () => submitAddProvider(nameInput, baseUrlInput, apiKeyInput, modelInput, status),
        }),
      ],
    });
  }

  async function submitAddProvider(nameInput, baseUrlInput, apiKeyInput, modelInput, status) {
    const name = nameInput.value.trim();
    const baseUrl = baseUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const defaultModel = modelInput.value.trim();
    status.style.color = 'var(--dim)';
    status.textContent = 'Saving…';
    try {
      const r = await apiRaw('/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, baseUrl, apiKey: apiKey || undefined, defaultModel: defaultModel || undefined }),
      });
      const body = await r.json();
      if (!r.ok) {
        status.style.color = 'var(--err)';
        status.textContent = '✗ ' + (body.error || `${r.status} ${r.statusText}`);
        return;
      }
      status.style.color = 'var(--ok)';
      const overrideNote = body.overridesBuiltin ? ' (overrides built-in)' : '';
      status.textContent = `✓ saved — ${body.name} → ${body.baseUrl}${overrideNote}`;
      setTimeout(() => { closeModal(); load(); }, 700);
    } catch (e) {
      status.style.color = 'var(--err)';
      status.textContent = '✗ ' + (e.message || String(e));
    }
  }

  await load();
}
