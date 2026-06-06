// Interactive TUI helpers — readline pickers, banner/mascot renderers,
// arrow-key menu, provider/model selection, and the _quickPrompt line reader.
// Extracted from cli.mjs in Phase D4. Lives in tui/ so banner asset imports
// are siblings (./banner.generated.mjs, ./wordmark.mjs).
import { readConfig, writeConfig, _resolveAuthKey } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { bucketProviders as _bucketProviders } from './provider_families.mjs';
import { addCustomProvider } from '../providers/custom_provider.mjs';
import {
  modelCatalogueFor as _modelCatalogueResolve,
  fetchModelsForProvider as _fetchModelsResolve,
  supportsLiveFetch as _supportsLiveFetch,
} from '../providers/model_catalogue.mjs';

export function _attachGhostAutocomplete(rl) {
  // Returns `{ dispose, suspend, resume }`. Dispose detaches the
  // keypress + rl 'line' listeners (failure to do so leaks the
  // event-loop ref, which is exactly the slow-exit bug v3.92
  // fixed). Suspend / resume gate the keypress handler so the
  // streaming chat output isn't interleaved with `\x1b[s\x1b[K\x1b[u`
  // ghost-render escapes — that interleaving is what surfaces as
  // visible gaps between Korean characters in long replies.
  const noop = () => {};
  if (!process.stdout.isTTY) return { dispose: noop, suspend: noop, resume: noop };
  const cmds = SLASH_COMMANDS.map((c) => c.cmd);
  let lastGhost = '';
  let suspended = false;
  // Find the longest match for the current input. Returns '' when
  // nothing matches or when the input already equals a command.
  const findMatch = () => {
    const buf = rl.line || '';
    if (!buf.startsWith('/')) return '';
    const exact = cmds.find((c) => c === buf);
    if (exact) return '';
    const hits = cmds.filter((c) => c.startsWith(buf) && c.length > buf.length);
    if (!hits.length) return '';
    return hits[0]; // first match is the shortest matching command
  };
  // Render the ghost after the user's cursor. We use ANSI save/restore
  // (\x1b[s / \x1b[u) so writing the suggestion doesn't move readline's
  // notion of where the cursor is; we just paint the dim text and snap
  // back. \x1b[K clears any leftover ghost from the previous keystroke.
  const render = () => {
    if (!process.stdout.isTTY) return;
    const match = findMatch();
    const buf = rl.line || '';
    // Always clear leftover ghost first.
    process.stdout.write('\x1b[s\x1b[K');
    if (match && match.length > buf.length) {
      const tail = match.slice(buf.length);
      process.stdout.write(`\x1b[2m${tail}\x1b[0m`);
      lastGhost = match;
    } else {
      lastGhost = '';
    }
    process.stdout.write('\x1b[u');
  };
  // Intercept Right-arrow at end-of-line to accept the suggestion.
  // We attach as a prependListener so we run before readline's own
  // handler — when we accept, we mutate rl.line ourselves and call
  // _refreshLine, then return without forwarding the keypress.
  const onKeypress = (_str, key) => {
    if (!key) return;
    // While a streaming response is being printed, do nothing —
    // any ANSI cursor save / restore we emit would tear the wide-
    // character (CJK) output apart on the visible terminal.
    if (suspended) return;
    if (key.name === 'right' && lastGhost && rl.line === rl.line.trim() &&
        rl.cursor === (rl.line || '').length && (rl.line || '').length < lastGhost.length) {
      const accepted = lastGhost;
      // Clear the dim ghost before redrawing the line (otherwise the
      // residue overlaps the new line content).
      process.stdout.write('\x1b[s\x1b[K\x1b[u');
      rl.line = accepted;
      rl.cursor = accepted.length;
      // _refreshLine is private but stable across Node 18+ readline
      // implementations. Falls back to manual redraw if it ever changes.
      if (typeof rl._refreshLine === 'function') rl._refreshLine();
      else { process.stdout.write('\r\x1b[K' + (rl._prompt || '') + accepted); }
      lastGhost = '';
      return;
    }
    // For any other key, schedule the ghost re-render after readline
    // has updated rl.line. setImmediate runs after readline's keypress
    // handler completes.
    setImmediate(render);
  };
  process.stdin.on('keypress', onKeypress);
  // Clear ghost on each new prompt so a stale dim hint doesn't carry
  // over between turns.
  const onLine = () => { lastGhost = ''; };
  rl.on('line', onLine);
  const dispose = () => {
    try { process.stdin.removeListener('keypress', onKeypress); } catch (_) {}
    try { rl.removeListener('line', onLine); } catch (_) {}
    // Wipe any leftover ghost on screen so the user's terminal doesn't
    // keep a dim suffix after we exit.
    try { process.stdout.write('\x1b[s\x1b[K\x1b[u'); } catch (_) {}
  };
  return {
    dispose,
    suspend: () => {
      suspended = true;
      // Wipe any half-rendered ghost before streaming starts so the
      // first chunk lands at the same column as the prompt.
      try { process.stdout.write('\x1b[s\x1b[K\x1b[u'); } catch (_) {}
    },
    resume: () => { suspended = false; },
  };
}

// LazyClaw banner — printed once at the top of every interactive chat
// session so users see the active provider/model before they start
// typing. Plain ANSI; auto-skipped when stdout isn't a TTY (so piped
// invocations stay clean for tests/scripts).
// Single source of truth for the LazyClaw banner — used by the chat
// REPL header, the no-arg launcher, and the first-run welcome panel.
// Returns an array of pre-formatted lines (with ANSI colour) so the
// caller can splice in additional rows without re-implementing the
// alignment.
//
// Width-management rule: every inner line is forced through
// `.padEnd(W)` so a stray width miscount can't punch the right
// border off the box (which is exactly the bug v3.99.5 shipped:
// v4.2.2 — boxed figlet "lazy" wordmark, single-colour orange. The
// previous mixed-colour banner (helmet-red letter art + ink-beige
// caption) read as "two banners glued together" because the colour
// changed mid-box. We use one warm orange (#F08246) for everything —
// border, letter art, caption — so the eye reads it as one badge.
//
// Letter art is figlet "standard" (6 rows) rather than the v3.99.11
// "small" (4 rows), because small renders as a pixel mush in most
// terminal fonts. Standard's strokes are wide enough that the
// letters read as `l a z y` even at small terminal sizes.
//
// Layout invariant: every inner row is exactly INNER_W visible cells
// (no double-width glyphs, all chars are 1 cell in any monospace
// font), so the right edge `│` always lands in the same column.
//
// _renderMascot / _renderMascotTiny are kept as stubs so any leftover
// caller doesn't crash; no state-coloured art is produced any more.

const _ORANGE_RGB = '241;130;70';  // #F18246
export function _orange(s) { return `\x1b[38;2;${_ORANGE_RGB}m${s}\x1b[0m`; }

export function _renderMascot() {
  return ['lazyclaw'];
}

export function _renderMascotTiny() {
  return 'lazyclaw';
}

// figlet "standard" "lazy", trimmed of leading blank line. Each row
// is left-padded by two spaces inside the box, and every row is then
// padded to INNER_W cells.
const _LAZY_STANDARD = [
  ' _                  ',
  '| | __ _ _____   _  ',
  '| |/ _` |_  / | | | ',
  '| | (_| |/ /| |_| | ',
  '|_|\\__,_/___|\\__, | ',
  '             |___/  ',
];

const _INNER_W = 32;  // 2 left pad + 20 letter art + caption headroom

export function _renderBanner(version) {
  const v = String(version || '?.?.?');
  const cap = `  LazyClaw  v${v}`;
  const padInner = (s) => '  ' + s.padEnd(_INNER_W - 2, ' ');
  const wrap = (inner) => _orange('│') + _orange(inner) + _orange('│');
  const top = _orange('╭' + '─'.repeat(_INNER_W) + '╮');
  const bot = _orange('╰' + '─'.repeat(_INNER_W) + '╯');
  return [
    top,
    ..._LAZY_STANDARD.map((row) => wrap(padInner(row))),
    wrap(padInner(cap)),
    bot,
  ];
}

// v5 hero banner — ANSI Shadow LAZYCLAW wordmark stacked on top of the
// braille sloth (tui/banner.generated.mjs + tui/wordmark.mjs). Left-aligned
// with a 2-cell margin so wide terminals don't push the art to the right.
// Opt out with LAZYCLAW_LEGACY_MENU=1 to fall back to the v4 figlet box.
let _bannerAssetsCache = null;
export async function _loadBannerAssets() {
  if (_bannerAssetsCache !== null) return _bannerAssetsCache;
  try {
    const { banner } = await import('./banner.generated.mjs');
    const { wordmark } = await import('./wordmark.mjs');
    _bannerAssetsCache = { banner, wordmark };
  } catch {
    _bannerAssetsCache = null;
  }
  return _bannerAssetsCache;
}

export async function _renderV5Banner(version) {
  const a = await _loadBannerAssets();
  if (!a) return _renderBanner(version); // missing tarball asset → v4 figlet
  const v = String(version || '?.?.?');
  const rows = [];
  const palette = a.wordmark.palette || [];
  const gradient = a.wordmark.gradient || [];
  function tint(idx, s) {
    const hex = palette[idx] || '#FFB347';
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return _orange(s);
    const [, r, g, b] = m;
    const R = parseInt(r, 16), G = parseInt(g, 16), B = parseInt(b, 16);
    return `\x1b[38;2;${R};${G};${B}m${s}\x1b[0m`;
  }
  a.wordmark.rows.forEach((r, i) => rows.push(tint(gradient[i] ?? 1, '  ' + r)));
  rows.push('');
  for (const r of a.banner.rows) rows.push(_orange('  ' + r));
  rows.push(_orange('  ' + `lazyclaw v${v}`));
  return rows;
}

export function _printChatBanner(activeProvName, activeModel, version) {
  if (!process.stdout.isTTY) return;
  // Single-hue header: labels dim-orange, values/emphasis full-orange, so the
  // four caption rows below the box read as part of the same warm badge.
  const dimOrange = (s) => `\x1b[2m\x1b[38;2;${_ORANGE_RGB}m${s}\x1b[0m`;
  const orange = _orange;
  const lines = [
    '',
    ..._renderBanner(version),
    '',
    `  ${dimOrange('provider ·')} ${orange(activeProvName)}`,
    `  ${dimOrange('model    ·')} ${orange(activeModel || '(default)')}`,
    `  ${dimOrange('slash    ·')} ${orange('/help · /model · /provider · /exit')}`,
    `  ${dimOrange('hint     ·')} ${orange('→')} ${dimOrange('to accept the suggested command,')} ${orange('Tab')} ${dimOrange('to cycle')}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}


// Interactive provider/model picker. Used on first run (no config) or
// when the user passes --pick. Falls back to plain stdin reads when
// stdout isn't a TTY (CI/script callers should pass --non-interactive
// equivalents instead).
// Generic arrow-key menu used by the multi-step provider/model
// picker below. Returns the picked item, or one of the sentinel
// strings 'BACK' (Esc — caller should retry the previous step) or
// 'CANCEL' (q — caller should bail entirely). Ctrl-C exits the
// process directly, matching every other interactive prompt in the
// CLI.
//
// `items` is an array of { id, label, desc, tag }. `tag` is an
// optional pre-coloured pill (e.g. "[api key]") that lands on the
// right side of the row. `defaultIdx` lets the caller pin where the
// cursor lands; default 0.
export async function _arrowMenu({ title, subtitle, footer, items, defaultIdx = 0, searchable = false }) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-TTY fallback: print the labels on stderr and read a single
    // line of stdin. Used when somebody pipes input to `lazyclaw
    // setup` — the wizard still works, just without arrows.
    process.stderr.write(`${title}\n`);
    items.forEach((it, i) => process.stderr.write(`  ${i + 1}. ${it.label}${it.desc ? ' — ' + it.desc : ''}\n`));
    process.stderr.write('pick (number / id, blank for first): ');
    const ans = await new Promise((resolve) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n')) { process.stdin.off('data', onData); resolve(buf.trim()); }
      };
      process.stdin.on('data', onData);
    });
    if (!ans) return items[0];
    const byNum = parseInt(ans, 10);
    if (Number.isFinite(byNum) && byNum >= 1 && byNum <= items.length) return items[byNum - 1];
    const byId = items.find((it) => it.id === ans || it.label === ans);
    return byId || items[0];
  }

  const readline = await import('node:readline');
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  // A previous `readline.createInterface(...).close()` (e.g. from
  // `_quickPrompt`) leaves stdin paused — the keypress listener we
  // attach below would never fire and the menu would appear frozen
  // instead of responding to arrow keys. Resume + ref defensively
  // before drawing so the picker always receives the first keypress.
  process.stdin.resume();
  if (process.stdin.ref) process.stdin.ref();
  const accent = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

  // Typeahead state. `query` accumulates printable chars when searchable
  // is on; the visible item slice is recomputed on every keystroke. We
  // keep `defaultIdx` semantics by mapping it to the unfiltered list and
  // tracking selection inside the filtered view via the item identity.
  let query = '';
  const matchScore = (it, q) => {
    if (!q) return 0;
    const hay = `${it.label || ''}  ${it.desc || ''}  ${it.id || ''}`.toLowerCase();
    const needle = q.toLowerCase();
    if (hay.includes(needle)) return hay.indexOf(needle) === 0 ? 2 : 1;
    // simple subsequence fallback so "g4o" matches "gpt-4o".
    let i = 0; let matched = 0;
    for (const ch of hay) {
      if (ch === needle[matched]) { matched++; if (matched === needle.length) break; }
      i++;
    }
    return matched === needle.length ? 0.5 : 0;
  };
  const filterItems = () => {
    if (!searchable || !query) return items.slice();
    const scored = items
      .map((it) => ({ it, s: matchScore(it, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.it);
  };
  let view = filterItems();
  let idx = Math.max(0, Math.min(view.length - 1, defaultIdx));
  if (idx < 0) idx = 0;

  const draw = () => {
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');
    process.stdout.write(accent(title) + '\n');
    if (subtitle) process.stdout.write(dim(subtitle) + '\n');
    const help = searchable
      ? '↑/↓ to move · Enter to confirm · type to search · Esc to back · Ctrl+U to clear · q to quit'
      : '↑/↓ to move · Enter to confirm · Esc to back · q to quit';
    process.stdout.write(dim(help) + '\n');
    if (searchable) {
      const q = query ? bold(query) : dim('(type to filter)');
      process.stdout.write(dim('  search: ') + q + dim(`   ${view.length}/${items.length} match`) + '\n\n');
    } else {
      process.stdout.write('\n');
    }
    if (view.length === 0) {
      process.stdout.write('  ' + dim('(no matches — backspace or Ctrl+U to clear the filter)') + '\n');
      if (footer) process.stdout.write('\n' + dim(footer) + '\n');
      return;
    }
    const headerLines = subtitle ? 4 : 3;
    const rows = Math.max(6, (process.stdout.rows || 24) - (headerLines + (searchable ? 3 : 4)));
    let from = Math.max(0, idx - Math.floor(rows / 2));
    if (from + rows > view.length) from = Math.max(0, view.length - rows);
    const to = Math.min(view.length, from + rows);
    // Pre-compute label width so descriptions line up across rows.
    const labelW = view.reduce((w, it) => Math.max(w, (it.label || '').length), 12);
    for (let i = from; i < to; i++) {
      const it = view[i];
      const marker = i === idx ? accent('❯ ') : '  ';
      const lbl = (it.label || '').padEnd(labelW);
      const lblOut = i === idx ? bold(lbl) : lbl;
      const desc = it.desc ? '  ' + dim(it.desc) : '';
      const tag = it.tag ? '  ' + it.tag : '';
      process.stdout.write(`${marker}${lblOut}${desc}${tag}\n`);
    }
    if (to < view.length) {
      process.stdout.write(`${dim(`  …(${view.length - to} more)`)}\n`);
    }
    if (footer) process.stdout.write('\n' + dim(footer) + '\n');
  };

  draw();
  return await new Promise((resolve) => {
    const recompute = () => {
      view = filterItems();
      if (idx >= view.length) idx = Math.max(0, view.length - 1);
      draw();
    };
    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up')   { if (view.length) { idx = (idx - 1 + view.length) % view.length; draw(); } }
      else if (key.name === 'down') { if (view.length) { idx = (idx + 1) % view.length; draw(); } }
      else if (key.name === 'pageup')   { idx = Math.max(0, idx - 10); draw(); }
      else if (key.name === 'pagedown') { idx = Math.min(view.length - 1, idx + 10); draw(); }
      else if (key.name === 'home') { idx = 0; draw(); }
      else if (key.name === 'end')  { idx = view.length - 1; draw(); }
      else if (key.name === 'return') {
        if (view.length === 0) return;
        cleanup();
        resolve(view[idx]);
      }
      else if (key.ctrl && key.name === 'c') { cleanup(); process.exit(130); }
      else if (key.ctrl && key.name === 'u') { if (searchable) { query = ''; recompute(); } }
      else if (key.name === 'escape') {
        if (searchable && query) { query = ''; recompute(); return; }
        cleanup(); resolve('BACK');
      }
      else if (key.name === 'backspace') {
        if (searchable && query.length > 0) { query = query.slice(0, -1); recompute(); }
      }
      else if (searchable && str && str.length === 1 && str >= ' ' && str !== '\x7f' && !key.ctrl && !key.meta) {
        // Printable char → append to filter buffer. We deliberately do not
        // intercept 'q' as a shortcut when searchable is on, because the
        // user might be typing a model id that contains 'q'. Use Esc / Ctrl+C
        // to bail out instead.
        query += str;
        recompute();
      }
      else if (!searchable && key.name === 'q') { cleanup(); resolve('CANCEL'); }
    };
    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
    };
    process.stdin.on('keypress', onKey);
  });
}

// Bucket every registered provider into one of three auth-method
// families. The picker's first step asks the user which family
// they want before drilling into specific providers — much less
// overwhelming than a flat 40-row list. Bucket assignment lives
// here (rather than registry.mjs) because it's a UX concept, not
// an intrinsic provider attribute.
export function _providerFamilies() {
  // Membership (api/cli/mock, orchestrator excluded) is shared with the Ink
  // picker via tui/provider_families.mjs so both paths bucket identically.
  // The ANSI tags below are readline-specific, so they're applied here.
  const b = _bucketProviders(getRegistry());
  return {
    api: { label: 'API key', desc: 'paste an sk-... key during setup',  tag: '\x1b[38;5;245m[needs key]\x1b[0m', members: b.api },
    cli: { label: 'CLI / Local', desc: 'keyless — uses an existing CLI login or a local daemon', tag: '\x1b[38;5;208m[no key]\x1b[0m', members: b.cli },
    mock: { label: 'Mock', desc: 'offline echo, only useful for testing', tag: '\x1b[38;5;245m[test]\x1b[0m', members: b.mock },
  };
}

// Multi-step provider / model picker — replaces the flat 40-row
// list of v3.99.5 with a drill-in:
//
//   Step 1 — auth family (API key / CLI-Local / Mock)
//   Step 2 — provider in that family (gemini / openai / claude-cli / …)
//   Step 3 — model in that provider's suggestedModels
//
// Esc at any step goes back one. q or Ctrl-C cancels entirely.
// Steps that have only one option auto-advance so the user doesn't
// stare at a single-row menu (e.g. the Mock family has just `mock`).
export async function _pickProviderInteractive() {
  const providers = Object.keys(getRegistry().PROVIDERS);
  if (!providers.length) return { provider: 'mock', model: null };
  const info = getRegistry().PROVIDER_INFO || {};
  const families = _providerFamilies();

  // Non-TTY fallback — single-prompt picker, identical to before.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write(`provider [${providers.join('|')}]: `);
    const ans = await new Promise((resolve) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n')) { process.stdin.off('data', onData); resolve(buf.trim()); }
      };
      process.stdin.on('data', onData);
    });
    // v5.3.2 — non-TTY fallback used to be `providers[0]`, which was
    // whatever happened to be first in the registry (currently
    // anthropic). Pin to claude-cli to match the interactive onboard
    // hint at cmdOnboard (the keyless subscription path).
    return { provider: ans || 'claude-cli', model: null };
  }

  // ── Step 1 — auth family ──────────────────────────────────────
  let family = null;
  while (!family) {
    const familyItems = Object.entries(families)
      .filter(([, b]) => b.members.length > 0)
      .map(([id, b]) => {
        // Show member count + a few names instead of the full list — the
        // API-key family alone now has 12 vendors and joining all of them
        // produced an unreadable line.
        const preview = b.members.slice(0, 3).join(' / ');
        const more = b.members.length > 3 ? ` … (+${b.members.length - 3} more)` : '';
        return {
          id,
          label: b.label,
          desc: `${b.desc}  ·  ${preview}${more}`,
          tag: b.tag,
        };
      });
    const picked = await _arrowMenu({
      title: 'LazyClaw setup — Step 1 of 3:  pick how you want to auth',
      subtitle: 'API: bring your own key  ·  CLI/Local: use what\'s already on this machine  ·  Mock: offline test',
      items: familyItems,
    });
    if (picked === 'CANCEL' || picked === 'BACK') return null;
    family = picked;
  }

  // ── Step 2 — provider in that family ──────────────────────────
  let provider = null;
  while (!provider) {
    const memberNames = families[family.id].members;
    const provItems = memberNames.map((name) => {
      const meta = info[name] || {};
      const isCustom = !!meta.custom;
      const isBuiltinCompat = !!meta.builtinOpenAICompat;
      // Step-2 desc used to preview four suggested model ids per provider.
      // That made the row read like "gemini · models: gemini-2.5-pro ·
      // gemini-2.5-flash · gemini-2.0-flash · gemini-2.0-flash-thinking-exp",
      // which is too dense and partly redundant — step 3 already shows the
      // full curated list. Keep the row to a vendor label + endpoint hint.
      let desc = '';
      if (isCustom) desc = `custom · ${meta.baseUrl || ''}`;
      else if (isBuiltinCompat) desc = meta.label || meta.baseUrl || '';
      else if (meta.label && meta.label !== name) desc = meta.label;
      return {
        id: name,
        label: name,
        desc,
        tag: isCustom
          ? '\x1b[38;5;213m[custom]\x1b[0m'
          : (meta.requiresApiKey ? '\x1b[38;5;245m[api key]\x1b[0m' : '\x1b[38;5;208m[no key]\x1b[0m'),
      };
    });
    // Surface a "+ Add a new custom endpoint…" entry inside the API-key
    // family. NIM, OpenRouter, vLLM, LM Studio, Together, Groq, etc. all
    // speak the OpenAI Chat-Completions wire format — this single hook
    // covers every one of them without shipping a per-vendor provider.
    if (family.id === 'api') {
      provItems.push({
        id: '__add_custom__',
        label: '+ Add a custom OpenAI-compatible endpoint…',
        desc: 'NVIDIA NIM · OpenRouter · Together · Groq · vLLM · LM Studio · …',
        tag: '\x1b[38;5;213m[new]\x1b[0m',
      });
    }
    if (memberNames.length === 1 && family.id !== 'api') {
      // Auto-advance — no point making the user pick from a single row,
      // unless we just appended the "+ Add custom" entry above.
      provider = { id: memberNames[0] };
      break;
    }
    const picked = await _arrowMenu({
      title: `LazyClaw setup — Step 2 of 3:  pick a ${family.label} provider`,
      subtitle: `Showing ${provItems.length} ${family.label.toLowerCase()} option(s). Type to filter.`,
      items: provItems,
      searchable: true,
    });
    if (picked === 'CANCEL') return null;
    if (picked === 'BACK')   { family = null; return _pickProviderInteractive(); }
    if (picked && picked.id === '__add_custom__') {
      const added = await _addCustomProviderInteractive();
      if (!added) continue; // back to provider list
      // Force the registry to pick up the new entry and recompute the
      // family bucket for the next loop iteration.
      await ensureRegistry();
      Object.assign(families, _providerFamilies());
      provider = { id: added.name };
      break;
    }
    provider = picked;
  }

  // ── Step 3 — model picker ────────────────────────────────────────
  // v5.3.2 — the setup wizard no longer surfaces composite providers
  // (orchestrator is filtered out of _providerFamilies above), so this
  // step is just the regular model picker. The orchestrator wizard
  // (_setupOrchestratorInteractive) stays reachable via the dedicated
  // `lazyclaw orchestrator …` subcommand and an explicit
  // `--provider orchestrator` invocation.
  const picked = await _pickModelInteractive(provider.id, {
    titlePrefix: 'LazyClaw setup — Step 3 of 3:',
    onBack: 'restart',
  });
  if (picked === 'CANCEL') return null;
  if (picked === 'BACK')   return _pickProviderInteractive();
  return { provider: provider.id, model: picked };
}

// Step-3 alternative for composite providers (currently only the
// orchestrator). Builds `cfg.orchestrator = { planner, workers,
// maxSubtasks }` interactively and persists it before returning.
//
// planner: single picker over registered non-composite providers.
// workers: multi-select with a running list + add/remove/done loop.
// maxSubtasks: typed integer, default 5.
export async function _setupOrchestratorInteractive() {
  const accent = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  const ok     = (s) => `\x1b[32m${s}\x1b[0m`;
  const info = getRegistry().PROVIDER_INFO || {};
  const eligibleNames = Object.keys(getRegistry().PROVIDERS).filter((n) => n !== 'orchestrator' && n !== 'mock');
  if (eligibleNames.length === 0) {
    process.stdout.write('\n' + accent('orchestrator setup') + ': no eligible workers — register a real provider first.\n');
    await _quickPrompt('  press Enter to continue ');
    return 'CANCEL';
  }
  const cfg = readConfig();
  const existing = cfg.orchestrator && typeof cfg.orchestrator === 'object' ? cfg.orchestrator : {};

  // ── Pick planner ─────────────────────────────────────────────────
  const plannerItems = eligibleNames.map((name) => {
    const m = info[name] || {};
    const defaultModel = m.defaultModel || '';
    return {
      id: `${name}${defaultModel ? ':' + defaultModel : ''}`,
      label: m.label && m.label !== name ? `${name} — ${m.label}` : name,
      desc: defaultModel ? `default model: ${defaultModel}` : '',
    };
  });
  const plannerPick = await _arrowMenu({
    title: 'LazyClaw setup — Step 3 of 3:  orchestrator — pick the planner',
    subtitle: 'The planner decomposes the user request into subtasks and writes the final synthesis. Strong reasoning models work best here.',
    items: plannerItems,
    searchable: true,
    defaultIdx: Math.max(0, plannerItems.findIndex((p) => p.id === existing.planner)),
  });
  if (plannerPick === 'CANCEL') return 'CANCEL';
  if (plannerPick === 'BACK')   return 'BACK';
  const planner = plannerPick.id;

  // ── Pick workers (iterative add/remove) ──────────────────────────
  const workers = Array.isArray(existing.workers) ? existing.workers.slice() : [];
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(accent('Orchestrator workers') + '\n');
    process.stdout.write(dim('Subtasks are dispatched round-robin across this list.') + '\n\n');
    if (workers.length === 0) {
      process.stdout.write('  ' + dim('(none yet — add at least one)') + '\n\n');
    } else {
      workers.forEach((w, i) => {
        process.stdout.write(`  ${i + 1}. ${ok(w)}\n`);
      });
      process.stdout.write('\n');
    }
    const items = [
      { id: '__add__',    label: '+ Add a worker',     desc: 'pick from registered providers' },
      { id: '__remove__', label: '- Remove a worker',  desc: workers.length ? 'pick which entry to drop' : '(nothing to remove)' },
      { id: '__done__',   label: `Done${workers.length ? ` (${workers.length} worker${workers.length === 1 ? '' : 's'})` : ' — at least one worker required'}`, desc: workers.length ? 'save cfg.orchestrator and finish' : 'add one worker first' },
    ];
    const action = await _arrowMenu({
      title: 'LazyClaw setup — orchestrator workers',
      subtitle: `Planner: ${planner}`,
      items,
    });
    if (action === 'CANCEL') return 'CANCEL';
    if (action === 'BACK')   return 'BACK';
    if (action.id === '__add__') {
      const wPick = await _arrowMenu({
        title: 'Add worker',
        subtitle: 'Picked entries are appended to the workers list.',
        items: plannerItems.filter((p) => !workers.includes(p.id)),
        searchable: true,
      });
      if (wPick === 'CANCEL' || wPick === 'BACK') continue;
      workers.push(wPick.id);
      continue;
    }
    if (action.id === '__remove__') {
      if (!workers.length) continue;
      const rPick = await _arrowMenu({
        title: 'Remove worker',
        subtitle: 'Highlighted entry is removed from the list.',
        items: workers.map((w) => ({ id: w, label: w })),
      });
      if (rPick === 'CANCEL' || rPick === 'BACK') continue;
      const idx = workers.indexOf(rPick.id);
      if (idx >= 0) workers.splice(idx, 1);
      continue;
    }
    if (action.id === '__done__') {
      if (workers.length === 0) continue;
      break;
    }
  }

  // ── maxSubtasks ──────────────────────────────────────────────────
  const defaultMax = Number.isFinite(existing.maxSubtasks) && existing.maxSubtasks > 0
    ? Math.min(10, existing.maxSubtasks)
    : 5;
  const rawMax = (await _quickPrompt(`  ${bold('maxSubtasks')} ${dim(`(2..10, blank → ${defaultMax}):`)} `)).trim();
  let maxSubtasks = defaultMax;
  if (rawMax) {
    const n = parseInt(rawMax, 10);
    if (Number.isFinite(n) && n >= 1) maxSubtasks = Math.min(10, Math.max(1, n));
  }

  // ── Persist ──────────────────────────────────────────────────────
  cfg.orchestrator = { planner, workers, maxSubtasks };
  writeConfig(cfg);
  process.stdout.write('\n');
  process.stdout.write(`  ${ok('✓ orchestrator saved')}  ${dim('→')} ` +
    `planner ${ok(planner)}  ·  ${workers.length} worker${workers.length === 1 ? '' : 's'}  ·  maxSubtasks ${maxSubtasks}\n`);
  await _quickPrompt('  press Enter to continue ');
  return { ok: true };
}

// Pause the chat REPL's readline + ghost-autocomplete while a sub-picker
// (provider / model arrow menu) takes over the terminal. The sub-picker
// installs its own `keypress` listener and toggles raw mode; the chat's
// readline would race it for stdin if we left it active. After `body`
// returns we re-emit keypress events, restore raw mode, and re-prompt
// so the chat resumes cleanly. `body` is awaited — exceptions propagate.
export async function _pauseChatForSubMenu(rl, ghost, body) {
  if (ghost && typeof ghost.suspend === 'function') ghost.suspend();
  try { rl.pause(); } catch (_) {}
  // Drop the readline keypress hook so the picker's own listener has
  // sole ownership while it's open. We re-arm it on the way out.
  if (process.stdin.setRawMode) {
    try { process.stdin.setRawMode(false); } catch (_) {}
  }
  try {
    await body();
  } finally {
    const readline = await import('node:readline');
    try { readline.emitKeypressEvents(process.stdin); } catch (_) {}
    if (process.stdin.setRawMode && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (_) {}
    }
    process.stdin.resume();
    if (process.stdin.ref) process.stdin.ref();
    if (ghost && typeof ghost.resume === 'function') ghost.resume();
    try { rl.resume(); } catch (_) {}
    try { rl.prompt(); } catch (_) {}
  }
}

// Standalone model picker for the chat REPL's `/model` slash. Returns
// the chosen model id (string), 'BACK', or 'CANCEL'. Falls through to
// null when the provider has no curated models and no live-fetch surface
// (mock) — the caller should treat that as "use the provider default".
export async function _pickModelInteractive(providerId, opts = {}) {
  const info = getRegistry().PROVIDER_INFO || {};
  const meta = info[providerId] || {};
  const baseModels = Array.isArray(meta.suggestedModels) ? meta.suggestedModels.slice() : [];
  const isCustom = !!meta.custom;
  const isBuiltinCompat = !!meta.builtinOpenAICompat;
  const supportsLiveFetch = _supportsLiveFetch(meta, providerId);

  if (!baseModels.length && !supportsLiveFetch) return null;

  let dynamicModels = [];
  while (true) {
    const allModels = Array.from(new Set([...baseModels, ...dynamicModels]));
    const modelItems = allModels.map((m) => ({ id: m, label: m, desc: '' }));
    if (supportsLiveFetch) {
      modelItems.unshift({
        id: '__fetch_models__',
        label: '↻ Fetch live model list from /v1/models',
        desc: isCustom || isBuiltinCompat ? `GET ${meta.baseUrl}/models` : 'pulls the up-to-date catalogue from the provider',
        tag: '\x1b[38;5;245m[live]\x1b[0m',
      });
    }
    modelItems.push({
      id: '__custom_model__',
      label: '… type a custom model id',
      desc: 'use any model id supported by this provider, even if not listed above',
      tag: '\x1b[38;5;245m[free]\x1b[0m',
    });

    const defaultIdx = supportsLiveFetch
      ? Math.max(0, 1 + allModels.indexOf(meta.defaultModel || allModels[0]))
      : Math.max(0, allModels.indexOf(meta.defaultModel || allModels[0]));
    const titlePrefix = opts.titlePrefix ? `${opts.titlePrefix}  ` : '';
    const picked = await _arrowMenu({
      title: `${titlePrefix}pick a model for ${providerId}`,
      subtitle: `Type to filter ${allModels.length} model(s). Enter to confirm. Backspace clears one char, Ctrl+U clears the filter.`,
      items: modelItems,
      defaultIdx,
      searchable: true,
    });
    if (picked === 'CANCEL') return 'CANCEL';
    if (picked === 'BACK')   return 'BACK';
    if (picked.id === '__custom_model__') {
      const typed = (await _quickPrompt(`  model id for ${providerId}: `)).trim();
      if (!typed) continue;
      return typed;
    }
    if (picked.id === '__fetch_models__') {
      try {
        process.stdout.write(`\n  fetching ${providerId} model list…\n`);
        const fetched = await _fetchModelsForProvider(providerId);
        if (!fetched.length) {
          process.stdout.write(`  ${'\x1b[33m'}no models returned${'\x1b[0m'} — falling back to the suggested list.\n`);
          await _quickPrompt('  press Enter to continue ');
        } else {
          dynamicModels = fetched;
          process.stdout.write(`  fetched ${fetched.length} model(s).\n`);
          await _quickPrompt('  press Enter to pick one ');
        }
      } catch (e) {
        process.stdout.write(`\n  ${'\x1b[33m'}fetch failed:${'\x1b[0m'} ${e?.message || e}\n`);
        await _quickPrompt('  press Enter to continue ');
      }
      continue;
    }
    return picked.id;
  }
}

// Resolve {baseUrl, apiKey} for a provider so we can call /v1/models on
// its behalf. Returns null when the provider doesn't expose an OpenAI-
// compatible model catalogue (e.g. anthropic, gemini, claude-cli).
export function _modelCatalogueFor(providerId) {
  const cfg = readConfig();
  return _modelCatalogueResolve({
    cfg,
    registryMod: getRegistry(),
    resolveAuthKey: (id) => _resolveAuthKey(cfg, id),
    providerId,
  });
}

export async function _fetchModelsForProvider(providerId) {
  const cfg = readConfig();
  return _fetchModelsResolve({
    cfg,
    registryMod: getRegistry(),
    resolveAuthKey: (id) => _resolveAuthKey(cfg, id),
    providerId,
  });
}

// Walk the user through registering a new OpenAI-compatible custom
// provider (NIM, OpenRouter, vLLM, LM Studio, Together, Groq, …).
// Persists into cfg.customProviders[] and returns { name } on success,
// or null when the user backs out.
export async function _addCustomProviderInteractive() {
  const accent = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  const ok     = (s) => `\x1b[32m${s}\x1b[0m`;

  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(accent('Add a custom OpenAI-compatible endpoint') + '\n');
  process.stdout.write(dim('Works with any service that speaks the OpenAI v1 wire format.') + '\n');
  process.stdout.write(dim('Examples:') + '\n');
  process.stdout.write(dim('  · NVIDIA NIM       https://integrate.api.nvidia.com/v1') + '\n');
  process.stdout.write(dim('  · OpenRouter       https://openrouter.ai/api/v1') + '\n');
  process.stdout.write(dim('  · Together AI      https://api.together.xyz/v1') + '\n');
  process.stdout.write(dim('  · Groq             https://api.groq.com/openai/v1') + '\n');
  process.stdout.write(dim('  · vLLM / LM Studio http://localhost:8000/v1') + '\n\n');

  const { validateCustomProviderName, registerCustomProviders, fetchOpenAICompatModels, isBuiltinOpenAICompatName } = getRegistry();
  let name;
  while (true) {
    const raw = (await _quickPrompt(`  ${bold('name')} ${dim('(short id, e.g. "nim", "openrouter"):')} `)).trim();
    if (!raw) {
      process.stdout.write(dim('  cancelled — back to the picker.\n'));
      return null;
    }
    try { name = validateCustomProviderName(raw); }
    catch (e) {
      process.stdout.write(`  \x1b[33m${e.message}\x1b[0m — try again.\n`);
      continue;
    }
    // OpenAI-compat builtins (nim / openrouter / groq / …) can be overridden
    // by a custom entry of the same name — both go through
    // makeOpenAICompatProvider, so the wire format is identical and the
    // user is just pointing the same alias at a different URL/key. Surface
    // the override so it isn't a silent surprise.
    if (typeof isBuiltinOpenAICompatName === 'function' && isBuiltinOpenAICompatName(name)) {
      process.stdout.write(
        `  \x1b[2mNote: "${name}" is a built-in OpenAI-compatible provider; ` +
        `your custom entry will override the built-in baseUrl/api-key for this install. ` +
        `Remove with: lazyclaw providers remove ${name}\x1b[0m\n`
      );
    }
    break;
  }
  const baseUrlRaw = (await _quickPrompt(`  ${bold('baseUrl')} ${dim('(must end in /v1, no trailing slash needed):')} `)).trim();
  if (!baseUrlRaw) { process.stdout.write(dim('  cancelled — baseUrl is required.\n')); return null; }
  if (!/^https?:\/\//i.test(baseUrlRaw)) {
    process.stdout.write('  \x1b[33mbaseUrl must start with http:// or https://\x1b[0m — cancelled.\n');
    return null;
  }
  const apiKey = (await _quickPrompt(`  ${bold('api-key')} ${dim('(blank if the endpoint is auth-less, e.g. local vLLM):')} `)).trim();

  // Persist + hot-register + best-effort probe via the shared, unit-tested
  // core (providers/custom_provider.mjs) so this readline wizard and the Ink
  // /provider add flow can't drift. The interactive prompts above already
  // validated name + baseUrl; addCustomProvider re-validates harmlessly.
  const result = await addCustomProvider({
    registry: getRegistry(),
    readConfig,
    writeConfig,
    name,
    baseUrl: baseUrlRaw,
    apiKey,
  });
  const entry = { name: result.name, baseUrl: result.baseUrl };
  let probeMsg;
  if (result.probe.ok && result.probe.count > 0) {
    probeMsg = `  ${ok('✓')} reachable — ${result.probe.count} model(s) advertised at ${entry.baseUrl}/models\n`;
  } else if (result.probe.ok) {
    probeMsg = `  ${ok('✓')} registered — /v1/models returned no entries (will rely on free-text model id).\n`;
  } else {
    probeMsg = `  \x1b[33m!\x1b[0m registered, but /v1/models probe failed: ${result.probe.error}\n`;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${ok(bold('✓ custom provider saved:'))} ${entry.name}  ${dim('→')} ${entry.baseUrl}\n`);
  process.stdout.write(probeMsg);
  process.stdout.write(dim(`  Removable any time via:  lazyclaw providers remove ${name}\n`));
  await _quickPrompt('  press Enter to continue ');
  return { name };
}
export async function _quickPrompt(label) {
  const readline = await import('node:readline');
  process.stdout.write('\n');
  // Make sure stdin is in cooked / line-buffered mode for the
  // duration of the prompt — a prior `_arrowMenu` may have left raw
  // mode on, in which case readline.question() never fires its
  // line-event because each byte is delivered as a keypress instead.
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try { process.stdin.setRawMode(false); } catch (_) {}
  }
  process.stdin.resume();
  if (process.stdin.ref) process.stdin.ref();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((resolve) => rl.question(label, resolve));
  rl.close();
  return ans.trim();
}
