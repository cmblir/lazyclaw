# lazyclaw v5.0 — Phase C: ux-upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ink-based two-column interactive splash, multiline-editor REPL with mid-stream interrupt-and-redirect, ghost autocomplete migration, color theme, and a deterministic sloth-ASCII build pipeline — all with a non-TTY / `LAZYCLAW_NO_INK=1` fallback to the v4 readline path.

**Architecture:** New `tui/` directory holds the ink components (`splash.mjs`, `editor.mjs`, `repl.mjs`, `ghost.mjs`) and the shared `theme.mjs`. `scripts/build-splash.mjs` rasterises `docs/assets/sleepy-sloth-source.png` through chafa + ImageMagick Mezzotone + ANSI strip into `tui/banner.generated.mjs` (committed; build is opt-in). `cli.mjs` chooses between the new ink mount and the legacy figlet/readline path via TTY + `LAZYCLAW_NO_INK` detection — no existing tests change.

**Tech Stack:** Node.js 18+, .mjs ES modules, `ink` ^5 (regular dependency, ~30 KB gzipped), `string-width` ^7, `chalk` ^5, `node --test` for tests. External CLI tools (`chafa`, ImageMagick `convert`) are required only for `scripts/build-splash.mjs`, never at runtime.

**Depends on phases:** A (foundation: tui/ dir, package.json bumps, theme registration). Does not depend on B (learning) or D (sandbox).

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §5 (entire section), §0.1 C5 (skill group fallback), §1.7 (ink as breaking dep), §5.7 (footer 4 lines), §5.8 (REPL upgrades), §5.10 (width safety).

---

## File Structure

Files created (all absolute paths under /Users/o/lazyclaw/):

- `/Users/o/lazyclaw/tui/theme.mjs` — color tokens, ink-compatible (chalk under the hood), single source of truth for amber `#FFB347`, dim grey, accent
- `/Users/o/lazyclaw/tui/splash.mjs` — ink Splash component: two-column layout, sloth gutter left, tools+skills right, 4-line footer
- `/Users/o/lazyclaw/tui/editor.mjs` — ink multiline editor: Shift+Enter newline, Enter submit, history nav, paste detection
- `/Users/o/lazyclaw/tui/repl.mjs` — ink REPL host: orchestrates Splash + Editor, mid-stream Esc interrupt, redirect-buffer of pending text
- `/Users/o/lazyclaw/tui/ghost.mjs` — ink ghost autocomplete: dim suffix preview, Tab cycle, Right-arrow accept
- `/Users/o/lazyclaw/tui/banner.generated.mjs` — committed build artifact: `{ rows: string[], width: 24, height: 10, fg: '#FFB347' }`
- `/Users/o/lazyclaw/scripts/build-splash.mjs` — chafa + ImageMagick pipeline that regenerates `banner.generated.mjs`
- `/Users/o/lazyclaw/docs/assets/sleepy-sloth-source.png` — 1024×1024 PD-sourced or AI-generated sloth silhouette (binary, committed)
- `/Users/o/lazyclaw/tests/phaseC-theme.test.mjs` — token regression: amber hex, exported keys
- `/Users/o/lazyclaw/tests/phaseC-splash.test.mjs` — ink-testing-library render: two-column structure, 4-line footer, width ≤ 80
- `/Users/o/lazyclaw/tests/phaseC-editor.test.mjs` — Shift+Enter inserts newline, Enter submits, history nav
- `/Users/o/lazyclaw/tests/phaseC-repl-interrupt.test.mjs` — Esc during stream aborts + prepends pending text to next turn
- `/Users/o/lazyclaw/tests/phaseC-ghost.test.mjs` — `/he` → ghost suggests `lp`, Tab cycles, Right-arrow accepts
- `/Users/o/lazyclaw/tests/phaseC-build-splash.test.mjs` — every row of `banner.generated.mjs` has `string-width(row) ≤ 24`

Files modified:

- `/Users/o/lazyclaw/package.json` — add `ink`, `string-width`, `chalk` to `dependencies`; add `build:splash` and updated `test` script entries
- `/Users/o/lazyclaw/cli.mjs` — branch on `process.stdout.isTTY && !process.env.LAZYCLAW_NO_INK` to mount the new ink REPL; keep the legacy figlet/readline path intact for fallback

---

## Task 1 — Theme module + ink dependency

**Estimated:** 30 min. Establishes the shared color palette and brings `ink` into `dependencies`. Spec §5.3 (mascot single colour `#FFB347`), §5.7 (footer styling), §1.7 (ink breaking-bump).

- [ ] **1.1 — Add ink, string-width, chalk to dependencies.**
  Edit `/Users/o/lazyclaw/package.json`. After the existing `"engines"` block and before `"devDependencies"`, add:

  ```jsonc
  "dependencies": {
    "ink": "^5.0.1",
    "string-width": "^7.2.0",
    "chalk": "^5.3.0"
  },
  ```

  Also add a `"build:splash"` line into `"scripts"`:

  ```jsonc
  "scripts": {
    "test": "node --test tests/phaseC-*.test.mjs && playwright test",
    "test:bench": "node scripts/bench-providers.mjs",
    "build:splash": "node scripts/build-splash.mjs"
  },
  ```

- [ ] **1.2 — Install deps.**
  Run: `cd /Users/o/lazyclaw && npm install`
  Expected: ink, string-width, chalk added to `package-lock.json`, no audit errors above moderate.

- [ ] **1.3 — Write failing theme test.**
  Create `/Users/o/lazyclaw/tests/phaseC-theme.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { theme } from '../tui/theme.mjs';

  test('theme exports amber, dim, accent tokens', () => {
    assert.equal(theme.amber, '#FFB347');
    assert.equal(typeof theme.dim, 'function');
    assert.equal(typeof theme.accent, 'function');
    assert.equal(typeof theme.muted, 'function');
  });

  test('theme.amber colorizer wraps text with ANSI when isTTY', () => {
    const out = theme.amber('hello');
    assert.ok(out.includes('hello'));
  });

  test('theme.plain returns input unchanged for non-TTY pipelines', () => {
    assert.equal(theme.plain('hello'), 'hello');
  });
  ```

- [ ] **1.4 — Run test, confirm FAIL.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-theme.test.mjs`
  Expected: `Cannot find module '../tui/theme.mjs'` → all 3 tests fail.

- [ ] **1.5 — Create the theme module.**
  Create `/Users/o/lazyclaw/tui/theme.mjs`:

  ```js
  // tui/theme.mjs — single source of truth for lazyclaw v5 color tokens.
  // The amber hex is also stamped into tui/banner.generated.mjs so the
  // sloth gutter and the prompt accent stay visually paired.
  import chalk from 'chalk';

  const AMBER_HEX = '#FFB347';

  function amber(text) {
    return chalk.hex(AMBER_HEX)(text);
  }

  function dim(text) {
    return chalk.dim(text);
  }

  function accent(text) {
    return chalk.bold.hex(AMBER_HEX)(text);
  }

  function muted(text) {
    return chalk.gray(text);
  }

  function plain(text) {
    return text;
  }

  export const theme = {
    amber: AMBER_HEX,
    fg: AMBER_HEX,
    colorize: amber,
    dim,
    accent,
    muted,
    plain,
  };

  // Compatibility: some callers want the colorizer when reading `theme.amber`.
  // Keep the hex on the property for builders, and expose `colorize` for runtime use.
  ```

  Note: the test reads `theme.amber` as the hex *string* and calls `theme.amber('hello')` as a function. Re-read the test — we need a callable that also stringifies to the hex. Drop the dual-purpose: keep `theme.amber` as the hex, and the test's "wraps text" assertion uses `theme.colorize`. Replace the second test in step 1.3 to read:

  ```js
  test('theme.colorize wraps text with ANSI when chalk is in TTY mode', () => {
    const out = theme.colorize('hello');
    assert.ok(out.includes('hello'));
  });
  ```

  Re-apply the test edit before continuing.

- [ ] **1.6 — Run test, confirm PASS.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-theme.test.mjs`
  Expected: `# pass 3`, `# fail 0`.

- [ ] **1.7 — Commit.**
  Run:
  ```bash
  cd /Users/o/lazyclaw && git add tui/theme.mjs tests/phaseC-theme.test.mjs package.json package-lock.json && git commit -m "$(cat <<'EOF'
  feat(tui): add ink + theme tokens for v5 splash

  Brings ink ^5, string-width ^7, chalk ^5 into the runtime dependency set
  per spec §1.7 (accepted breaking-bump for v5.0). Establishes
  tui/theme.mjs as the single source of truth for the amber #FFB347 used
  by both the splash mascot and the prompt accent.
  EOF
  )"
  ```

---

## Task 2 — Sloth ASCII pipeline + banner.generated.mjs

**Estimated:** 45 min. Build-time pipeline that turns the source PNG into a deterministic braille grid. Spec §5.2 (six pipeline stages), §5.3 (CC0 silhouette), §5.10 (width safety).

- [ ] **2.1 — Stage the source image.**
  Place the source sloth PNG at `/Users/o/lazyclaw/docs/assets/sleepy-sloth-source.png`. The image must be 1024×1024, PD/CC0-sourced or AI-generated baseline. If unavailable, generate a placeholder via:
  ```bash
  cd /Users/o/lazyclaw && mkdir -p docs/assets && \
    /usr/bin/python3 -c "from PIL import Image, ImageDraw; \
    im = Image.new('L', (1024,1024), 255); d = ImageDraw.Draw(im); \
    d.ellipse((192,192,832,832), fill=40); im.save('docs/assets/sleepy-sloth-source.png')"
  ```
  (If PIL is unavailable, any 1024×1024 grayscale PNG with a centered dark blob works; the build script normalises tone.)
  Expected: `ls -la /Users/o/lazyclaw/docs/assets/sleepy-sloth-source.png` shows the file.

- [ ] **2.2 — Write failing build-splash test.**
  Create `/Users/o/lazyclaw/tests/phaseC-build-splash.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import stringWidth from 'string-width';
  import { banner } from '../tui/banner.generated.mjs';

  test('banner exports rows array', () => {
    assert.ok(Array.isArray(banner.rows));
    assert.ok(banner.rows.length > 0);
  });

  test('every banner row has string-width <= 24', () => {
    for (const [i, row] of banner.rows.entries()) {
      const w = stringWidth(row);
      assert.ok(w <= 24, `row ${i} width=${w} content=${JSON.stringify(row)}`);
    }
  });

  test('banner declares width=24, height<=12, fg=#FFB347', () => {
    assert.equal(banner.width, 24);
    assert.ok(banner.height <= 12);
    assert.equal(banner.fg, '#FFB347');
  });
  ```

- [ ] **2.3 — Run test, confirm FAIL.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-build-splash.test.mjs`
  Expected: `Cannot find module '../tui/banner.generated.mjs'`.

- [ ] **2.4 — Create the build script.**
  Create `/Users/o/lazyclaw/scripts/build-splash.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/build-splash.mjs — deterministic ASCII pipeline (spec §5.2).
  //
  // Stages:
  //   1. Source PNG  (docs/assets/sleepy-sloth-source.png, 1024x1024, CC0)
  //   2. Tone curve  (ImageMagick `convert -colorspace Gray -level 10%,90%`)
  //   3. Rasterise   (`chafa --symbols=braille --size=24x10 --fg-only`)
  //   4. ANSI strip  (regex /\x1b\[[0-9;]*m/g — colour reapplied at runtime)
  //   5. Validate    (string-width per row <= 24)
  //   6. Emit        (tui/banner.generated.mjs)
  //
  // Runtime only depends on the committed banner.generated.mjs.
  // chafa + ImageMagick are build-time only.
  import { execFileSync, spawnSync } from 'node:child_process';
  import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import stringWidth from 'string-width';

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, '..');
  const SRC = path.join(ROOT, 'docs/assets/sleepy-sloth-source.png');
  const OUT = path.join(ROOT, 'tui/banner.generated.mjs');

  function which(bin) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  function main() {
    if (!which('chafa') || !which('convert')) {
      console.error('build-splash: chafa and ImageMagick `convert` are required.');
      console.error('  macOS:  brew install chafa imagemagick');
      console.error('  Debian: apt-get install chafa imagemagick');
      process.exit(2);
    }
    const work = mkdtempSync(path.join(tmpdir(), 'lazyclaw-splash-'));
    const toned = path.join(work, 'toned.png');

    // Stage 2: tone curve.
    execFileSync('convert', [SRC, '-colorspace', 'Gray', '-level', '10%,90%', toned]);

    // Stage 3: rasterise.
    const rasterRaw = execFileSync('chafa', [
      '--symbols=braille', '--size=24x10', '--fg-only',
      '--threshold=0.55', toned,
    ], { encoding: 'utf8' });

    // Stage 4: ANSI strip.
    const ansi = /\x1b\[[0-9;]*m/g;
    const rows = rasterRaw.split('\n').map((r) => r.replace(ansi, '')).filter((r) => r.length > 0);

    // Stage 5: validate.
    for (const [i, row] of rows.entries()) {
      const w = stringWidth(row);
      if (w > 24) {
        console.error(`row ${i} width=${w} exceeds 24: ${JSON.stringify(row)}`);
        process.exit(3);
      }
    }

    // Stage 6: emit.
    const body = `// AUTO-GENERATED by scripts/build-splash.mjs — do not edit by hand.\n`
      + `export const banner = ${JSON.stringify({
        rows,
        width: 24,
        height: rows.length,
        fg: '#FFB347',
      }, null, 2)};\n`;
    writeFileSync(OUT, body);
    console.log(`build-splash: wrote ${OUT} (${rows.length} rows)`);
  }

  main();
  ```
  Make executable: `chmod +x /Users/o/lazyclaw/scripts/build-splash.mjs`.

- [ ] **2.5 — Run the build script.**
  Run: `cd /Users/o/lazyclaw && node scripts/build-splash.mjs`
  Expected (if chafa+convert installed): `build-splash: wrote /Users/o/lazyclaw/tui/banner.generated.mjs (N rows)`.
  If the host lacks chafa/convert, manually create `/Users/o/lazyclaw/tui/banner.generated.mjs` with a hand-curated 10-row braille fallback so downstream tasks can proceed:

  ```js
  // AUTO-GENERATED placeholder — replace by running `npm run build:splash`.
  export const banner = {
    rows: [
      "    ⣀⣠⣤⣶⣶⣦⣄⡀         ",
      "  ⢠⣾⠟⠉   ⠈⠙⢿⣦         ",
      "  ⣿⠁  ●     ●  ⣿        ",
      "  ⣿⡀   ⠈⠉⠉⠁   ⣿        ",
      "  ⠘⢿⣦⡀     ⢀⣴⡿⠃         ",
      "    ⠈⠙⠻⠷⠶⠶⠿⠟⠋           ",
      "       ⢸⠁  ⢸           ",
      "       ⢸⠉  ⠉⠉⠉⠉         ",
      "        lazyclaw        ",
      "                        "
    ],
    width: 24,
    height: 10,
    fg: "#FFB347"
  };
  ```

- [ ] **2.6 — Run test, confirm PASS.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-build-splash.test.mjs`
  Expected: `# pass 3`, `# fail 0`.

- [ ] **2.7 — Commit.**
  ```bash
  cd /Users/o/lazyclaw && git add docs/assets/sleepy-sloth-source.png scripts/build-splash.mjs tui/banner.generated.mjs tests/phaseC-build-splash.test.mjs && git commit -m "$(cat <<'EOF'
  feat(tui): sloth ASCII build pipeline + committed banner

  Adds scripts/build-splash.mjs implementing the six-stage chafa +
  ImageMagick Mezzotone + ANSI-strip pipeline from spec §5.2. The
  resulting tui/banner.generated.mjs is committed so runtime never
  shells out to chafa. Validates every row at string-width <= 24 to
  enforce the 24-cell left gutter contract.
  EOF
  )"
  ```

---

## Task 3 — ink Splash component (two-column layout + footer)

**Estimated:** 50 min. The visible payoff — first-render screen. Spec §5.1 (mockup), §5.4 (tool metadata), §5.5 (skill grouping with C5 fallback), §5.6 (truncation), §5.7 (4-line footer fixed).

- [ ] **3.1 — Write failing splash test.**
  Create `/Users/o/lazyclaw/tests/phaseC-splash.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { renderSplashToString } from '../tui/splash.mjs';
  import stringWidth from 'string-width';

  const fixture = {
    provider: 'claude-cli',
    model: 'sonnet-4.7',
    trainer: { provider: 'claude-cli', model: 'haiku-4.5' },
    sessionId: '7af9abcd',
    cwd: '/Users/o/code/lazyclaw',
    tools: [
      { category: 'fs', sensitive: false, verbs: ['read','write','edit','glob','grep'] },
      { category: 'exec', sensitive: false, verbs: ['bash','spawn','kill'] },
      { category: 'admin', sensitive: true, verbs: ['keys','billing'] },
    ],
    skills: [
      { group: 'dev', names: ['review','debug','simplify'] },
      { group: 'docs', names: ['init','changelog','readme'] },
    ],
  };

  test('splash renders without throwing', () => {
    const out = renderSplashToString(fixture, { columns: 80 });
    assert.ok(typeof out === 'string' && out.length > 0);
  });

  test('every rendered line fits within 80 columns', () => {
    const out = renderSplashToString(fixture, { columns: 80 });
    for (const [i, line] of out.split('\n').entries()) {
      assert.ok(stringWidth(line) <= 80, `line ${i} width=${stringWidth(line)}`);
    }
  });

  test('footer is exactly 4 informational lines', () => {
    const out = renderSplashToString(fixture, { columns: 80 });
    assert.match(out, /provider · claude-cli · sonnet-4\.7/);
    assert.match(out, /trainer\s+· claude-cli · haiku-4\.5/);
    assert.match(out, /slash\s+· \/help/);
    assert.match(out, /hint\s+· Shift\+Enter/);
  });

  test('tools section lists verbs joined by middle-dot', () => {
    const out = renderSplashToString(fixture, { columns: 80 });
    assert.match(out, /fs\s+read · write · edit · glob · grep/);
  });

  test('sensitive tools are tagged with (sensitive)', () => {
    const out = renderSplashToString(fixture, { columns: 80 });
    assert.match(out, /\(sensitive\) admin/);
  });
  ```

- [ ] **3.2 — Run test, confirm FAIL.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-splash.test.mjs`
  Expected: `Cannot find module '../tui/splash.mjs'`.

- [ ] **3.3 — Create the Splash module.**
  Create `/Users/o/lazyclaw/tui/splash.mjs`:

  ```js
  // tui/splash.mjs — two-column launch splash (spec §5.1).
  //
  // Public surface:
  //   - <Splash {...props} />            ink component for live REPL mount
  //   - renderSplashToString(props)      pure string builder used by tests
  //                                       and by the non-TTY path.
  //
  // Layout: 24-cell sloth gutter (cols 0-23) | 2-cell separator (24-25)
  //   | 52-cell right column (cols 26-77) | 2-cell right padding.
  // Footer: exactly 4 lines, blank row separates body from footer.
  import React from 'react';
  import { Box, Text } from 'ink';
  import stringWidth from 'string-width';
  import { theme } from './theme.mjs';
  import { banner } from './banner.generated.mjs';

  const RIGHT_COL_WIDTH = 52;
  const GUTTER_WIDTH = 24;

  function fit(text, max) {
    if (stringWidth(text) <= max) return text.padEnd(max);
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (stringWidth(text.slice(0, mid) + '…') <= max) lo = mid;
      else hi = mid - 1;
    }
    return (text.slice(0, lo) + '…').padEnd(max);
  }

  function shortCwd(cwd) {
    const home = process.env.HOME || '';
    if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
    return cwd;
  }

  function toolRow({ category, sensitive, verbs }) {
    const label = sensitive ? `(sensitive) ${category}` : category;
    const tail = verbs.slice(0, 6).join(' · ');
    const more = verbs.length > 6 ? ` (${verbs.length - 6} more)` : '';
    return `${fit(label, 9)}${tail}${more}`;
  }

  function skillRow({ group, names }) {
    const tail = names.slice(0, 6).join(' · ');
    const more = names.length > 6 ? ` (${names.length - 6} more)` : '';
    return `${fit(group, 9)}${tail}${more}`;
  }

  function buildBody(props) {
    const { tools = [], skills = [] } = props;
    const right = [];
    right.push('Available Tools');
    right.push('─'.repeat(45));
    for (const t of tools.slice(0, 8)) right.push(toolRow(t));
    if (tools.length > 8) right.push(`... and ${tools.length - 8} more tool groups`);
    right.push('');
    right.push('Available Skills');
    right.push('─'.repeat(45));
    for (const s of skills.slice(0, 8)) right.push(skillRow(s));
    if (skills.length > 8) right.push(`... and ${skills.length - 8} more skill groups`);

    const left = banner.rows.slice();
    while (left.length < right.length) left.push('');
    while (right.length < left.length) right.push('');

    const lines = [];
    for (let i = 0; i < left.length; i++) {
      const lhs = fit(left[i], GUTTER_WIDTH);
      const rhs = fit(right[i], RIGHT_COL_WIDTH);
      lines.push(`  ${lhs}  ${rhs}`);
    }
    return lines;
  }

  function buildFooter(props) {
    const { provider, model, trainer = {}, sessionId, cwd } = props;
    const tProv = trainer.provider || provider;
    const tModel = trainer.model || model;
    const sid = (sessionId || '').slice(0, 8);
    const cwdShort = shortCwd(cwd || process.cwd());
    return [
      fit(`  provider · ${provider} · ${model}`, 56) + fit(`cwd · ${cwdShort}`, 22),
      fit(`  trainer  · ${tProv} · ${tModel}  session ${sid}`, 78),
      fit('  slash    · /help · /model · /trainer · /skills · /tools · /exit', 78),
      fit('  hint     · Shift+Enter newline · Ctrl-R recall · Esc interrupt', 78),
    ];
  }

  export function renderSplashToString(props, { columns = 80 } = {}) {
    void columns; // currently fixed-width at 80; <72 fallback is in cli.mjs
    const body = buildBody(props);
    const footer = buildFooter(props);
    return [...body, '', ...footer].join('\n');
  }

  export function Splash(props) {
    const lines = renderSplashToString(props).split('\n');
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      lines.map((line, i) =>
        React.createElement(Text, { key: i, color: i < banner.height ? theme.fg : undefined }, line)
      )
    );
  }
  ```

- [ ] **3.4 — Run test, confirm PASS.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-splash.test.mjs`
  Expected: `# pass 5`, `# fail 0`.

- [ ] **3.5 — Commit.**
  ```bash
  cd /Users/o/lazyclaw && git add tui/splash.mjs tests/phaseC-splash.test.mjs && git commit -m "$(cat <<'EOF'
  feat(tui): two-column ink splash with fixed 4-line footer

  Implements the spec §5.1 launch panel — 24-cell sloth gutter on the
  left, 52-cell tools+skills column on the right, four-line footer
  carrying provider/trainer/slash/hint. Truncation follows §5.6 (verb
  cap 6, group cap 8, ellipsis U+2026). Pure renderSplashToString
  builder is reused by the non-TTY fallback path.
  EOF
  )"
  ```

---

## Task 4 — Multiline editor + ghost autocomplete (ink versions)

**Estimated:** 55 min. The interactive input surface. Spec §5.8 (Shift+Enter, Ctrl-R recall), §5.4 footer keybindings, ghost autocomplete migration from `cli.mjs:1388-1500`.

- [ ] **4.1 — Write failing editor test.**
  Create `/Users/o/lazyclaw/tests/phaseC-editor.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { makeEditorState, applyKey } from '../tui/editor.mjs';

  test('Enter on single-line buffer emits submit event', () => {
    let s = makeEditorState({ history: [] });
    s = applyKey(s, { input: 'hi', key: {} });
    s = applyKey(s, { input: '', key: { return: true } });
    assert.equal(s.lastSubmit, 'hi');
    assert.equal(s.buffer, '');
  });

  test('Shift+Enter inserts a literal newline, does not submit', () => {
    let s = makeEditorState({ history: [] });
    s = applyKey(s, { input: 'a', key: {} });
    s = applyKey(s, { input: '', key: { return: true, shift: true } });
    s = applyKey(s, { input: 'b', key: {} });
    assert.equal(s.buffer, 'a\nb');
    assert.equal(s.lastSubmit, null);
  });

  test('Up arrow walks history backwards', () => {
    let s = makeEditorState({ history: ['old1', 'old2'] });
    s = applyKey(s, { input: '', key: { upArrow: true } });
    assert.equal(s.buffer, 'old2');
    s = applyKey(s, { input: '', key: { upArrow: true } });
    assert.equal(s.buffer, 'old1');
  });

  test('paste of >= 16 chars is flagged as paste', () => {
    let s = makeEditorState({ history: [] });
    const big = 'x'.repeat(64);
    s = applyKey(s, { input: big, key: {}, paste: true });
    assert.equal(s.buffer, big);
    assert.equal(s.lastWasPaste, true);
  });
  ```

- [ ] **4.2 — Run test, confirm FAIL.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-editor.test.mjs`
  Expected: `Cannot find module '../tui/editor.mjs'`.

- [ ] **4.3 — Create editor module.**
  Create `/Users/o/lazyclaw/tui/editor.mjs`:

  ```js
  // tui/editor.mjs — multiline input state machine (spec §5.8).
  //
  // Pure-functional core (makeEditorState, applyKey) so it is testable
  // without ink stdin. The React component <Editor/> wraps useInput().
  import React, { useState, useEffect } from 'react';
  import { Box, Text, useInput } from 'ink';
  import { theme } from './theme.mjs';

  export function makeEditorState({ history = [] } = {}) {
    return {
      buffer: '',
      cursor: 0,
      historyIdx: history.length,
      history,
      lastSubmit: null,
      lastWasPaste: false,
    };
  }

  export function applyKey(state, evt) {
    const { input = '', key = {}, paste = false } = evt;
    const next = { ...state, lastSubmit: null, lastWasPaste: false };

    if (key.return && key.shift) {
      next.buffer = state.buffer + '\n';
      next.cursor = next.buffer.length;
      return next;
    }
    if (key.return) {
      next.lastSubmit = state.buffer;
      next.buffer = '';
      next.cursor = 0;
      next.historyIdx = state.history.length;
      return next;
    }
    if (key.upArrow) {
      const idx = Math.max(0, state.historyIdx - 1);
      if (state.history[idx] !== undefined) {
        next.historyIdx = idx;
        next.buffer = state.history[idx];
        next.cursor = next.buffer.length;
      }
      return next;
    }
    if (key.downArrow) {
      const idx = Math.min(state.history.length, state.historyIdx + 1);
      next.historyIdx = idx;
      next.buffer = state.history[idx] !== undefined ? state.history[idx] : '';
      next.cursor = next.buffer.length;
      return next;
    }
    if (key.backspace || key.delete) {
      next.buffer = state.buffer.slice(0, -1);
      next.cursor = next.buffer.length;
      return next;
    }
    if (input) {
      next.buffer = state.buffer + input;
      next.cursor = next.buffer.length;
      next.lastWasPaste = paste || input.length >= 16;
      return next;
    }
    return next;
  }

  export function Editor({ history, onSubmit }) {
    const [state, setState] = useState(() => makeEditorState({ history }));
    useInput((input, key) => {
      const next = applyKey(state, { input, key });
      setState(next);
    });
    useEffect(() => {
      if (state.lastSubmit !== null && onSubmit) onSubmit(state.lastSubmit);
    }, [state.lastSubmit]);

    const lines = state.buffer.split('\n');
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      lines.map((ln, i) => React.createElement(Text, { key: i }, i === 0 ? theme.accent('› ') + ln : '  ' + ln))
    );
  }
  ```

- [ ] **4.4 — Run editor test, confirm PASS.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-editor.test.mjs`
  Expected: `# pass 4`, `# fail 0`.

- [ ] **4.5 — Write failing ghost test.**
  Create `/Users/o/lazyclaw/tests/phaseC-ghost.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { computeGhost, cycleGhost, acceptGhost } from '../tui/ghost.mjs';

  const cmds = ['/help', '/model', '/trainer', '/skills', '/tools', '/exit'];

  test('computeGhost returns dim suffix for prefix match', () => {
    const g = computeGhost('/he', cmds);
    assert.equal(g.suggestion, '/help');
    assert.equal(g.suffix, 'lp');
  });

  test('computeGhost returns null when no match', () => {
    const g = computeGhost('/zzz', cmds);
    assert.equal(g, null);
  });

  test('cycleGhost advances through multiple matches', () => {
    const g1 = computeGhost('/', cmds);
    const g2 = cycleGhost(g1, cmds);
    assert.notEqual(g1.suggestion, g2.suggestion);
  });

  test('acceptGhost returns the full completed buffer', () => {
    const g = computeGhost('/he', cmds);
    assert.equal(acceptGhost('/he', g), '/help');
  });
  ```

- [ ] **4.6 — Run ghost test, confirm FAIL.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-ghost.test.mjs`
  Expected: `Cannot find module '../tui/ghost.mjs'`.

- [ ] **4.7 — Create ghost module.**
  Create `/Users/o/lazyclaw/tui/ghost.mjs`:

  ```js
  // tui/ghost.mjs — ink port of the v4 readline ghost autocomplete
  // (cli.mjs:1388-1500). Pure functions; the React surface is owned
  // by tui/repl.mjs which renders the suggestion dim-styled.
  import { theme } from './theme.mjs';

  function matches(prefix, cmds) {
    return cmds.filter((c) => c.startsWith(prefix) && c !== prefix);
  }

  export function computeGhost(buffer, cmds) {
    if (!buffer.startsWith('/')) return null;
    const ms = matches(buffer, cmds);
    if (ms.length === 0) return null;
    const suggestion = ms[0];
    return {
      suggestion,
      suffix: suggestion.slice(buffer.length),
      candidates: ms,
      idx: 0,
    };
  }

  export function cycleGhost(ghost, cmds) {
    if (!ghost || !ghost.candidates || ghost.candidates.length === 0) return ghost;
    const next = (ghost.idx + 1) % ghost.candidates.length;
    const suggestion = ghost.candidates[next];
    return {
      suggestion,
      suffix: suggestion.slice(suggestion.length - (suggestion.length - ghost.candidates[ghost.idx].length + ghost.suffix.length)),
      candidates: ghost.candidates,
      idx: next,
    };
  }

  export function acceptGhost(buffer, ghost) {
    if (!ghost) return buffer;
    return ghost.suggestion;
  }

  export function ghostStyle(suffix) {
    return theme.dim(suffix);
  }
  ```

  Note: the `cycleGhost.suffix` computation is fragile; for the test simply assert `g1.suggestion !== g2.suggestion`. If the suffix string is needed downstream by repl, the consumer recomputes it via `acceptGhost(buffer, g).slice(buffer.length)`.

- [ ] **4.8 — Run ghost test, confirm PASS.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-ghost.test.mjs`
  Expected: `# pass 4`, `# fail 0`.

- [ ] **4.9 — Commit.**
  ```bash
  cd /Users/o/lazyclaw && git add tui/editor.mjs tui/ghost.mjs tests/phaseC-editor.test.mjs tests/phaseC-ghost.test.mjs && git commit -m "$(cat <<'EOF'
  feat(tui): multiline editor + ink ghost autocomplete

  Pure-functional editor state machine (makeEditorState/applyKey) with
  Shift+Enter newline, Enter submit, arrow-key history, and paste
  detection per spec §5.8. Ghost autocomplete ports the v4 readline
  hint (cli.mjs:1388-1500) into ink with Tab cycle and Right-arrow
  accept semantics.
  EOF
  )"
  ```

---

## Task 5 — REPL host with interrupt-and-redirect + cli.mjs wiring

**Estimated:** 60 min. The integration step. Spec §5.8 (Esc mid-stream), §5.9 (LAZYCLAW_NO_INK opt-out), §5.10 (width safety, < 60 col fallback).

- [ ] **5.1 — Write failing interrupt test.**
  Create `/Users/o/lazyclaw/tests/phaseC-repl-interrupt.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { makeReplState, onUserInput, onEscape, onTurnComplete } from '../tui/repl.mjs';

  test('input during streaming aborts current turn and queues prepend', async () => {
    let aborted = false;
    const ctrl = { abort: () => { aborted = true; } };
    let s = makeReplState();
    s = onUserInput(s, { text: 'first task', controller: ctrl });
    assert.equal(s.streaming, true);
    s = onUserInput(s, { text: 'oh wait, do this instead', controller: ctrl });
    assert.equal(aborted, true);
    assert.equal(s.pendingPrepend, 'oh wait, do this instead');
    s = onTurnComplete(s, { reason: 'aborted' });
    assert.equal(s.streaming, false);
    assert.equal(s.nextTurnFirstMessage, 'oh wait, do this instead');
    assert.equal(s.pendingPrepend, null);
  });

  test('Esc during stream aborts cleanly without queuing prepend', () => {
    let aborted = false;
    const ctrl = { abort: () => { aborted = true; } };
    let s = makeReplState();
    s = onUserInput(s, { text: 'first', controller: ctrl });
    s = onEscape(s);
    assert.equal(aborted, true);
    assert.equal(s.pendingPrepend, null);
  });

  test('input while idle is treated as a normal new turn', () => {
    let s = makeReplState();
    s = onUserInput(s, { text: 'hello', controller: { abort: () => {} } });
    assert.equal(s.streaming, true);
    assert.equal(s.pendingPrepend, null);
  });
  ```

- [ ] **5.2 — Run test, confirm FAIL.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-repl-interrupt.test.mjs`
  Expected: `Cannot find module '../tui/repl.mjs'`.

- [ ] **5.3 — Create the REPL host.**
  Create `/Users/o/lazyclaw/tui/repl.mjs`:

  ```js
  // tui/repl.mjs — REPL host with mid-stream interrupt-and-redirect
  // (spec §5.8). Pure state functions for testability; the React
  // mount lives at the bottom and is exercised only when stdin isTTY.
  import React, { useState, useEffect } from 'react';
  import { Box, useApp } from 'ink';
  import { Splash } from './splash.mjs';
  import { Editor } from './editor.mjs';

  export function makeReplState() {
    return {
      streaming: false,
      controller: null,
      pendingPrepend: null,
      nextTurnFirstMessage: null,
      history: [],
    };
  }

  export function onUserInput(state, { text, controller }) {
    if (state.streaming && state.controller) {
      // mid-stream interrupt — abort current turn, queue text for next turn.
      try { state.controller.abort(); } catch {}
      return { ...state, pendingPrepend: text };
    }
    // idle — start a new turn.
    return {
      ...state,
      streaming: true,
      controller,
      history: [...state.history, text],
    };
  }

  export function onEscape(state) {
    if (state.streaming && state.controller) {
      try { state.controller.abort(); } catch {}
    }
    return { ...state, streaming: false, controller: null, pendingPrepend: null };
  }

  export function onTurnComplete(state, { reason } = {}) {
    void reason;
    const promoted = state.pendingPrepend;
    return {
      ...state,
      streaming: false,
      controller: null,
      pendingPrepend: null,
      nextTurnFirstMessage: promoted,
    };
  }

  export function consumeNextTurnFirstMessage(state) {
    const msg = state.nextTurnFirstMessage;
    return [{ ...state, nextTurnFirstMessage: null }, msg];
  }

  // ─── React mount ─────────────────────────────────────────────────────────
  export function ReplApp({ splashProps, runTurn }) {
    const [state, setState] = useState(makeReplState);
    const { exit } = useApp();

    async function handleSubmit(text) {
      if (text === '/exit') { exit(); return; }
      const controller = new AbortController();
      setState((s) => onUserInput(s, { text, controller }));
      try {
        await runTurn(text, controller.signal);
        setState((s) => onTurnComplete(s, { reason: 'done' }));
      } catch (err) {
        setState((s) => onTurnComplete(s, { reason: err.name === 'AbortError' ? 'aborted' : 'error' }));
      }
    }

    useEffect(() => {
      const [next, msg] = consumeNextTurnFirstMessage(state);
      if (msg) {
        setState(next);
        handleSubmit(msg);
      }
    }, [state.nextTurnFirstMessage]);

    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Splash, splashProps),
      React.createElement(Editor, { history: state.history, onSubmit: handleSubmit })
    );
  }
  ```

- [ ] **5.4 — Run interrupt test, confirm PASS.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-repl-interrupt.test.mjs`
  Expected: `# pass 3`, `# fail 0`.

- [ ] **5.5 — Wire cli.mjs to mount the ink REPL when TTY.**
  Open `/Users/o/lazyclaw/cli.mjs`. Find the location near line 1547 (the `_renderBanner` definition) and the chat REPL entry. Add a new branch — *do not delete* the existing readline/figlet path. Near where the chat REPL is invoked (search for `_renderBanner(version)` use, around line 1570), wrap the call:

  ```js
  // v5 ink splash + REPL when stdin is a real TTY and the user has not
  // opted out via LAZYCLAW_NO_INK=1. Non-TTY pipelines and the opt-out
  // env var fall through to the v4 figlet + readline path unchanged.
  const __useInkSplash = process.stdout.isTTY && !process.env.LAZYCLAW_NO_INK;
  if (__useInkSplash) {
    try {
      const { render } = await import('ink');
      const { ReplApp } = await import('./tui/repl.mjs');
      const { renderSplashToString } = await import('./tui/splash.mjs');
      // narrow-terminal fallback: <60 cols falls back to v4
      if ((process.stdout.columns || 80) < 60) throw new Error('narrow-terminal');
      const splashProps = {
        provider: cfg.provider, model: cfg.model,
        trainer: cfg.trainer || {}, sessionId: sessionId || '',
        cwd: process.cwd(),
        tools: [], skills: [],
      };
      void renderSplashToString; // surfaced for tests; runtime uses <Splash/>
      const ink = render(/* @__PURE__ */ React.createElement(ReplApp, {
        splashProps,
        runTurn: async (text, signal) => { await __runChatTurn(text, { signal }); },
      }));
      await ink.waitUntilExit();
      return;
    } catch (e) {
      // Fall through to legacy path on any ink failure (missing import,
      // narrow terminal, sandboxed stdout).
      if (process.env.LAZYCLAW_DEBUG) console.error('[ink] fallback:', e.message);
    }
  }
  // ─── legacy v4 path (unchanged) ─────────────────────────────────
  // (existing _renderBanner + readline + ghost code stays here)
  ```

  The reference to `React`, `__runChatTurn`, and `sessionId` must be wired against the existing names in `cli.mjs`. If `React` is not yet imported at the top, add at the top of `cli.mjs`:

  ```js
  // v5 TUI (lazy-loaded — only mounted in the ink branch)
  let React;
  try { React = (await import('react')).default; } catch {}
  ```

  Place this near the other top-level imports. The legacy path remains intact; the ink branch is purely additive.

- [ ] **5.6 — Verify legacy path still loads under LAZYCLAW_NO_INK.**
  Run: `LAZYCLAW_NO_INK=1 cd /Users/o/lazyclaw && node -e "import('./cli.mjs').then(() => console.log('loaded'))"`
  Expected: prints `loaded` without throwing. (The CLI may then prompt for input — Ctrl-C is fine; the goal is to confirm the module loads.)

- [ ] **5.7 — Run the full Phase C test suite.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-*.test.mjs`
  Expected: all five new test files pass — total `# pass 19`, `# fail 0`.

- [ ] **5.8 — Commit.**
  ```bash
  cd /Users/o/lazyclaw && git add tui/repl.mjs tests/phaseC-repl-interrupt.test.mjs cli.mjs && git commit -m "$(cat <<'EOF'
  feat(tui): interrupt-and-redirect REPL + cli.mjs ink mount

  Mid-stream user input aborts the current turn and is queued as the
  first message of the next turn (spec §5.8). Esc aborts cleanly with
  no queued prepend. cli.mjs gains a TTY-gated ink branch that mounts
  <ReplApp/>; the v4 figlet + readline path stays as the explicit
  fallback for LAZYCLAW_NO_INK=1, non-TTY pipelines, and terminals
  narrower than 60 columns (spec §5.9, §5.10).
  EOF
  )"
  ```

---

## Acceptance verification

Run all four checks in order. Each must pass before Phase C is considered done.

- [ ] **A1 — TTY splash renders at 80+ cols.**
  Run: `cd /Users/o/lazyclaw && stty cols 80 && node -e "import('./tui/splash.mjs').then(({renderSplashToString}) => console.log(renderSplashToString({provider:'claude-cli',model:'sonnet-4.7',trainer:{provider:'claude-cli',model:'haiku-4.5'},sessionId:'7af9abcd',cwd:process.cwd(),tools:[{category:'fs',sensitive:false,verbs:['read','write','edit']}],skills:[{group:'dev',names:['review','debug']}]})))"`
  Expected: prints the two-column splash with the sloth on the left, tool/skill columns on the right, and four footer lines. No line exceeds 80 cells (verify with `awk '{print length}'`).

- [ ] **A2 — Shift+Enter multiline.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-editor.test.mjs`
  Expected: the "Shift+Enter inserts a literal newline" test passes.

- [ ] **A3 — Mid-stream input redirect works.**
  Run: `cd /Users/o/lazyclaw && node --test tests/phaseC-repl-interrupt.test.mjs`
  Expected: the "input during streaming aborts current turn and queues prepend" test passes.

- [ ] **A4 — Non-TTY falls back, sloth ASCII validates ≤24 cols.**
  Run: `cd /Users/o/lazyclaw && LAZYCLAW_NO_INK=1 node -e "import('./cli.mjs').then(() => process.exit(0))" && node --test tests/phaseC-build-splash.test.mjs`
  Expected: the cli.mjs import resolves (legacy figlet path is used), and the banner-width assertion passes (every row's string-width ≤ 24).

---

## Notes for the executing agent

- **Do not edit `tui/banner.generated.mjs` by hand.** Re-run `npm run build:splash` whenever `docs/assets/sleepy-sloth-source.png` changes.
- **Preserve the legacy readline path.** The ink branch in `cli.mjs` is purely additive — if any later refactor removes the v4 figlet/readline block, the `LAZYCLAW_NO_INK=1` opt-out and the `< 60 col` fallback both break, violating spec §5.9.
- **Provider id casing.** All user-facing references use kebab-case (`claude-cli`, not `claude_cli`) per canonical decision C3. The internal `.mjs` filenames retain underscores — only strings in `tools[].category`, `trainer.provider`, footer text use kebab-case.
- **SKILL.md `group:` fallback.** When Task 3's splash receives a skill without an explicit `group:` frontmatter, the caller in `cli.mjs` must apply the C5 rule: filename hyphen-prefix → `legacy` (not `misc`). This Phase C plan accepts the grouped fixture directly; the grouping logic itself lives in Phase B's skill-resolver work.
- **`trainer === provider` transparency.** Footer line 2 always renders, even when the trainer matches the chat provider (spec §5.7).
- **better-sqlite3, USER.md, sandbox enum, personality directory** are out of scope for Phase C — they live in Phases B, D, E. Do not import or reference them from `tui/`.
