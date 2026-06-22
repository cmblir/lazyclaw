// Interactive TUI helpers — readline pickers, banner renderers, arrow-key
// menu, provider/model selection, _quickPrompt. Extracted from cli.mjs (D4);
// lives in tui/ so banner asset imports are siblings.
import { readConfig, writeConfig, _resolveAuthKey } from '../lib/config.mjs';
import { SLASH_COMMANDS } from './slash_commands.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { bucketProviders as _bucketProviders } from './provider_families.mjs';
import { addCustomProvider } from '../providers/custom_provider.mjs';
import {
  modelCatalogueFor as _modelCatalogueResolve,
  fetchModelsForProvider as _fetchModelsResolve,
  supportsLiveFetch as _supportsLiveFetch,
} from '../providers/model_catalogue.mjs';
import { paint } from './theme.mjs';
// Banner renderers live in a leaf sibling module (tui/banner.mjs). We import
// the ones pickers' own code still calls (_orange / _ORANGE_RGB in
// _printChatBanner, _loadBannerAssets / _renderBanner / _orange in
// _renderV5Banner) and re-export the public surface so existing importers
// (cli.mjs / commands/setup.mjs / commands/chat.mjs) keep resolving them here.
import {
  _ORANGE_RGB,
  _orange,
  _renderBanner,
  _loadBannerAssets,
} from './banner.mjs';
export {
  _orange,
  _renderMascot,
  _renderMascotTiny,
  _renderBanner,
  _loadBannerAssets,
} from './banner.mjs';

// Read exactly ONE line from a non-TTY stream (piped stdin) and hand the rest
// back so the next reader (the next picker / a credential prompt) still gets
// its input. The old fallbacks resolved the whole buffered payload at the
// first newline — matching no id (skip) and swallowing every later line so the
// following prompt hung. Pause before unshift so the buffered remainder isn't
// dropped while no 'data' listener is attached.
export function _readOneLine(stream) {
  return new Promise((resolve) => {
    let buf = '';
    const done = (line) => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      resolve(line.replace(/\r$/, '').trim());
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      stream.pause();
      const rest = buf.slice(nl + 1);
      if (rest) stream.unshift(Buffer.from(rest, 'utf8'));
      done(buf.slice(0, nl));
    };
    const onEnd = () => done(buf);
    stream.on('data', onData);
    stream.on('end', onEnd);
    // A prior _readOneLine pauses the stream after unshifting its remainder.
    // Adding a 'data' listener does NOT auto-resume an explicitly-paused
    // stream, so resume() here or the next read would block on buffered input.
    stream.resume();
  });
}

export function _attachGhostAutocomplete(rl) {
  // Returns `{ dispose, suspend, resume }`. Dispose detaches the keypress +
  // rl 'line' listeners (leaking them is the v3.92 slow-exit bug). Suspend /
  // resume gate the keypress handler so streaming chat output isn't
  // interleaved with `\x1b[s\x1b[K\x1b[u` ghost-render escapes — that
  // interleaving surfaced as visible gaps between Korean characters.
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

// Banner renderers (_ORANGE_RGB / _orange / _renderMascot / _renderMascotTiny
// / _renderBanner / _loadBannerAssets) moved to tui/banner.mjs — imported at
// the top of this file and re-exported there for existing callers. The v5
// splash composer and chat header below still live here because they read
// pickers-local state and stay close to the wizard that prints them.

// v5 hero banner — ANSI Shadow LAZYCLAW wordmark stacked on top of the
// braille sloth (tui/banner.generated.mjs + tui/wordmark.mjs). Left-aligned
// with a 2-cell margin so wide terminals don't push the art to the right.
// Opt out with LAZYCLAW_LEGACY_MENU=1 to fall back to the v4 figlet box.
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

export async function _printChatBanner(activeProvName, activeModel, version) {
  if (!process.stdout.isTTY) return;
  // Single-hue header: labels dim-orange, values/emphasis full-orange. Uses
  // the v5 sloth splash (NOT the retired v4 figlet box — see _renderV5Banner;
  // figlet remains only as the missing-asset last resort).
  const dimOrange = (s) => `\x1b[2m\x1b[38;2;${_ORANGE_RGB}m${s}\x1b[0m`;
  const orange = _orange;
  const lines = [
    '',
    ...(await _renderV5Banner(version)),
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
    const ans = await _readOneLine(process.stdin);
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
  // Render on the ALTERNATE screen buffer (the same trick vim / less / fzf
  // use). Without it, the menu's full-screen \x1b[2J clears land on the main
  // buffer, interleave with the readline output from prior wizard steps, and
  // every step pushes a screenful into scrollback — the "화면이 밀린다" bug.
  // On the alt buffer the menu draws in isolation; leaving it (cleanup) restores
  // the main buffer (and the wizard text on it) verbatim, with nothing pushed.
  const altScreen = !!(process.stdout.isTTY);
  if (altScreen) process.stdout.write('\x1b[?1049h');
  // Menu chrome via the theme gate: plain text under NO_COLOR / dumb / non-TTY.
  const accent = (s) => paint('38;5;208', s);
  const dim    = (s) => paint('2', s);
  const bold   = (s) => paint('1', s);

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
      // Ctrl+C mid-wizard cancels this step (resolve the CANCEL sentinel the
      // callers already handle) instead of hard-killing the whole process —
      // a wizard step must be abortable without taking the app down.
      else if (key.ctrl && key.name === 'c') { cleanup(); resolve('CANCEL'); }
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
      // Show the cursor, then leave the alt screen → the main buffer (with the
      // wizard's prior output) reappears exactly as it was, nothing pushed into
      // scrollback. Fall back to a clear+home when the alt buffer wasn't used.
      if (altScreen) process.stdout.write('\x1b[?25h\x1b[?1049l');
      else process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
      // Release stdin so a one-shot CLI caller (the setup / onboard wizard) can
      // exit. We resume()+ref() stdin on entry to receive keypresses; if it's
      // never unref'd, the event loop stays alive after the LAST picker and the
      // process hangs at "Setup complete" instead of returning to the shell.
      // The chat REPL re-refs stdin (via _pauseChatForSubMenu's finally) and
      // its own readline keeps the loop alive, so this is safe there.
      if (process.stdin.unref) process.stdin.unref();
    };
    process.stdin.on('keypress', onKey);
  });
}

// Arrow-key yes/no — replaces the typed `[Y/n]` prompts in the wizard so the
// user never types a letter. Returns a boolean. Esc / q resolve to the default.
// Inherits _arrowMenu's non-TTY fallback (reads a line). `pick` is injectable
// for tests.
export async function _pickYesNo(title, { subtitle, yesLabel = 'Yes', noLabel = 'No', defaultYes = true, pick = _arrowMenu } = {}) {
  const picked = await pick({
    title,
    subtitle,
    items: [
      { id: 'yes', label: yesLabel },
      { id: 'no', label: noLabel },
    ],
    defaultIdx: defaultYes ? 0 : 1,
  });
  if (picked === 'BACK' || picked === 'CANCEL' || picked == null) return defaultYes;
  const id = typeof picked === 'object' ? picked.id : picked;
  return id === 'yes';
}

// Arrow-key single choice — `options` is [{ id, label, desc }]. Returns the
// chosen id, or `fallback` on Esc/cancel. `pick` injectable for tests.
export async function _pickChoice(title, options, { subtitle, defaultIdx = 0, fallback = null, pick = _arrowMenu } = {}) {
  const picked = await pick({ title, subtitle, items: options, defaultIdx, searchable: false });
  if (picked === 'BACK' || picked === 'CANCEL' || picked == null) return fallback;
  return typeof picked === 'object' ? picked.id : picked;
}

// Bucket every registered provider into one of three auth-method
// families. The picker's first step asks the user which family
// they want before drilling into specific providers — much less
// overwhelming than a flat 40-row list. Bucket assignment lives
// here (rather than registry.mjs) because it's a UX concept, not
// an intrinsic provider attribute.
export function _providerFamilies() {
  // Membership (api/cli/meta/mock) is shared with the Ink picker via
  // tui/provider_families.mjs; the ANSI tags below are readline-specific.
  const b = _bucketProviders(getRegistry());
  return {
    api: { label: 'API key', desc: 'paste an sk-... key during setup',  tag: paint('38;5;245', '[needs key]'), members: b.api },
    cli: { label: 'CLI / Local', desc: 'keyless — uses an existing CLI login or a local daemon', tag: paint('38;5;208', '[no key]'), members: b.cli },
    meta: { label: 'Multi-agent', desc: 'orchestrator — fan a task out to a planner + workers (advanced)', tag: paint('38;5;245', '[meta]'), members: b.meta },
    mock: { label: 'Mock', desc: 'offline echo, only useful for testing', tag: paint('38;5;245', '[test]'), members: b.mock },
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
    const ans = await _readOneLine(process.stdin);
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
          ? paint('38;5;213', '[custom]')
          : (meta.requiresApiKey ? paint('38;5;245', '[api key]') : paint('38;5;208', '[no key]')),
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
        tag: paint('38;5;213', '[new]'),
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

// _setupOrchestratorInteractive moved to tui/orchestrator_setup.mjs (it imports
// _arrowMenu / _quickPrompt back from here at call time → a safe cycle). The
// re-export line sits at the BOTTOM of this file, after those helpers are
// declared, so the live bindings resolve.

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
    // "Use the provider's own default" — send no `-m`, the reliable path for
    // keyless CLI providers (codex-cli / gemini-cli) whose allowed model set
    // is fixed by the logged-in account: forcing a model the plan isn't
    // entitled to makes the CLI reject the turn. Pre-selected when the
    // provider declares no defaultModel.
    const modelItems = [{
      id: '__provider_default__',
      label: "▷ Use the provider's own default model",
      desc: 'no model override — the CLI/login picks (recommended for codex-cli / gemini-cli)',
      tag: paint('38;5;208', '[default]'),
    }];
    if (supportsLiveFetch) {
      modelItems.push({
        id: '__fetch_models__',
        label: '↻ Fetch live model list from /v1/models',
        desc: isCustom || isBuiltinCompat ? `GET ${meta.baseUrl}/models` : 'pulls the up-to-date catalogue from the provider',
        tag: paint('38;5;245', '[live]'),
      });
    }
    for (const m of allModels) modelItems.push({ id: m, label: m, desc: '' });
    modelItems.push({
      id: '__custom_model__',
      label: '… type a custom model id',
      desc: 'use any model id supported by this provider, even if not listed above',
      tag: paint('38;5;245', '[free]'),
    });

    // Land the cursor on the configured default model when there is one;
    // otherwise pre-select "use the provider's own default" (index 0).
    let defaultIdx = 0;
    if (meta.defaultModel) {
      const i = modelItems.findIndex((it) => it.id === meta.defaultModel);
      if (i >= 0) defaultIdx = i;
    }
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
    // Empty string = "no explicit model" (use the provider/CLI default).
    if (picked.id === '__provider_default__') return '';
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
          process.stdout.write(`  ${paint(33, 'no models returned')} — falling back to the suggested list.\n`);
          await _quickPrompt('  press Enter to continue ');
        } else {
          dynamicModels = fetched;
          process.stdout.write(`  fetched ${fetched.length} model(s).\n`);
          await _quickPrompt('  press Enter to pick one ');
        }
      } catch (e) {
        process.stdout.write(`\n  ${paint(33, 'fetch failed:')} ${e?.message || e}\n`);
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
  const accent = (s) => paint('38;5;208', s);
  const dim    = (s) => paint('2', s);
  const bold   = (s) => paint('1', s);
  const ok     = (s) => paint('32', s);

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
      process.stdout.write(`  ${paint(33, e.message)} — try again.\n`);
      continue;
    }
    // OpenAI-compat builtins (nim / openrouter / groq / …) can be overridden
    // by a custom entry of the same name — both go through
    // makeOpenAICompatProvider, so the wire format is identical and the
    // user is just pointing the same alias at a different URL/key. Surface
    // the override so it isn't a silent surprise.
    if (typeof isBuiltinOpenAICompatName === 'function' && isBuiltinOpenAICompatName(name)) {
      process.stdout.write(
        paint(2, `Note: "${name}" is a built-in OpenAI-compatible provider; ` +
        `your custom entry will override the built-in baseUrl/api-key for this install. ` +
        `Remove with: lazyclaw providers remove ${name}`) + '\n'
      );
    }
    break;
  }
  const baseUrlRaw = (await _quickPrompt(`  ${bold('baseUrl')} ${dim('(must end in /v1, no trailing slash needed):')} `)).trim();
  if (!baseUrlRaw) { process.stdout.write(dim('  cancelled — baseUrl is required.\n')); return null; }
  if (!/^https?:\/\//i.test(baseUrlRaw)) {
    process.stdout.write(`  ${paint(33, 'baseUrl must start with http:// or https://')} — cancelled.\n`);
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
    probeMsg = `  ${paint(33, '!')} registered, but /v1/models probe failed: ${result.probe.error}\n`;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${ok(bold('✓ custom provider saved:'))} ${entry.name}  ${dim('→')} ${entry.baseUrl}\n`);
  process.stdout.write(probeMsg);
  process.stdout.write(dim(`  Removable any time via:  lazyclaw providers remove ${name}\n`));
  await _quickPrompt('  press Enter to continue ');
  return { name };
}
// Single-line readline prompt. Pass { secret: true } to mask the typed value
// (api keys, channel tokens) — the bytes are read in raw mode and echoed as
// bullets so the secret never appears on screen / scrollback / a screen-share.
// Non-TTY input can't be masked (no raw mode); it falls back to the plain read,
// which is fine for piped automation where there is no screen to leak to.
export async function _quickPrompt(label, opts = {}) {
  if (opts.secret && process.stdin.isTTY && process.stdin.setRawMode) {
    return _quickPromptSecret(label);
  }
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

// Masked raw-mode reader: echoes one bullet per typed character, handles
// Backspace, Enter/Ctrl-D (submit), and Ctrl-C (abort → empty string). The real
// characters accumulate off-screen and are returned trimmed.
export async function _quickPromptSecret(label) {
  const stdin = process.stdin;
  process.stdout.write('\n' + label);
  const wasRaw = !!stdin.isRaw;
  try { stdin.setRawMode(true); } catch (_) {}
  stdin.resume();
  if (stdin.ref) stdin.ref();
  const prevEnc = stdin.readableEncoding;
  stdin.setEncoding('utf8');
  let buf = '';
  const value = await new Promise((resolve) => {
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\x04') { // Enter / Ctrl-D
          cleanup(); resolve(buf); return;
        }
        if (ch === '\x03') { // Ctrl-C abort
          cleanup(); resolve(''); return;
        }
        if (ch === '\x7f' || ch === '\x08') { // Backspace / Delete
          if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue; // ignore other control chars (arrows, etc.)
        buf += ch;
        process.stdout.write('•');
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch (_) {}
      if (prevEnc) { try { stdin.setEncoding(prevEnc); } catch (_) {} }
      process.stdout.write('\n');
    };
    stdin.on('data', onData);
  });
  return value.trim();
}

// Re-export the orchestrator setup wizard (moved to tui/orchestrator_setup.mjs).
// Kept at the BOTTOM so _arrowMenu / _quickPrompt — which that module imports
// back from here — are already declared when the cycle resolves. The helpers
// are hoisted top-level function declarations and used only at call time, so
// the pickers ↔ orchestrator_setup cycle never reads an uninitialised binding.
export { _setupOrchestratorInteractive } from './orchestrator_setup.mjs';
