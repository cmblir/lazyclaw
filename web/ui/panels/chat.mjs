// web/ui/panels/chat.mjs — one-shot prompt chat. The assignee picker is
// sourced from GET /providers (grouped by suggested model), preselected from
// GET /status's configured default; sending posts { prompt, provider, model }
// to POST /agent, which is one-shot, so prior turns are flattened into the
// prompt text (buildAgentPrompt) rather than sent as a message array.
import { el, phead, chip } from '../dom.mjs';
import { api } from '../api.mjs';

// Build the ordered {value, label, isDefault} options for one provider's
// models. Pure — no DOM — so it's unit-testable without a browser stub (see
// tests/f-chat-model-options.test.mjs).
//
// No cap here: a native <select> handles hundreds of options fine (a single
// live-fetched provider can return 300+), and a fixed slice(0, N) silently
// discarded a provider's own defaultModel along with its newest models the
// moment suggestedModels stopped being a short curated list. The caller
// groups these into an <optgroup> per provider so a long list stays
// navigable instead of one giant flat run.
//
// The provider's own `defaultModel` (a fact the registry already gives us)
// is pinned first and labelled " (default)" rather than resorting the rest
// of the list — guessing "newest" by parsing version numbers out of model
// ids is exactly the kind of heuristic that ages badly the moment a vendor
// changes its naming scheme.
export function buildModelOptions(provider) {
  const name = provider?.name || '';
  const models = Array.isArray(provider?.suggestedModels) ? provider.suggestedModels : [];
  const defaultModel = provider?.defaultModel || null;
  const ordered = (defaultModel && models.includes(defaultModel))
    ? [defaultModel, ...models.filter((m) => m !== defaultModel)]
    : models;
  return ordered.map((m) => ({
    value: `${name}:${m}`,
    label: `${name}  ·  ${m}${m === defaultModel ? ' (default)' : ''}`,
    isDefault: m === defaultModel,
  }));
}

export async function render(host) {
  host.append(phead('Chat', 'Send a one-shot prompt to a provider/model.'));

  // [{role, text}] — local to this render; resets when the panel is left and
  // reopened, since the shell tears down and rebuilds the host on navigation.
  let chatHistory = [];
  // providerId -> 'live' | 'builtin', from GET /providers's modelsSource.
  // Lets the picker show whether the currently selected provider's model
  // list came from a live fetch or the frozen builtin/generated one —
  // without it a stale list looks identical to a fresh one.
  const modelSourceByProvider = new Map();

  const meta = el('span', { class: 'dim' });
  const select = el('select', {}, el('option', { value: '', text: '(loading…)' }));
  const sourceTag = el('span', {});
  host.append(el('div', { class: 'toolbar' }, select, sourceTag,
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Clear', onclick: () => resetChat() }),
    meta));

  function updateSourceTag() {
    const provName = select.value.includes(':') ? select.value.split(':', 2)[0] : select.value;
    const source = modelSourceByProvider.get(provName) || null;
    if (source) sourceTag.replaceChildren(chip(source, source === 'live' ? 'live' : ''));
    else sourceTag.replaceChildren();
  }
  select.addEventListener('change', updateSourceTag);

  const stream = el('div', { id: 'chat-stream' }, el('div', { class: 'empty', text: 'Type below to start.' }));
  host.append(stream);

  const input = el('textarea', { placeholder: 'Send a message — Enter to send, Shift+Enter for newline.' });
  host.append(el('div', { class: 'input-row' }, input,
    el('button', { class: 'btn', type: 'button', text: 'Send', onclick: () => sendChat() })));

  function resetChat() {
    chatHistory = [];
    stream.replaceChildren(el('div', { class: 'empty', text: 'Type below to start.' }));
    meta.textContent = '';
  }

  function appendMsg(role, text) {
    if (stream.querySelector('.empty')) stream.replaceChildren();
    const div = el('div', { class: 'msg ' + role, text });
    stream.append(div);
    stream.scrollTop = stream.scrollHeight;
    return div;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // Flat conversation prompt: previous turns + the new user message. The
  // daemon's /agent endpoint is one-shot, so prior turns are stuffed into the
  // prompt body. Keeps the panel stateless server-side.
  function buildAgentPrompt(latestUserText) {
    if (chatHistory.length <= 1) return latestUserText;
    const lines = [];
    for (const m of chatHistory.slice(-12, -1)) {
      lines.push((m.role === 'user' ? 'User:' : 'Assistant:') + ' ' + m.text);
    }
    lines.push('User: ' + latestUserText);
    lines.push('Assistant:');
    return lines.join('\n\n');
  }

  async function sendChat() {
    const text = input.value.trim();
    if (!text) return;
    const assignee = select.value;
    if (!assignee) { appendMsg('error', 'No provider selected. Run `pompos onboard` first.'); return; }
    input.value = '';
    appendMsg('user', text);
    chatHistory.push({ role: 'user', text });
    meta.textContent = '⏳ thinking…';
    const t0 = Date.now();
    try {
      const [provName, modelName] = assignee.includes(':') ? assignee.split(':', 2) : [assignee, ''];
      const body = { prompt: buildAgentPrompt(text), provider: provName };
      if (modelName) body.model = modelName;
      const r = await api('/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // /agent returns { reply, usage?, cost? }; older drafts used { text } /
      // { output } — accept any so this works against an older or newer daemon.
      const reply = (typeof r.reply === 'string' ? r.reply : '')
        || (typeof r.text === 'string' ? r.text : '')
        || (typeof r.output === 'string' ? r.output : '')
        || '(empty)';
      appendMsg('assistant', reply);
      chatHistory.push({ role: 'assistant', text: reply });
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      meta.textContent = `${r.provider || provName} · ${r.model || modelName || '(default)'} · ${dur}s`;
    } catch (e) {
      appendMsg('error', '⚠ ' + (e.message || String(e)));
      meta.textContent = '';
    }
  }

  // Populate the assignee select — GET /providers returns a bare array;
  // older drafts wrapped it as { providers: [...] }. Accept both.
  try {
    const r = await api('/providers');
    const arr = Array.isArray(r) ? r : (r.providers || []);
    select.replaceChildren();
    if (arr.length === 0) {
      select.append(el('option', { value: '', text: '(no providers — run pompos onboard)' }));
      return;
    }
    // Preselect the configured default when possible so the user doesn't
    // have to scroll through the list before sending the first message.
    let defaultStatus = null;
    try { defaultStatus = await api('/status'); } catch { /* keep going */ }
    const defaultProv = defaultStatus?.provider || null;
    const defaultModel = defaultStatus?.model || null;
    const defaultValue = defaultProv && defaultModel ? `${defaultProv}:${defaultModel}` : defaultProv;
    for (const p of arr) {
      modelSourceByProvider.set(p.name, p.modelsSource || 'builtin');
      const ms = p.suggestedModels || [];
      if (!ms.length) { select.append(el('option', { value: p.name, text: p.name })); continue; }
      const options = buildModelOptions(p);
      select.append(el('optgroup', { label: p.name },
        options.map((o) => el('option', { value: o.value, text: o.label }))));
    }
    if (defaultValue) {
      // Exact match first (provider:model); fall back to any option starting
      // with `<provider>:` if the configured model isn't in the suggestions.
      const options = [...select.options];
      const exact = options.find((o) => o.value === defaultValue);
      if (exact) select.value = defaultValue;
      else {
        const prefix = (defaultProv || '') + ':';
        const byProv = options.find((o) => o.value.startsWith(prefix) || o.value === defaultProv);
        if (byProv) select.value = byProv.value;
      }
    }
    updateSourceTag();
  } catch (e) {
    meta.textContent = '⚠ ' + e.message;
  }
}
