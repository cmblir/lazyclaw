    // Tab switching ────────────────────────────────────────────────
    const tabs = document.querySelectorAll('nav.tabs button');
    const sections = document.querySelectorAll('main section');
    tabs.forEach((b) => b.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === b));
      sections.forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
      const loader = LOADERS[b.dataset.tab];
      if (loader) loader();
    }));

    document.getElementById('footer-url').textContent = location.href;

    // ── Auth token ────────────────────────────────────────────────
    // The static dashboard shell is served without a token, but the JSON
    // API stays gated when the daemon runs with --auth-token. We keep the
    // token in localStorage and attach it as `Authorization: Bearer` on
    // every API call. A loopback daemon with no auth never sends a token —
    // the header is simply absent and calls work unchanged.
    const TOKEN_KEY = 'lazyclaw_token';
    function getToken() {
      try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
    }
    function setToken(t) {
      try { localStorage.setItem(TOKEN_KEY, t); } catch {}
    }
    // Merge an Authorization header into the caller's opts when a token is
    // known, without clobbering any other headers they passed.
    function withAuth(opts = {}) {
      const token = getToken();
      if (!token) return opts;
      return { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } };
    }
    // On 401 from a gated route, prompt the user once for the token, store
    // it, and signal the caller to retry. window.prompt is fine for v1.
    function promptForToken() {
      const entered = window.prompt(
        'This daemon requires an auth token (started with --auth-token).\n' +
        'Paste the token to continue:',
        getToken(),
      );
      if (entered == null) return false; // user cancelled
      setToken(entered.trim());
      return true;
    }

    // Single auth-aware fetch primitive: adds the bearer token via withAuth,
    // prompts for a token + retries once on 401, returns the raw Response.
    // ALL dashboard requests route through this (api/apiSoft + the direct
    // export/delete/test/POST call sites) so none bypass the auth gate. Uses
    // globalThis.fetch so this is the only place that touches fetch directly.
    async function apiRaw(path, opts = {}) {
      let r = await globalThis.fetch(path, withAuth(opts));
      if (r.status === 401 && promptForToken()) {
        r = await globalThis.fetch(path, withAuth(opts)); // retry once with the new token
      }
      return r;
    }
    // Tiny fetch helper that surfaces errors as toasts on the page.
    async function api(path, opts = {}) {
      const r = await apiRaw(path, opts);
      if (!r.ok && r.status !== 200) {
        let body = '';
        try { body = JSON.stringify(await r.json()); } catch {}
        throw new Error(`${r.status} ${r.statusText}${body ? ' — ' + body : ''}`);
      }
      return r.json();
    }
    // Soft variant: returns { status, body } no matter what — used by the
    // /doctor (503 on issues), /rates/validate (422), /config/validate (422)
    // endpoints where a non-200 carries a meaningful payload, not an error.
    async function apiSoft(path, opts = {}) {
      const r = await apiRaw(path, opts);
      let body = null;
      try { body = await r.json(); } catch {}
      return { status: r.status, ok: r.ok, body };
    }
    function escHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    // ── Shared modal ────────────────────────────────────────────────
    // openModal({ title, bodyHtml, footHtml }) renders into the markup
    // declared at the bottom of <body> and shows the backdrop. ESC and
    // backdrop click close. Only one modal is open at a time — calling
    // openModal while another is already open replaces its contents.
    function openModal({ title, bodyHtml, footHtml }) {
      document.getElementById('modal-title').textContent = title || '';
      document.getElementById('modal-body').innerHTML = bodyHtml || '';
      document.getElementById('modal-foot').innerHTML = footHtml || '';
      document.getElementById('modal-backdrop').classList.add('open');
    }
    function closeModal() {
      document.getElementById('modal-backdrop').classList.remove('open');
      document.getElementById('modal-body').innerHTML = '';
      document.getElementById('modal-foot').innerHTML = '';
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('modal-backdrop').classList.contains('open')) closeModal();
    });
    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + (m % 60) + 'm';
      return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    }
    function fmtBytes(n) {
      if (!Number.isFinite(n)) return '—';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── Status / version (always shown in header) ────────────────
    api('/version').then((v) => {
      document.getElementById('version').textContent = `v${v.version}`;
    }).catch(() => {});

    // ── Loaders per tab ──────────────────────────────────────────
    const LOADERS = {};

    LOADERS.chat = async function loadChat() {
      try {
        const r = await api('/providers');
        // GET /providers returns a bare array; older drafts wrapped it
        // as { providers: [...] }. Accept both so the dashboard works
        // against any daemon version users might happen to be running.
        const arr = Array.isArray(r) ? r : (r.providers || []);
        const sel = document.getElementById('chat-assignee');
        sel.innerHTML = '';
        if (arr.length === 0) {
          const opt = document.createElement('option');
          opt.value = ''; opt.textContent = '(no providers — run lazyclaw onboard)';
          sel.appendChild(opt);
          return;
        }
        // Preselect the configured default when possible so the user
        // doesn't have to scroll through the list before sending the
        // first message.
        let defaultStatus = null;
        try { defaultStatus = await api('/status'); } catch { /* keep going */ }
        const defaultProv = defaultStatus?.provider || null;
        const defaultModel = defaultStatus?.model || null;
        const defaultValue = defaultProv && defaultModel ? `${defaultProv}:${defaultModel}` : defaultProv;
        for (const p of arr) {
          const ms = (p.suggestedModels || []);
          if (!ms.length) {
            const opt = document.createElement('option');
            opt.value = p.name; opt.textContent = p.name;
            sel.appendChild(opt);
            continue;
          }
          for (const m of ms.slice(0, 6)) {
            const opt = document.createElement('option');
            opt.value = `${p.name}:${m}`;
            opt.textContent = `${p.name}  ·  ${m}`;
            sel.appendChild(opt);
          }
        }
        if (defaultValue) {
          // Try exact match first (provider:model); fall back to any
          // option starting with `<provider>:` if the configured model
          // isn't in the suggested list.
          const exact = Array.from(sel.options).find((o) => o.value === defaultValue);
          if (exact) sel.value = defaultValue;
          else {
            const prefix = (defaultProv || '') + ':';
            const byProv = Array.from(sel.options).find((o) => o.value.startsWith(prefix) || o.value === defaultProv);
            if (byProv) sel.value = byProv.value;
          }
        }
      } catch (e) {
        document.getElementById('chat-meta').textContent = '⚠ ' + e.message;
      }
    };

    LOADERS.sessions = async function loadSessions() {
      const root = document.getElementById('sessions-list');
      root.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await api('/sessions?withV5=true');
        const arr = r.sessions || r;
        if (!Array.isArray(arr) || arr.length === 0) {
          root.innerHTML = '<div class="empty">No persisted sessions yet. Start one with <code>lazyclaw chat --session &lt;id&gt;</code>.</div>';
          return;
        }
        root.innerHTML = '';
        arr.forEach((s) => {
          const div = document.createElement('div');
          div.className = 'card row clickable';
          const id = s.id || s.sessionId || s.name || JSON.stringify(s);
          const turns = s.turns ?? s.turnCount ?? '';
          const updated = s.updatedAt || s.mtime || '';
          // v5 columns: trainerHandled / agentName / trajectoryId.
          const tagTrained = s.trainerHandled
            ? `<span class="pill ok" title="trained by ${escHtml(s.trainedBy || 'trainer')}">trained: ${escHtml(s.trainedBy || 'on')}</span>`
            : '';
          const tagAgent = s.agentName
            ? `<span class="pill" style="background:rgba(217,179,90,0.18);color:var(--accent);">@${escHtml(s.agentName)}</span>`
            : '';
          div.innerHTML = `<div class="name">${escHtml(id)}</div>
            <div class="dim">${turns ? turns + ' turns' : ''}</div>
            ${tagTrained}${tagAgent}
            <div class="dim row-actions">${escHtml(updated)}</div>
            <button class="btn btn-secondary btn-sm" data-action="view">View</button>
            <button class="btn btn-secondary btn-sm" data-action="export">Export</button>
            <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>`;
          div.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            const action = btn?.dataset.action;
            if (action === 'export') return openSessionExport(id);
            if (action === 'delete') return deleteSession(id);
            return openSessionDetail(id);
          });
          root.appendChild(div);
        });
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    async function openSessionDetail(id) {
      openModal({ title: `Session — ${id}`, bodyHtml: '<div class="empty">Loading…</div>' });
      try {
        const r = await api('/sessions/' + encodeURIComponent(id));
        const turns = r.turns || r.entries || r;
        if (!Array.isArray(turns) || turns.length === 0) {
          document.getElementById('modal-body').innerHTML = '<div class="empty">Empty session.</div>';
          return;
        }
        const html = turns.map((t) => {
          const role = (t.role || 'note').toLowerCase();
          const content = String(t.content ?? t.text ?? '');
          const ts = t.ts || t.timestamp || '';
          return `<div class="turn ${escHtml(role)}">
            <span class="role-tag">${escHtml(role)}${ts ? ' · ' + escHtml(ts) : ''}</span>${escHtml(content)}
          </div>`;
        }).join('');
        document.getElementById('modal-body').innerHTML = html;
      } catch (e) {
        document.getElementById('modal-body').innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    }

    async function openSessionExport(id) {
      openModal({ title: `Export — ${id}`, bodyHtml: '<div class="empty">Loading…</div>' });
      try {
        const r = await apiRaw('/sessions/' + encodeURIComponent(id) + '/export?format=md');
        const text = await r.text();
        document.getElementById('modal-body').innerHTML = `<pre>${escHtml(text)}</pre>`;
        document.getElementById('modal-foot').innerHTML = `
          <button class="btn btn-secondary" onclick="navigator.clipboard.writeText(${JSON.stringify(text)}); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy markdown',1200)">Copy markdown</button>
          <button class="btn" onclick="closeModal()">Close</button>`;
      } catch (e) {
        document.getElementById('modal-body').innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    }

    async function deleteSession(id) {
      if (!confirm(`Delete session "${id}"?\nTurn log will be permanently removed.`)) return;
      try {
        await apiRaw('/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
        LOADERS.sessions();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    }

    // v5 confidence pill color: red <0.4, amber <0.7, green >=0.7.
    function confidencePill(c) {
      if (c == null || c === '') return '';
      const n = Number(c);
      if (!Number.isFinite(n)) return '';
      const cls = n >= 0.7 ? 'ok' : (n >= 0.4 ? 'warn' : 'err');
      return `<span class="pill ${cls}" title="confidence">${n.toFixed(2)}</span>`;
    }

    LOADERS.skills = async function loadSkills() {
      const root = document.getElementById('skills-list');
      const meta = document.getElementById('skills-meta');
      const suggBox = document.getElementById('skills-suggestions');
      root.innerHTML = '<div class="empty">Loading…</div>';
      // Fire suggestions fetch in parallel; render when ready.
      apiSoft('/skills/suggestions').then(({ body }) => {
        const items = (body && body.suggestions) || [];
        if (!items.length) { suggBox.innerHTML = ''; return; }
        suggBox.innerHTML = `<div class="card" style="border-color:var(--accent);">
          <div class="name" style="color:var(--accent);">Curator suggestions (${items.length})</div>
          ${items.slice(0, 5).map((s) => `<div class="dim" style="margin-top:6px;font-size:12px;">
            ${escHtml(s.suggestion || s.cluster?.sample || '')}
            <span class="dim" style="margin-left:6px;">${s.ts ? new Date(s.ts).toLocaleString() : ''}</span>
          </div>`).join('')}
        </div>`;
      }).catch(() => { suggBox.innerHTML = ''; });

      try {
        const r = await api('/skills');
        const arr = r.skills || r;
        if (!Array.isArray(arr) || arr.length === 0) {
          root.innerHTML = '<div class="empty">No skills yet. Install one: <code>lazyclaw skills install &lt;user&gt;/&lt;repo&gt;</code>.</div>';
          if (meta) meta.textContent = '';
          return;
        }
        if (meta) meta.textContent = `${arr.length} skill${arr.length === 1 ? '' : 's'}`;
        // Group by `group` field; fall back to 'ungrouped'.
        const groups = new Map();
        for (const s of arr) {
          const g = (s.group && String(s.group)) || 'ungrouped';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(s);
        }
        const groupNames = [...groups.keys()].sort();
        root.innerHTML = '';
        for (const g of groupNames) {
          const wrap = document.createElement('div');
          wrap.style.marginTop = '12px';
          wrap.innerHTML = `<h3 style="font-size:13px;color:var(--dim);margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">${escHtml(g)} · ${groups.get(g).length}</h3>`;
          for (const s of groups.get(g)) {
            const div = document.createElement('div');
            div.className = 'card clickable';
            const trainedTag = s.trained_by
              ? `<span class="pill" title="trained_by">${escHtml(s.trained_by)}</span>`
              : '';
            const conf = confidencePill(s.confidence);
            const crossOk = Array.isArray(s.cross_cli_tested) && s.cross_cli_tested.length
              ? `<span class="pill ok" title="cross-CLI: ${escHtml(s.cross_cli_tested.map((x) => x.provider || '').join(', '))}">x-cli ✓</span>`
              : (s.cross_cli_tested === true
                ? '<span class="pill ok" title="cross-CLI tested">x-cli ✓</span>'
                : '<span class="pill" title="not cross-CLI tested" style="opacity:0.4;">x-cli —</span>');
            div.innerHTML = `<div class="row" style="border:0;padding:0;">
                <div class="name">${escHtml(s.name)}</div>
                ${trainedTag}${conf}${crossOk}
                <div class="dim row-actions">${(s.bytes ?? '')} bytes</div>
                <button class="btn btn-secondary btn-sm" data-action="view">View</button>
                <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
              </div>
              <div class="dim" style="margin-top:6px;">${escHtml(s.summary || s.description || '')}</div>`;
            div.addEventListener('click', (e) => {
              const action = e.target.closest('button')?.dataset.action;
              if (action === 'delete') return deleteSkill(s.name);
              return openSkillDetail(s.name);
            });
            wrap.appendChild(div);
          }
          root.appendChild(wrap);
        }
        // Synth-from-task footer.
        const synthBar = document.createElement('div');
        synthBar.className = 'toolbar';
        synthBar.style.marginTop = '14px';
        synthBar.innerHTML = `<input type="text" id="skill-synth-sid" placeholder="sessionId to synthesize" style="flex:1;min-width:200px;">
          <button class="btn" onclick="skillSynth()">Synthesize from task</button>
          <span class="dim" id="skill-synth-result"></span>`;
        root.appendChild(synthBar);
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    async function skillSynth() {
      const sid = (document.getElementById('skill-synth-sid').value || '').trim();
      const out = document.getElementById('skill-synth-result');
      if (!sid) { out.style.color = 'var(--warn)'; out.textContent = 'enter a sessionId'; return; }
      out.style.color = 'var(--dim)';
      out.textContent = '⏳ synthesizing…';
      try {
        const r = await apiRaw('/skills/synth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) {
          out.style.color = 'var(--ok)';
          out.textContent = '✓ ' + (body.name ? `created skill "${body.name}"` : (body.message || 'done'));
          LOADERS.skills();
        } else {
          out.style.color = 'var(--err)';
          out.textContent = '✗ ' + (body.error || r.statusText);
        }
      } catch (e) {
        out.style.color = 'var(--err)';
        out.textContent = '✗ ' + e.message;
      }
    }

    async function openSkillDetail(name) {
      openModal({ title: `Skill — ${name}`, bodyHtml: '<div class="empty">Loading…</div>' });
      try {
        // GET /skills/<name> returns the markdown body as text/markdown.
        const r = await apiRaw('/skills/' + encodeURIComponent(name));
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const text = await r.text();
        document.getElementById('modal-body').innerHTML = `<pre class="markdown">${escHtml(text)}</pre>`;
        document.getElementById('modal-foot').innerHTML = `
          <button class="btn btn-secondary" onclick="navigator.clipboard.writeText(${JSON.stringify(text)}); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy',1200)">Copy</button>
          <button class="btn" onclick="closeModal()">Close</button>`;
      } catch (e) {
        document.getElementById('modal-body').innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    }

    async function deleteSkill(name) {
      if (!confirm(`Remove skill "${name}"?`)) return;
      try {
        await apiRaw('/skills/' + encodeURIComponent(name), { method: 'DELETE' });
        LOADERS.skills();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    }

    LOADERS.providers = async function loadProviders() {
      const root = document.getElementById('providers-list');
      const meta = document.getElementById('providers-meta');
      root.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await api('/providers');
        const arr = r.providers || r;
        meta.textContent = `${arr.length} registered`;
        root.innerHTML = '';
        arr.forEach((p) => {
          const div = document.createElement('div');
          div.className = 'card';
          const tag = p.requiresApiKey
            ? '<span class="pill warn">api key</span>'
            : '<span class="pill ok">no key</span>';
          const customTag = p.custom ? ' <span class="pill" style="background:rgba(217,179,90,0.18);color:var(--accent);">custom</span>' : '';
          const builtinCompat = p.builtinOpenAICompat ? ' <span class="pill" style="background:rgba(74,222,128,0.12);color:var(--ok);">openai-compat</span>' : '';
          const models = (p.suggestedModels || []).slice(0, 6).join(' · ') || '<span class="dim">(default)</span>';
          const removeBtn = p.custom
            ? `<button class="btn btn-danger btn-sm" data-action="remove">Remove</button>`
            : '';
          div.innerHTML = `<div class="row" style="border:0;padding:0;">
              <div class="name">${escHtml(p.name)}</div>${tag}${customTag}${builtinCompat}
              <div class="dim row-actions">${escHtml(p.endpoint || '')}</div>
              <button class="btn btn-secondary btn-sm" data-action="test">Test</button>
              ${removeBtn}
            </div>
            <div class="dim" style="margin-top:6px;">${escHtml(p.docs || '')}</div>
            <div style="margin-top:8px;font-size:12px;">${models}</div>
            <div class="dim" data-test-result style="margin-top:6px;font-size:11px;"></div>`;
          div.addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.action === 'test') return testProvider(p.name, div);
            if (btn.dataset.action === 'remove') return removeProvider(p.name);
          });
          root.appendChild(div);
        });
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    async function testProvider(name, cardEl) {
      const out = cardEl.querySelector('[data-test-result]');
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
        LOADERS.providers();
      } catch (e) {
        alert('Remove failed: ' + e.message);
      }
    }

    function openAddProviderModal() {
      openModal({
        title: 'Add custom OpenAI-compat provider',
        bodyHtml: `
          <div class="dim" style="margin-bottom:14px;font-size:12px;">
            Works with any service that speaks the OpenAI v1 wire format
            (vLLM · LM Studio · private gateways · self-hosted DeepInfra).
            Built-in aliases (<code>nim</code>, <code>openrouter</code>, <code>groq</code>, …)
            can be overridden by registering a custom entry of the same name.
          </div>
          <div class="form-row">
            <label for="add-prov-name">Name (short id, e.g. "nim", "openrouter")</label>
            <input id="add-prov-name" autofocus placeholder="e.g. my-vllm" />
          </div>
          <div class="form-row">
            <label for="add-prov-baseurl">Base URL (must end in /v1)</label>
            <input id="add-prov-baseurl" placeholder="https://integrate.api.nvidia.com/v1" />
          </div>
          <div class="form-row">
            <label for="add-prov-apikey">API key (blank for auth-less endpoints)</label>
            <input id="add-prov-apikey" type="password" placeholder="nvapi-…" />
          </div>
          <div class="form-row">
            <label for="add-prov-model">Default model id (optional)</label>
            <input id="add-prov-model" placeholder="meta/llama-3.1-405b-instruct" />
          </div>
          <div id="add-prov-status" class="dim" style="font-size:12px;"></div>
        `,
        footHtml: `
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn" onclick="submitAddProvider()">Save</button>
        `,
      });
    }

    async function submitAddProvider() {
      const name = document.getElementById('add-prov-name').value.trim();
      const baseUrl = document.getElementById('add-prov-baseurl').value.trim();
      const apiKey = document.getElementById('add-prov-apikey').value.trim();
      const defaultModel = document.getElementById('add-prov-model').value.trim();
      const status = document.getElementById('add-prov-status');
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
        setTimeout(() => { closeModal(); LOADERS.providers(); }, 700);
      } catch (e) {
        status.style.color = 'var(--err)';
        status.textContent = '✗ ' + (e.message || String(e));
      }
    }

    LOADERS.status = async function loadStatus() {
      const root = document.getElementById('status-card');
      root.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await api('/status');
        // v5 one-line banner under the JSON card.
        const v5 = r.v5 || {};
        const trainer = v5.trainer || {};
        const banner = `<div class="banner ok" style="margin-bottom:10px;">
          <strong>v5:</strong>
          trainer: <code>${escHtml(trainer.provider || 'off')}/${escHtml(trainer.model || '-')}</code>
          · index: <code>${escHtml(String(v5.indexRows ?? '?'))} rows</code>
          · sandbox: <code>${escHtml(v5.sandboxBackend || 'local')}</code>
          ${v5.migrateBackup ? ` · backup: <code>${escHtml(v5.migrateBackup)}</code>` : ''}
        </div>`;
        root.innerHTML = banner + `<div class="card"><pre>${JSON.stringify(r, null, 2)}</pre></div>`;
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${e.message}</div>`;
      }
    };

    // ── Workflows ────────────────────────────────────────────────
    document.getElementById('wf-status').addEventListener('change', () => LOADERS.workflows());
    document.getElementById('wf-filter').addEventListener('input', debounce(() => LOADERS.workflows(), 250));
    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

    LOADERS.workflows = async function loadWorkflows() {
      const list = document.getElementById('wf-list');
      const grid = document.getElementById('wf-summary');
      const meta = document.getElementById('wf-meta');
      list.innerHTML = '<div class="empty">Loading…</div>';
      grid.innerHTML = '';
      try {
        const status = document.getElementById('wf-status').value;
        const filter = document.getElementById('wf-filter').value.trim();
        const qs = new URLSearchParams();
        if (status) qs.set('status', status);
        if (filter) qs.set('filter', filter);
        const url = '/workflows' + (qs.toString() ? '?' + qs : '');
        const [r, agg] = await Promise.all([api(url), api('/workflows/aggregate').catch(() => null)]);
        const sessions = r.sessions || [];
        meta.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · dir ${r.dir || '?'}`;
        const counts = sessions.reduce((acc, s) => {
          const sm = s.summary || {};
          if (sm.done)        acc.done++;
          if (sm.resumable)   acc.resumable++;
          if (sm.failed > 0)  acc.failed++;
          if (sm.running > 0) acc.running++;
          return acc;
        }, { done: 0, resumable: 0, failed: 0, running: 0 });
        grid.innerHTML = `
          <div class="stat"><div class="label">Total</div><div class="value">${sessions.length}</div></div>
          <div class="stat"><div class="label">Running</div><div class="value">${counts.running}</div></div>
          <div class="stat"><div class="label">Resumable</div><div class="value">${counts.resumable}</div></div>
          <div class="stat"><div class="label">Failed</div><div class="value" style="color:${counts.failed ? 'var(--err)' : 'inherit'};">${counts.failed}</div></div>
          <div class="stat"><div class="label">Done</div><div class="value" style="color:${counts.done ? 'var(--ok)' : 'inherit'};">${counts.done}</div></div>
          ${agg && agg.sessionCount != null ? `<div class="stat"><div class="label">Aggregate sessions</div><div class="value">${agg.sessionCount}</div><div class="sub">${Object.keys(agg.nodeStats || {}).length} distinct nodes</div></div>` : ''}
        `;
        if (sessions.length === 0) {
          list.innerHTML = '<div class="empty">No workflow runs yet. Run one with <code>lazyclaw run &lt;id&gt; ./flow.mjs</code>.</div>';
          return;
        }
        const rows = sessions.map((s) => {
          const sm = s.summary || {};
          const tags = [];
          if (sm.running > 0) tags.push('<span class="pill warn">running</span>');
          if (sm.failed > 0)  tags.push('<span class="pill err">failed</span>');
          if (sm.resumable)   tags.push('<span class="pill warn">resumable</span>');
          if (sm.done)        tags.push('<span class="pill ok">done</span>');
          const total = sm.total ?? '';
          return `<tr class="clickable" data-wf-id="${escHtml(s.sessionId)}">
            <td><code>${escHtml(s.sessionId)}</code></td>
            <td>${tags.join(' ') || '<span class="dim">—</span>'}</td>
            <td class="num">${sm.success ?? 0} / ${total}</td>
            <td class="num">${sm.failed ?? 0}</td>
            <td class="dim">${escHtml(s.updatedAt || s.startedAt || '')}</td>
            <td><button class="btn btn-danger btn-sm" data-action="wf-delete">Delete</button></td>
          </tr>`;
        }).join('');
        list.innerHTML = `<table class="tbl">
          <thead><tr><th>Session</th><th>State</th><th>Done / Total</th><th>Failed</th><th>Updated</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
        list.querySelectorAll('tr[data-wf-id]').forEach((tr) => {
          tr.addEventListener('click', (e) => {
            const id = tr.getAttribute('data-wf-id');
            const action = e.target.closest('button')?.dataset.action;
            if (action === 'wf-delete') return deleteWorkflow(id);
            return openWorkflowDetail(id);
          });
        });
      } catch (e) {
        list.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    async function openWorkflowDetail(id) {
      openModal({ title: `Workflow — ${id}`, bodyHtml: '<div class="empty">Loading…</div>' });
      try {
        const r = await api('/workflows/' + encodeURIComponent(id));
        const sm = r.summary || {};
        // GET /workflows/<id> returns the per-node map under `nodes`.
        const nodes = r.nodes || r.state?.nodes || {};
        const nodeRows = Object.entries(nodes).map(([nid, n]) => {
          const status = (n.status || '').toLowerCase();
          const pillClass = status === 'failed' ? 'err' : (status === 'success' ? 'ok' : (status === 'running' ? 'warn' : ''));
          const dur = n.durationMs != null ? fmtDuration(n.durationMs) : '—';
          const out = String(n.output ?? n.error ?? '');
          const truncated = out.length > 240 ? out.slice(0, 240) + '…' : out;
          return `<tr>
            <td><code>${escHtml(nid)}</code></td>
            <td>${pillClass ? `<span class="pill ${pillClass}">${escHtml(status)}</span>` : escHtml(status || '—')}</td>
            <td class="num">${dur}</td>
            <td class="dim">${escHtml(truncated)}</td>
          </tr>`;
        }).join('');
        const summaryHtml = `<div class="grid" style="margin-bottom:14px;">
            <div class="stat"><div class="label">Total</div><div class="value">${sm.total ?? '—'}</div></div>
            <div class="stat"><div class="label">Done</div><div class="value">${sm.success ?? 0}</div></div>
            <div class="stat"><div class="label">Failed</div><div class="value" style="color:${sm.failed ? 'var(--err)' : 'inherit'}">${sm.failed ?? 0}</div></div>
            <div class="stat"><div class="label">Running</div><div class="value">${sm.running ?? 0}</div></div>
          </div>`;
        const tableHtml = nodeRows
          ? `<table class="tbl">
              <thead><tr><th>Node</th><th>Status</th><th>Duration</th><th>Output / Error</th></tr></thead>
              <tbody>${nodeRows}</tbody>
            </table>`
          : '<div class="empty">No node results yet.</div>';
        document.getElementById('modal-body').innerHTML = summaryHtml + tableHtml;
      } catch (e) {
        document.getElementById('modal-body').innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    }

    async function deleteWorkflow(id) {
      if (!confirm(`Delete workflow session "${id}"?\nState file will be permanently removed.`)) return;
      try {
        await apiRaw('/workflows/' + encodeURIComponent(id), { method: 'DELETE' });
        LOADERS.workflows();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    }

    // ── Rates ────────────────────────────────────────────────────
    document.getElementById('rates-filter').addEventListener('input', debounce(() => LOADERS.rates(), 250));

    LOADERS.rates = async function loadRates() {
      const root = document.getElementById('rates-table');
      const meta = document.getElementById('rates-meta');
      const banner = document.getElementById('rates-validate');
      root.innerHTML = '<div class="empty">Loading…</div>';
      banner.innerHTML = '';
      try {
        const filter = document.getElementById('rates-filter').value.trim();
        const url = '/rates' + (filter ? '?filter=' + encodeURIComponent(filter) : '');
        const [rates, validate] = await Promise.all([api(url), apiSoft('/rates/validate')]);
        const entries = Object.entries(rates || {});
        meta.textContent = `${entries.length} card${entries.length === 1 ? '' : 's'}`;
        // Validation banner
        if (validate.body) {
          const v = validate.body;
          const issues = (v.issues || []).map((i) => `<li>${escHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('');
          const warnings = (v.warnings || []).map((w) => `<li>${escHtml(typeof w === 'string' ? w : JSON.stringify(w))}</li>`).join('');
          if (v.ok && !warnings) {
            banner.innerHTML = '<div class="banner ok">All rate cards valid.</div>';
          } else {
            const cls = v.ok ? 'warn' : 'err';
            banner.innerHTML = `<div class="banner ${cls}">
              <div><strong>${v.ok ? 'Warnings' : 'Validation issues'}</strong>
                <ul>${issues}${warnings}</ul>
              </div>
            </div>`;
          }
        }
        if (entries.length === 0) {
          root.innerHTML = '<div class="empty">No rate cards configured. Add one with <code>lazyclaw rates set &lt;provider/model&gt; --in &lt;usd&gt; --out &lt;usd&gt;</code>.</div>';
          return;
        }
        const rows = entries.map(([key, card]) => {
          const c = card || {};
          return `<tr data-rate-key="${escHtml(key)}">
            <td><code>${escHtml(key)}</code></td>
            <td class="num">${c.in ?? '—'}</td>
            <td class="num">${c.out ?? '—'}</td>
            <td class="num">${c['cache-read'] ?? '—'}</td>
            <td class="num">${c['cache-create'] ?? '—'}</td>
            <td class="dim">${escHtml(c.currency || 'USD')} / 1M tok</td>
            <td>
              <button class="btn btn-secondary btn-sm" data-action="rate-edit">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="rate-delete">Delete</button>
            </td>
          </tr>`;
        }).join('');
        root.innerHTML = `<table class="tbl">
          <thead><tr><th>Provider / Model</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache create</th><th>Unit</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
        root.querySelectorAll('tr[data-rate-key]').forEach((tr) => {
          const key = tr.getAttribute('data-rate-key');
          const card = (rates || {})[key] || {};
          tr.querySelector('[data-action="rate-edit"]')?.addEventListener('click', () => openRateCardModal(key, card));
          tr.querySelector('[data-action="rate-delete"]')?.addEventListener('click', () => deleteRateCard(key));
        });
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    function openRateCardModal(existingKey = '', existingCard = {}) {
      const c = existingCard || {};
      openModal({
        title: existingKey ? `Edit rate card — ${existingKey}` : 'Add rate card',
        bodyHtml: `
          <div class="dim" style="margin-bottom:12px;font-size:12px;">
            Cost per 1M tokens (input / output / optional cache pricing).
            Same shape as <code>lazyclaw rates set</code>. Saving the same
            key overwrites the existing card.
          </div>
          <div class="form-row">
            <label for="rate-key">Provider / model key</label>
            <input id="rate-key" placeholder="anthropic/claude-opus-4-7" value="${escHtml(existingKey)}" ${existingKey ? 'readonly' : ''}/>
          </div>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px;margin-bottom:0;">
            <div class="form-row"><label for="rate-in">Input (USD / 1M)</label><input id="rate-in" type="number" step="0.01" value="${c.in ?? ''}"/></div>
            <div class="form-row"><label for="rate-out">Output (USD / 1M)</label><input id="rate-out" type="number" step="0.01" value="${c.out ?? ''}"/></div>
            <div class="form-row"><label for="rate-cache-read">Cache read (optional)</label><input id="rate-cache-read" type="number" step="0.01" value="${c['cache-read'] ?? ''}"/></div>
            <div class="form-row"><label for="rate-cache-create">Cache create (optional)</label><input id="rate-cache-create" type="number" step="0.01" value="${c['cache-create'] ?? ''}"/></div>
            <div class="form-row"><label for="rate-currency">Currency</label><input id="rate-currency" value="${escHtml(c.currency || 'USD')}"/></div>
          </div>
          <div id="rate-status" class="dim" style="font-size:12px;margin-top:8px;"></div>
        `,
        footHtml: `
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn" onclick="submitRateCard()">Save</button>
        `,
      });
    }

    async function submitRateCard() {
      const key = document.getElementById('rate-key').value.trim();
      const status = document.getElementById('rate-status');
      if (!key) { status.style.color = 'var(--err)'; status.textContent = 'Key is required.'; return; }
      const card = {
        in: parseFloat(document.getElementById('rate-in').value) || 0,
        out: parseFloat(document.getElementById('rate-out').value) || 0,
        currency: document.getElementById('rate-currency').value.trim() || 'USD',
      };
      const cr = parseFloat(document.getElementById('rate-cache-read').value);
      const cc = parseFloat(document.getElementById('rate-cache-create').value);
      if (Number.isFinite(cr)) card['cache-read'] = cr;
      if (Number.isFinite(cc)) card['cache-create'] = cc;
      status.style.color = 'var(--dim)';
      status.textContent = 'Saving…';
      try {
        const r = await apiRaw('/rates/' + encodeURIComponent(key), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(card),
        });
        const body = await r.json();
        if (!r.ok) {
          status.style.color = 'var(--err)';
          const issues = (body.issues || []).map(i => typeof i === 'string' ? i : JSON.stringify(i)).join('; ');
          status.textContent = `✗ ${body.error || issues || `${r.status} ${r.statusText}`}`;
          return;
        }
        status.style.color = 'var(--ok)';
        status.textContent = `✓ saved`;
        setTimeout(() => { closeModal(); LOADERS.rates(); }, 600);
      } catch (e) {
        status.style.color = 'var(--err)';
        status.textContent = '✗ ' + (e.message || String(e));
      }
    }

    async function deleteRateCard(key) {
      if (!confirm(`Delete rate card "${key}"?`)) return;
      try {
        const r = await apiRaw('/rates/' + encodeURIComponent(key), { method: 'DELETE' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `${r.status}`);
        }
        LOADERS.rates();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    }

    // ── Metrics ──────────────────────────────────────────────────
    LOADERS.metrics = async function loadMetrics() {
      const cards = document.getElementById('metrics-cards');
      const detail = document.getElementById('metrics-detail');
      const meta = document.getElementById('metrics-meta');
      cards.innerHTML = '';
      detail.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const m = await api('/metrics');
        meta.textContent = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
        const cache = m.cache || { hits: 0, misses: 0, size: 0 };
        const totalCache = (cache.hits || 0) + (cache.misses || 0);
        const hitRate = totalCache > 0 ? ((cache.hits / totalCache) * 100).toFixed(1) + '%' : '—';
        const tokens = m.tokensTotal || {};
        const tokIn = tokens.inputTokens || tokens.input || tokens.in || 0;
        const tokOut = tokens.outputTokens || tokens.output || tokens.out || 0;
        const wf = m.workflows || {};
        const costs = m.costsByCurrency || {};
        const costPairs = Object.entries(costs);
        const costStr = costPairs.length ? costPairs.map(([cur, n]) => `${n.toFixed(4)} ${cur}`).join(' · ') : '—';
        cards.innerHTML = `
          <div class="stat"><div class="label">Uptime</div><div class="value">${fmtDuration(m.uptimeMs)}</div></div>
          <div class="stat"><div class="label">Requests</div><div class="value">${m.requestsTotal ?? 0}</div><div class="sub">denied ${m.rateLimitDenied ?? 0}</div></div>
          <div class="stat"><div class="label">Cache hit rate</div><div class="value">${hitRate}</div><div class="sub">${cache.hits || 0} hits / ${cache.misses || 0} misses · ${cache.size || 0} entries</div></div>
          <div class="stat"><div class="label">Tokens (in / out)</div><div class="value">${tokIn.toLocaleString()} / ${tokOut.toLocaleString()}</div></div>
          <div class="stat"><div class="label">Cost</div><div class="value" style="font-size:16px;">${costStr}</div></div>
          ${wf && wf.total != null ? `<div class="stat"><div class="label">Workflows</div><div class="value">${wf.total}</div><div class="sub">${wf.running || 0} running · ${wf.failed || 0} failed · ${wf.done || 0} done</div></div>` : ''}
        `;
        const byStatus = m.requestsByStatus || {};
        const statusRows = Object.keys(byStatus).sort().map((s) => `<tr><td>${escHtml(s)}</td><td class="num">${byStatus[s]}</td></tr>`).join('');
        detail.innerHTML = `<div class="card">
          <div class="dim" style="margin-bottom:6px;">Requests by status</div>
          ${statusRows ? `<table class="tbl"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${statusRows}</tbody></table>` : '<div class="empty">No requests served yet.</div>'}
        </div>`;
      } catch (e) {
        detail.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    // ── Doctor ───────────────────────────────────────────────────
    LOADERS.doctor = async function loadDoctor() {
      const root = document.getElementById('doctor-card');
      const meta = document.getElementById('doctor-meta');
      root.innerHTML = '<div class="empty">Running…</div>';
      const r = await apiSoft('/doctor');
      const d = r.body || {};
      meta.textContent = d.timestamp ? new Date(d.timestamp).toLocaleString() : '';
      const issues = d.issues || [];
      const okBanner = d.ok
        ? '<div class="banner ok"><strong>All checks passed.</strong></div>'
        : `<div class="banner err"><div><strong>${issues.length} issue${issues.length === 1 ? '' : 's'}:</strong>
            <ul>${issues.map((i) => `<li>${escHtml(i)}</li>`).join('')}</ul>
           </div></div>`;
      // v5 index integrity row.
      const idx = d.index || null;
      let idxRow = '';
      if (idx) {
        const status = idx.ok
          ? '<span class="pill ok">ok</span>'
          : '<span class="pill err">degraded</span>';
        const rowCounts = idx.rowCounts
          ? Object.entries(idx.rowCounts).map(([k, v]) => `${k}=${v}`).join(' · ')
          : '';
        const rebuildBtn = idx.ok
          ? ''
          : '<button class="btn btn-danger btn-sm" onclick="rebuildIndex()" style="margin-left:8px;">Rebuild</button>';
        idxRow = `<div class="row">
          <div class="name">FTS5 index</div>
          <div class="dim" style="margin-left:auto;">${status} <span class="dim">${escHtml(rowCounts)}</span>${rebuildBtn}</div>
        </div>`;
      }
      root.innerHTML = okBanner + `
        <div class="card">
          <div class="row"><div class="name">Provider</div><div class="dim" style="margin-left:auto;">${escHtml(d.provider || '—')}</div></div>
          <div class="row"><div class="name">Model</div><div class="dim" style="margin-left:auto;">${escHtml(d.model || '—')}</div></div>
          <div class="row"><div class="name">API key</div><div class="dim" style="margin-left:auto;">${d.hasApiKey ? '<span class="pill ok">present</span>' : '<span class="pill warn">none</span>'}</div></div>
          <div class="row"><div class="name">Node</div><div class="dim" style="margin-left:auto;">${escHtml(d.nodeVersion || '—')}</div></div>
          <div class="row"><div class="name">Platform</div><div class="dim" style="margin-left:auto;">${escHtml(d.platform || '—')}</div></div>
          ${idxRow}
          <div class="row"><div class="name">Known providers</div><div class="dim" style="margin-left:auto;">${(d.knownProviders || []).map(escHtml).join(' · ') || '—'}</div></div>
        </div>`;
    };

    async function rebuildIndex() {
      if (!confirm('Rebuild the FTS5 index? Recall is repopulated from the existing corpus — no stored data is lost.')) return;
      try {
        const r = await apiRaw('/index/rebuild', { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { alert('Rebuild failed: ' + (body.error || r.statusText)); return; }
        alert('Index rebuilt. Re-run Doctor to confirm.');
        LOADERS.doctor();
      } catch (e) {
        alert('Rebuild failed: ' + e.message);
      }
    }

    // ── Config ───────────────────────────────────────────────────
    LOADERS.config = async function loadConfig() {
      const root = document.getElementById('config-table');
      const banner = document.getElementById('config-validate');
      const raw = document.getElementById('config-raw');
      const meta = document.getElementById('config-meta');
      root.innerHTML = '<div class="empty">Loading…</div>';
      banner.innerHTML = '';
      raw.textContent = '';
      try {
        const [cfg, validate] = await Promise.all([api('/config'), apiSoft('/config/validate')]);
        const keys = Object.keys(cfg);
        meta.textContent = `${keys.length} key${keys.length === 1 ? '' : 's'}`;
        if (validate.body) {
          const v = validate.body;
          const issues = (v.issues || []).map((i) => `<li>${escHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('');
          const warnings = (v.warnings || []).map((w) => `<li>${escHtml(typeof w === 'string' ? w : JSON.stringify(w))}</li>`).join('');
          if (v.ok && !warnings) {
            banner.innerHTML = '<div class="banner ok">Config valid.</div>';
          } else {
            const cls = v.ok ? 'warn' : 'err';
            banner.innerHTML = `<div class="banner ${cls}"><div><strong>${v.ok ? 'Warnings' : 'Validation issues'}</strong><ul>${issues}${warnings}</ul></div></div>`;
          }
        }
        if (keys.length === 0) {
          root.innerHTML = '<div class="empty">No config yet. Run <code>lazyclaw onboard</code>.</div>';
          return;
        }
        const NESTED = new Set(['customProviders', 'rates', 'authProfiles', 'authActiveProfile']);
        const rows = keys.sort().map((k) => {
          const v = cfg[k];
          const display = v && typeof v === 'object' ? JSON.stringify(v) : String(v);
          const nested = NESTED.has(k);
          const editBtn = nested
            ? `<span class="dim" style="font-size:11px;">use the dedicated tab</span>`
            : `<button class="btn btn-secondary btn-sm" data-action="cfg-edit" data-key="${escHtml(k)}">Edit</button>
               <button class="btn btn-danger btn-sm" data-action="cfg-delete" data-key="${escHtml(k)}">Delete</button>`;
          return `<tr><td><code>${escHtml(k)}</code></td><td>${escHtml(display)}</td><td>${editBtn}</td></tr>`;
        }).join('');
        root.innerHTML = `<table class="tbl">
          <thead><tr><th style="width:25%">Key</th><th>Value</th><th style="width:160px"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
        root.querySelectorAll('[data-action="cfg-edit"]').forEach((b) => {
          b.addEventListener('click', () => openConfigEditModal(b.dataset.key, cfg[b.dataset.key]));
        });
        root.querySelectorAll('[data-action="cfg-delete"]').forEach((b) => {
          b.addEventListener('click', () => deleteConfigKey(b.dataset.key));
        });
        raw.textContent = JSON.stringify(cfg, null, 2);
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    function openConfigEditModal(existingKey = '', existingValue = '') {
      // Stringify for the editor; objects/arrays become JSON, primitives stay
      // raw. Submitter parses JSON when the value looks like JSON, else
      // sends a string verbatim — same behaviour as `lazyclaw config set`.
      let display = '';
      if (typeof existingValue === 'string') display = existingValue;
      else if (existingValue == null) display = '';
      else display = JSON.stringify(existingValue, null, 2);
      openModal({
        title: existingKey ? `Edit config — ${existingKey}` : 'Set config key',
        bodyHtml: `
          <div class="dim" style="margin-bottom:12px;font-size:12px;">
            Mirrors <code>lazyclaw config set &lt;key&gt; &lt;value&gt;</code>. Values that look like
            JSON (start with <code>{</code> / <code>[</code> / <code>"</code> / <code>true</code> / <code>false</code> / a number)
            are parsed; everything else is stored as a plain string. Nested
            stores (<code>customProviders</code>, <code>rates</code>, <code>authProfiles</code>) have their own
            tabs — this form rejects them.
          </div>
          <div class="form-row">
            <label for="cfg-key">Key</label>
            <input id="cfg-key" placeholder="provider · model · api-key · skills · …" value="${escHtml(existingKey)}" ${existingKey ? 'readonly' : ''}/>
          </div>
          <div class="form-row">
            <label for="cfg-value">Value</label>
            <textarea id="cfg-value" rows="6">${escHtml(display)}</textarea>
          </div>
          <div id="cfg-status" class="dim" style="font-size:12px;"></div>
        `,
        footHtml: `
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn" onclick="submitConfigEdit()">Save</button>
        `,
      });
    }

    async function submitConfigEdit() {
      const key = document.getElementById('cfg-key').value.trim();
      const raw = document.getElementById('cfg-value').value;
      const status = document.getElementById('cfg-status');
      if (!key) { status.style.color = 'var(--err)'; status.textContent = 'Key is required.'; return; }
      // Heuristic JSON parse — same surface as the CLI: try parse; if it
      // throws, send the raw string. Numbers / true / false / null / objects /
      // arrays / quoted strings end up correctly typed.
      let value;
      const trimmed = raw.trim();
      if (trimmed === '') value = '';
      else {
        try { value = JSON.parse(trimmed); }
        catch { value = raw; }
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
          const issues = (body.issues || []).map(i => typeof i === 'string' ? i : JSON.stringify(i)).join('; ');
          status.textContent = `✗ ${body.error || issues || `${r.status} ${r.statusText}`}`;
          return;
        }
        status.style.color = 'var(--ok)';
        status.textContent = '✓ saved';
        setTimeout(() => { closeModal(); LOADERS.config(); }, 600);
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
        LOADERS.config();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    }

    // ── Multi-agent loaders (Phase 15) ────────────────────────────
    // Keep these minimal — list view + prompt-driven create. Phase
    // 15.1+ can swap the prompts for inline forms once the data model
    // settles. The point of v0.1 is parity with the CLI, not polish.

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    LOADERS.agents = async function loadAgents() {
      const root = document.getElementById('agents-list');
      try {
        const arr = await api('/agents');
        document.getElementById('agents-meta').textContent = `${arr.length} agent(s)`;
        if (arr.length === 0) { root.innerHTML = '<div class="empty">No agents yet — click + New agent to create one.</div>'; return; }
        root.innerHTML = '<table><thead><tr><th>name</th><th>provider/model</th><th>tools</th><th>role (excerpt)</th><th></th></tr></thead><tbody>'
          + arr.map((a) => {
              const provLine = a.model ? `${escapeHtml(a.provider)}/${escapeHtml(a.model)}` : escapeHtml(a.provider);
              const role = a.role ? (a.role.slice(0, 60) + (a.role.length > 60 ? '…' : '')) : '<span class="dim">(none)</span>';
              return `<tr>
                <td><strong>${escapeHtml(a.name)}</strong><br><span class="dim">${escapeHtml(a.displayName || '')}</span></td>
                <td>${provLine}</td>
                <td>${(a.tools || []).map((t) => `<code>${escapeHtml(t)}</code>`).join(' ')}</td>
                <td>${escapeHtml(role)}</td>
                <td><button class="btn btn-secondary" onclick="deleteAgent('${encodeURIComponent(a.name)}')">Delete</button></td>
              </tr>`;
            }).join('')
          + '</tbody></table>';
      } catch (e) {
        root.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
      }
    };

    async function openAgentModal() {
      const name = (prompt('Agent name (e.g. planner, backend, frontend):') || '').trim();
      if (!name) return;
      const role = prompt('Role / system prompt (optional):') || '';
      const provider = (prompt('Provider (anthropic / openai / gemini / claude-cli):', 'anthropic') || 'anthropic').trim();
      const model = (prompt('Model id (blank = provider default):') || '').trim();
      const toolsRaw = (prompt('Tools (comma-separated):', 'bash,read,write,grep') || '').trim();
      const tools = toolsRaw ? toolsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      try {
        await api('/agents', { method: 'POST', body: JSON.stringify({ name, role, provider, model, tools }) });
        LOADERS.agents();
      } catch (e) {
        alert('Create failed: ' + e.message);
      }
    }

    async function deleteAgent(encName) {
      const name = decodeURIComponent(encName);
      if (!confirm(`Delete agent "${name}"?`)) return;
      try { await api(`/agents/${encName}`, { method: 'DELETE' }); LOADERS.agents(); }
      catch (e) { alert('Delete failed: ' + e.message); }
    }

    LOADERS.teams = async function loadTeams() {
      const root = document.getElementById('teams-list');
      try {
        const arr = await api('/teams');
        document.getElementById('teams-meta').textContent = `${arr.length} team(s)`;
        if (arr.length === 0) { root.innerHTML = '<div class="empty">No teams yet — click + New team to create one.</div>'; return; }
        root.innerHTML = '<table><thead><tr><th>name</th><th>lead</th><th>agents</th><th>slack channel</th><th></th></tr></thead><tbody>'
          + arr.map((t) => `<tr>
              <td><strong>${escapeHtml(t.name)}</strong><br><span class="dim">${escapeHtml(t.displayName || '')}</span></td>
              <td>${escapeHtml(t.lead || '')}</td>
              <td>${(t.agents || []).map((a) => escapeHtml(a)).join(', ')}</td>
              <td>${t.slackChannel ? `<code>${escapeHtml(t.slackChannel)}</code>` : '<span class="dim">(none)</span>'}</td>
              <td><button class="btn btn-secondary" onclick="deleteTeam('${encodeURIComponent(t.name)}')">Delete</button></td>
            </tr>`).join('')
          + '</tbody></table>';
      } catch (e) {
        root.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
      }
    };

    async function openTeamModal() {
      const name = (prompt('Team name (e.g. shop, growth):') || '').trim();
      if (!name) return;
      const agentsRaw = (prompt('Agents (comma-separated names):') || '').trim();
      if (!agentsRaw) return;
      const agents = agentsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const lead = (prompt(`Lead (one of ${agents.join(', ')}):`, agents[0]) || agents[0]).trim();
      const slackChannel = (prompt('Slack channel (C… id or #name, optional):') || '').trim();
      try {
        await api('/teams', { method: 'POST', body: JSON.stringify({ name, agents, lead, slackChannel }) });
        LOADERS.teams();
      } catch (e) {
        alert('Create failed: ' + e.message);
      }
    }

    async function deleteTeam(encName) {
      const name = decodeURIComponent(encName);
      if (!confirm(`Delete team "${name}"?`)) return;
      try { await api(`/teams/${encName}`, { method: 'DELETE' }); LOADERS.teams(); }
      catch (e) { alert('Delete failed: ' + e.message); }
    }

    LOADERS.tasks = async function loadTasks() {
      const root = document.getElementById('tasks-list');
      try {
        const arr = await api('/tasks');
        document.getElementById('tasks-meta').textContent = `${arr.length} task(s) (newest first)`;
        if (arr.length === 0) { root.innerHTML = '<div class="empty">No tasks yet. Run <code>lazyclaw task start --team X --title "..."</code>.</div>'; return; }
        root.innerHTML = '<table><thead><tr><th>id</th><th>title</th><th>team</th><th>lead</th><th>status</th><th>turns</th><th>opened</th><th></th></tr></thead><tbody>'
          + arr.map((t) => `<tr>
              <td><code>${escapeHtml(t.id)}</code></td>
              <td>${escapeHtml(t.title)}</td>
              <td>${escapeHtml(t.team)}</td>
              <td>${escapeHtml(t.lead)}</td>
              <td><span class="status status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
              <td>${Array.isArray(t.turns) ? t.turns.length : 0}</td>
              <td><span class="dim">${escapeHtml((t.createdAt || '').slice(0, 19))}</span></td>
              <td>
                ${t.status === 'running' || t.status === 'pending' || t.status === 'paused'
                  ? `<button class="btn btn-secondary" onclick="closeTask('${encodeURIComponent(t.id)}','done')">Mark done</button>
                     <button class="btn btn-secondary" onclick="closeTask('${encodeURIComponent(t.id)}','abandon')">Abandon</button>`
                  : ''}
              </td>
            </tr>`).join('')
          + '</tbody></table>';
      } catch (e) {
        root.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
      }
    };

    async function closeTask(encId, action) {
      const id = decodeURIComponent(encId);
      if (!confirm(`${action === 'done' ? 'Mark done' : 'Abandon'} task ${id}?`)) return;
      try { await api(`/tasks/${encId}/${action}`, { method: 'POST' }); LOADERS.tasks(); }
      catch (e) { alert(`${action} failed: ` + e.message); }
    }

    // ── Trainer / Recall / Sandbox / Channels (v5) ───────────────
    LOADERS.trainer = async function loadTrainer() {
      const root = document.getElementById('trainer-card');
      const meta = document.getElementById('trainer-meta');
      root.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await api('/trainer/status');
        meta.textContent = r.lastRunAt ? `last run ${new Date(r.lastRunAt).toLocaleString()}` : 'no runs recorded';
        const pct = (r.budget && r.callsToday != null)
          ? Math.min(100, Math.round((r.callsToday / r.budget) * 100))
          : null;
        root.innerHTML = `<div class="card">
          <div class="row"><div class="name">Provider</div><div class="dim" style="margin-left:auto;">${escHtml(r.provider || '—')}</div></div>
          <div class="row"><div class="name">Model</div><div class="dim" style="margin-left:auto;">${escHtml(r.model || '—')}</div></div>
          <div class="row"><div class="name">Schedule</div><div class="dim" style="margin-left:auto;">${escHtml(r.schedule || 'off')}</div></div>
          <div class="row"><div class="name">Recipe</div><div class="dim" style="margin-left:auto;">${escHtml(r.recipe || 'inherit')}</div></div>
          <div class="row"><div class="name">Calls today</div><div class="dim" style="margin-left:auto;">${r.callsToday ?? 0}${r.budget ? ` / ${r.budget} (${pct}%)` : ''}</div></div>
        </div>
        <p class="dim" style="margin-top:10px;font-size:13px;line-height:1.4;max-width:60ch;">Learning runs automatically after each completed agent task — trajectories are distilled into skills using the trainer provider above. There is no manual sync.</p>`;
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };
    LOADERS.recall = async function loadRecall() {
      const root = document.getElementById('recall-list');
      const meta = document.getElementById('recall-meta');
      const q = (document.getElementById('recall-q').value || '').trim();
      const scope = document.getElementById('recall-scope').value || 'all';
      if (!q) { root.innerHTML = '<div class="empty">Enter a query above.</div>'; meta.textContent = ''; return; }
      root.innerHTML = '<div class="empty">Searching…</div>';
      try {
        const qs = new URLSearchParams({ q });
        if (scope && scope !== 'all') qs.set('scope', scope);
        const r = await api('/recall?' + qs.toString());
        const hits = r.hits || [];
        meta.textContent = `${hits.length} hit${hits.length === 1 ? '' : 's'} · ${r.latencyMs?.toFixed(1) ?? '?'} ms`;
        if (!hits.length) { root.innerHTML = '<div class="empty">No matches.</div>'; return; }
        root.innerHTML = hits.map((h) => {
          const md = h.metadata || {};
          const label = md.session_id || md.skill_name || md.trajectory_id || md.topic || '—';
          return `<div class="card">
            <div class="row" style="border:0;padding:0;">
              <span class="pill" style="background:rgba(217,179,90,0.18);color:var(--accent);">${escHtml(h.scope)}</span>
              <div class="name" style="margin-left:8px;">${escHtml(String(label))}</div>
              <div class="dim row-actions">bm25 ${Number(h.bm25 || 0).toFixed(2)}</div>
            </div>
            <div class="dim" style="margin-top:6px;font-size:12px;">${escHtml(h.snippet || '').replace(/&lt;mark&gt;/g,'<mark>').replace(/&lt;\/mark&gt;/g,'</mark>')}</div>
          </div>`;
        }).join('');
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };
    // Wire Enter-to-search.
    document.getElementById('recall-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); LOADERS.recall(); }
    });

    LOADERS.sandbox = async function loadSandbox() {
      const root = document.getElementById('sandbox-list');
      const meta = document.getElementById('sandbox-meta');
      root.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await api('/sandbox');
        const profiles = r.profiles || [];
        meta.textContent = `active: ${r.active || 'local'}`;
        root.innerHTML = profiles.map((p) => {
          const isActive = p.name === r.active;
          return `<div class="card">
            <div class="row" style="border:0;padding:0;">
              <div class="name">${escHtml(p.name)}</div>
              ${isActive ? '<span class="pill ok">active</span>' : ''}
              ${p.configured ? '' : '<span class="pill warn">unconfigured</span>'}
              <div class="dim row-actions">${escHtml(p.summary || '')}</div>
              <button class="btn btn-secondary btn-sm" data-action="test" data-name="${escHtml(p.name)}">Test</button>
              ${isActive ? '' : `<button class="btn btn-sm" data-action="use" data-name="${escHtml(p.name)}">Use</button>`}
            </div>
            <div class="dim" data-test-result="${escHtml(p.name)}" style="margin-top:6px;font-size:11px;"></div>
          </div>`;
        }).join('');
        root.querySelectorAll('button[data-action="test"]').forEach((b) => {
          b.addEventListener('click', () => sandboxTest(b.dataset.name));
        });
        root.querySelectorAll('button[data-action="use"]').forEach((b) => {
          b.addEventListener('click', () => sandboxUse(b.dataset.name));
        });
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };
    async function sandboxTest(name) {
      const out = document.querySelector(`[data-test-result="${name}"]`);
      if (!out) return;
      out.textContent = '⏳ testing…';
      out.style.color = 'var(--dim)';
      try {
        const r = await apiRaw('/sandbox/' + encodeURIComponent(name) + '/test', { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (body.ok) {
          out.style.color = 'var(--ok)';
          out.textContent = `✓ ok · ${body.durationMs || '?'}ms · ${String(body.stdout || '').slice(0, 80)}`;
        } else {
          out.style.color = 'var(--err)';
          out.textContent = `✗ ${body.error || 'failed'}`;
        }
      } catch (e) {
        out.style.color = 'var(--err)';
        out.textContent = '✗ ' + e.message;
      }
    }
    async function sandboxUse(name) {
      try {
        const r = await apiRaw('/sandbox/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
        if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Failed: ' + (e.error || r.statusText)); return; }
        LOADERS.sandbox();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    LOADERS.channels = async function loadChannels() {
      const root = document.getElementById('channels-list');
      const meta = document.getElementById('channels-meta');
      root.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await api('/channels');
        const arr = r.channels || [];
        meta.textContent = `${arr.length} channel${arr.length === 1 ? '' : 's'}`;
        if (!arr.length) { root.innerHTML = '<div class="empty">No channels configured. Configure via <code>lazyclaw config set channels.&lt;name&gt; ...</code>.</div>'; return; }
        root.innerHTML = arr.map((c) => `<div class="card">
          <div class="row" style="border:0;padding:0;">
            <div class="name">${escHtml(c.name)}</div>
            ${c.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill warn">disabled</span>'}
            <div class="dim row-actions">${c.boundAgent ? 'agent: ' + escHtml(c.boundAgent) : '<span class="dim">no binding</span>'}</div>
          </div>
          <div class="dim" style="margin-top:6px;font-size:12px;">
            last inbound: ${c.lastInboundAt ? new Date(c.lastInboundAt).toLocaleString() : '—'}
          </div>
        </div>`).join('');
      } catch (e) {
        root.innerHTML = `<div class="empty">⚠ ${escHtml(e.message)}</div>`;
      }
    };

    // ── Team Live tab ─────────────────────────────────────────────
    // Real-time view of an agent team: avatar tiles with status rings +
    // harness badges, click-to-drill-down, and live A→B delegation pulses,
    // driven by the GET /events SSE stream (read via fetch so the bearer token
    // still rides in the Authorization header — EventSource cannot set headers).
    const TEAM = { team: null, agentsById: {}, status: {}, activity: {}, task: null, selected: null, streaming: false };

    function harnessLabel(rec) {
      const p = (rec && rec.provider) || '?';
      const m = (rec && rec.model) || '';
      return m ? `${p} · ${m}` : p;
    }
    function avatarGlyph(rec) {
      if (rec && rec.iconEmoji) return rec.iconEmoji;
      return (((rec && rec.name) || '?').slice(0, 1)).toUpperCase();
    }
    // Map an agent to one of the 20 pixel-art role avatars (web/avatars/NN.png).
    // Explicit agent.avatar (1..20) wins; otherwise infer from name/role/tags by
    // keyword (specific roles first so "data engineer" beats "data"); else PM.
    const AVATAR_ROLES = [
      [2, ['backend', 'back-end', 'back end', '백엔드', 'server', 'api']],
      [3, ['frontend', 'front-end', 'front end', '프론트', 'react', 'vue', 'css']],
      [7, ['data engineer', 'data-engineer', 'dataeng', '데이터 엔지니어', '데이터엔지니어', 'etl', 'pipeline']],
      [4, ['devops', 'infra', '인프라', '데브옵스', 'sre', 'kubernetes', 'k8s', 'ops']],
      [5, ['qa', 'tester', 'test engineer', '테스트', '품질', 'quality']],
      [6, ['analyst', 'analytics', '분석', 'bi']],
      [8, ['research', '리서치', '조사', 'scholar']],
      [9, ['ux', 'ui design', 'designer', '디자이너', '디자인', 'design']],
      [10, ['copywriter', 'copy', 'content writer', '카피', '콘텐츠', 'writer']],
      [11, ['marketer', 'marketing', 'growth', '마케터', '마케팅', '그로스']],
      [12, ['seo']],
      [13, ['sales', '영업', '세일즈']],
      [14, ['support', 'customer', '고객', 'cs ', 'helpdesk']],
      [15, ['legal', 'compliance', '법무', '컴플라이언스']],
      [16, ['finance', 'account', '재무', '회계']],
      [17, ['security', '보안', 'sec ', 'infosec', 'appsec']],
      [18, ['tech writer', 'documentation', 'docs', '테크니컬', '문서']],
      [19, ['code review', 'reviewer', '리뷰', '코드 리뷰']],
      [20, ['orchestrat', '오케스트레이터', '코디네이터', '총괄', 'conductor']],
      [1, ['pm', 'product', 'planner', '기획', 'manager', 'coordinator', 'lead']],
    ];
    function avatarIndexFor(rec) {
      const explicit = rec && Number(rec.avatar);
      if (explicit >= 1 && explicit <= 20) return explicit;
      const hay = [rec && rec.name, rec && rec.displayName, rec && rec.role, ...(rec && rec.tags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      for (const [idx, keys] of AVATAR_ROLES) {
        if (keys.some((k) => hay.includes(k))) return idx;
      }
      return 1; // generic PM look
    }
    // A user-supplied custom image (set via `lazyclaw agent set-avatar`) wins
    // over the picked/inferred built-in sprite. rec.avatarImage is already a
    // ready-to-use src (a remote URL or a daemon-served /agent-avatars/ path).
    function avatarSrc(rec) {
      if (rec && rec.avatarImage) return rec.avatarImage;
      return `/avatars/${String(avatarIndexFor(rec)).padStart(2, '0')}.png`;
    }
    // Build the { name, children[] } tree rooted at the lead (mirrors teamTree).
    function buildTeamTree(team, byId) {
      const lead = team.lead;
      const members = team.agents || [];
      const kids = {};
      for (const n of members) {
        if (n === lead) continue;
        const rec = byId[n];
        const mgr = rec && rec.manager && members.includes(rec.manager) && rec.manager !== n ? rec.manager : lead;
        (kids[mgr] = kids[mgr] || []).push(n);
      }
      const build = (name, seen) => {
        if (seen.has(name)) return null;
        const next = new Set(seen); next.add(name);
        return { name, children: (kids[name] || []).sort().map((c) => build(c, next)).filter(Boolean) };
      };
      return build(lead, new Set());
    }
    function renderAgentTile(name) {
      const rec = TEAM.agentsById[name] || { name };
      const st = TEAM.status[name] || 'idle';
      const btn = document.createElement('button');
      btn.className = `tagent ${st}`;
      btn.dataset.agent = name;
      btn.setAttribute('role', 'treeitem');
      btn.setAttribute('aria-selected', String(TEAM.selected === name));
      btn.innerHTML =
        `<div class="tagent-avatar" aria-hidden="true"><span class="tagent-glyph">${escapeHtml(avatarGlyph(rec))}</span><img src="${avatarSrc(rec)}" alt="" onerror="this.remove()"></div>` +
        `<div class="tagent-name">${escapeHtml(rec.displayName || name)}</div>` +
        `<div class="tagent-status">${st === 'working' ? '● working' : '○ idle'}</div>` +
        `<div class="harness-badge">${escapeHtml(harnessLabel(rec))}</div>`;
      btn.addEventListener('click', () => selectTeamAgent(name));
      return btn;
    }
    function renderTeamCanvas() {
      const canvas = document.getElementById('team-canvas');
      if (!canvas) return;
      if (!TEAM.team) { canvas.innerHTML = '<div class="empty">No team selected.</div>'; return; }
      const tree = buildTeamTree(TEAM.team, TEAM.agentsById);
      canvas.innerHTML = '';
      if (!tree) { canvas.innerHTML = '<div class="empty">This team has no lead.</div>'; return; }
      const leadRow = document.createElement('div'); leadRow.className = 'team-row';
      leadRow.appendChild(renderAgentTile(tree.name));
      canvas.appendChild(leadRow);
      const flat = [];
      (function walk(n) { for (const c of n.children) { flat.push(c.name); walk(c); } })(tree);
      if (flat.length) {
        const wrap = document.createElement('div'); wrap.className = 'team-children';
        const row = document.createElement('div'); row.className = 'team-row';
        for (const n of flat) row.appendChild(renderAgentTile(n));
        wrap.appendChild(row);
        canvas.appendChild(wrap);
      }
    }
    function selectTeamAgent(name) {
      TEAM.selected = name;
      document.querySelectorAll('#team-canvas .tagent').forEach((el) => {
        el.setAttribute('aria-selected', String(el.dataset.agent === name));
      });
      renderTeamDetail();
    }
    function renderTeamDetail() {
      const panel = document.getElementById('team-detail');
      if (!panel) return;
      const name = TEAM.selected;
      if (!name) { panel.innerHTML = '<div class="empty">Click an agent to see its harness and what it\'s working on.</div>'; return; }
      const rec = TEAM.agentsById[name] || { name };
      const st = TEAM.status[name] || 'idle';
      const acts = (TEAM.activity[name] || []).slice(-8).reverse();
      panel.innerHTML =
        `<h3><img class="detail-avatar" src="${avatarSrc(rec)}" alt="" onerror="this.remove()">${escapeHtml(rec.displayName || name)} <span class="tagent-status ${st}">${st === 'working' ? '● working' : '○ idle'}</span></h3>` +
        `<div class="kv"><span class="label">harness</span><div><span class="harness-badge">${escapeHtml(harnessLabel(rec))}</span></div></div>` +
        `<div class="kv"><span class="label">role</span><div class="dim">${escapeHtml((rec.role || '').slice(0, 120) || '(none)')}</div></div>` +
        `<div class="kv"><span class="label">current task</span><div>${escapeHtml(TEAM.task || '(idle)')}</div></div>` +
        `<div class="kv"><span class="label">recent activity</span>` +
          (acts.length ? acts.map((a) => `<div class="activity">▸ ${escapeHtml(a)}</div>`).join('') : '<div class="dim">no activity yet</div>') +
        '</div>';
    }
    function teamFeedAdd(html) {
      const ul = document.getElementById('team-feed');
      if (!ul) return;
      const li = document.createElement('li');
      li.innerHTML = html;
      ul.prepend(li);
      while (ul.children.length > 40) ul.removeChild(ul.lastChild);
    }
    function pulseAgent(name) {
      const el = document.querySelector(`#team-canvas .tagent[data-agent="${CSS.escape(name)}"]`);
      if (!el) return;
      el.classList.add('delegating');
      setTimeout(() => el.classList.remove('delegating'), 950);
    }
    function inThisTeam(name) { return !!(TEAM.team && (TEAM.team.agents || []).includes(name)); }
    function setAgentStatus(name, status) {
      TEAM.status[name] = status === 'working' ? 'working' : 'idle';
      const el = document.querySelector(`#team-canvas .tagent[data-agent="${CSS.escape(name)}"]`);
      if (el) {
        el.classList.toggle('working', status === 'working');
        el.classList.toggle('idle', status !== 'working');
        const s = el.querySelector('.tagent-status');
        if (s) s.textContent = status === 'working' ? '● working' : '○ idle';
      }
      if (TEAM.selected === name) renderTeamDetail();
    }
    function onTeamEvent(type, d) {
      if (type === 'task.start') { TEAM.task = d.title || '(task)'; teamFeedAdd(`<span class="who">task</span> started: ${escapeHtml(d.title || '')}`); renderTeamDetail(); return; }
      if (type === 'task.done') { TEAM.task = null; teamFeedAdd(`<span class="who">task</span> ${escapeHtml(d.status || 'done')}`); renderTeamDetail(); return; }
      if (type === 'agent.status' && inThisTeam(d.agent)) { setAgentStatus(d.agent, d.status); return; }
      if (type === 'turn.start' && inThisTeam(d.agent)) { (TEAM.activity[d.agent] = TEAM.activity[d.agent] || []).push('turn started'); if (TEAM.selected === d.agent) renderTeamDetail(); return; }
      if (type === 'tool.call' && inThisTeam(d.agent)) {
        (TEAM.activity[d.agent] = TEAM.activity[d.agent] || []).push(`tool: ${d.tool}${d.ok === false ? ' ✗' : ''}`);
        teamFeedAdd(`<span class="who">${escapeHtml(d.agent)}</span> ${escapeHtml(d.tool)}${d.ok === false ? ' ✗' : ''}`);
        if (TEAM.selected === d.agent) renderTeamDetail();
        return;
      }
      if (type === 'delegate' && (inThisTeam(d.from) || inThisTeam(d.to))) {
        teamFeedAdd(`<span class="who">${escapeHtml(d.from || '?')}</span> <span class="arrow">→</span> <span class="who">${escapeHtml(d.to || '?')}</span>`);
        if (inThisTeam(d.to)) pulseAgent(d.to);
      }
    }
    async function startTeamStream() {
      if (TEAM.streaming) return;
      TEAM.streaming = true;
      const conn = document.getElementById('team-conn');
      try {
        const r = await apiRaw('/events', {});
        if (!r.ok || !r.body) { if (conn) conn.textContent = '○ events unavailable'; TEAM.streaming = false; return; }
        if (conn) conn.textContent = '● live';
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            let ev = 'message', data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (data) { try { onTeamEvent(ev, JSON.parse(data)); } catch (_) { /* skip bad frame */ } }
          }
        }
      } catch (_) {
        if (conn) conn.textContent = '○ disconnected';
      }
      TEAM.streaming = false;
    }
    LOADERS.team = async function loadTeam() {
      const sel = document.getElementById('team-select');
      try {
        const [teams, agents] = await Promise.all([api('/teams'), api('/agents')]);
        const byId = {}; for (const a of agents) byId[a.name] = a;
        if (!teams.length) {
          document.getElementById('team-canvas').innerHTML = '<div class="empty">No teams yet — create one in the Teams tab.</div>';
          return;
        }
        const cur = sel.value || teams[0].name;
        sel.innerHTML = teams.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.displayName || t.name)}</option>`).join('');
        sel.value = teams.some((t) => t.name === cur) ? cur : teams[0].name;
        if (!sel._wired) { sel.addEventListener('change', () => LOADERS.team()); sel._wired = true; }
        TEAM.team = teams.find((t) => t.name === sel.value) || teams[0];
        TEAM.agentsById = byId;
        renderTeamCanvas();
        renderTeamDetail();
        startTeamStream(); // idempotent — one persistent SSE reader
      } catch (e) {
        document.getElementById('team-canvas').innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
      }
    };

    // First load = chat tab.
    LOADERS.chat();

    // ── Chat send ─────────────────────────────────────────────────
    let chatHistory = []; // [{role, text}]
    function resetChat() {
      chatHistory = [];
      const stream = document.getElementById('chat-stream');
      stream.innerHTML = '<div class="empty">Type below to start.</div>';
      document.getElementById('chat-meta').textContent = '';
    }
    function appendMsg(role, text) {
      const stream = document.getElementById('chat-stream');
      // First message kicks the empty placeholder.
      if (stream.querySelector('.empty')) stream.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = text;
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
      return div;
    }
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    async function sendChat() {
      const ta = document.getElementById('chat-input');
      const text = ta.value.trim();
      if (!text) return;
      const assignee = document.getElementById('chat-assignee').value;
      if (!assignee) {
        appendMsg('error', 'No provider selected. Run `lazyclaw onboard` first.');
        return;
      }
      ta.value = '';
      appendMsg('user', text);
      chatHistory.push({ role: 'user', text });
      const meta = document.getElementById('chat-meta');
      meta.textContent = '⏳ thinking…';
      const t0 = Date.now();
      try {
        // Daemon's POST /agent: { prompt, provider, model, ... }
        // Returns { text, provider, model, durationMs, ... }.
        const [provName, modelName] = assignee.includes(':') ? assignee.split(':', 2) : [assignee, ''];
        const body = { prompt: buildAgentPrompt(text), provider: provName };
        if (modelName) body.model = modelName;
        const r = await api('/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        // Daemon's POST /agent returns { reply, usage?, cost? }. Older
        // drafts used { text } / { output }; accept any of them so a
        // dashboard hitting an older or newer daemon both work.
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
    function buildAgentPrompt(latestUserText) {
      // Flat conversation prompt: previous turns + the new user message.
      // The daemon's /agent endpoint is one-shot, so we stuff prior
      // turns into the prompt body. Keeps the dashboard stateless.
      if (chatHistory.length <= 1) return latestUserText;
      const lines = [];
      for (const m of chatHistory.slice(-12, -1)) {
        lines.push((m.role === 'user' ? 'User:' : 'Assistant:') + ' ' + m.text);
      }
      lines.push('User: ' + latestUserText);
      lines.push('Assistant:');
      return lines.join('\n\n');
    }
