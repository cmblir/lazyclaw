// mas/frontmatter.mjs — the single shared frontmatter parser.
//
// Historically four divergent parsers (skills.parseFrontmatter,
// index_rank._miniFrontmatter, tools/learning._parseFm, and an inline regex
// in tools/recall) disagreed on quoting and list handling, so values quoted
// by skill_synth.escapeYaml (e.g. `group: "-weird"`) could persist with stray
// quotes through a reindex/edit — silent metadata drift. This module is the
// UNION of those four behaviors: robust fence handling + correct unquoting
// (symmetric with escapeYaml) + simple inline block lists (cross_cli_tested).
// Zero-dependency; only the flat `key: value` (+ one level of list-of-objects)
// shape our skills use is supported — no general YAML.

// Strip matching surrounding quotes from a scalar value. Double quotes are
// unescaped symmetric with skill_synth.escapeYaml (\" → ", \\ → \); single
// quotes are taken literally (that variant never escapes). A bare value is
// returned untouched.
export function unquote(raw) {
  const val = String(raw ?? '').trim();
  if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
    return val.slice(1, -1);
  }
  return val;
}

// A key line inside the frontmatter block: `key: value`.
const KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
// A list-item line: `  - subkey: value` (start of an object entry).
const ITEM_START_RE = /^\s*-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
// A continuation line for the current list item: `    subkey: value`.
const ITEM_CONT_RE = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

// Parse a leading YAML-ish frontmatter block (--- … ---). Returns
// { meta, body }; when no frontmatter is present meta is {} and body is the
// untouched content. Flat `key: value` scalars are unquoted. A `key:` with no
// value followed by indented `- subkey: value` items becomes an array of
// objects (used for cross_cli_tested).
export function parseFrontmatter(content) {
  const text = String(content ?? '');
  if (!text.startsWith('---')) return { meta: {}, body: text };
  // The opening fence must be its own line.
  const afterOpen = text.slice(3);
  if (!/^\r?\n/.test(afterOpen)) return { meta: {}, body: text };
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(afterOpen);
  if (!m) return { meta: {}, body: text };
  const block = afterOpen.slice(0, m.index);
  // Drop blank lines between the closing fence and the first body line so
  // callers can rely on body starting at real content.
  const body = afterOpen.slice(m.index + m[0].length).replace(/^(?:\r?\n)+/, '');
  const meta = parseBlock(block);
  return { meta, body };
}

// Parse the inner block (between the fences) into a flat meta object,
// promoting indented `- key: value` runs under a bare `key:` into arrays.
function parseBlock(block) {
  const meta = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i += 1; continue; }
    const kv = KEY_RE.exec(trimmed);
    if (!kv) { i += 1; continue; }
    const key = kv[1];
    const rawVal = kv[2];
    // A bare `key:` (no scalar) may head an indented list-of-objects block.
    if (rawVal === '' && isListItem(lines[i + 1])) {
      const [list, next] = parseList(lines, i + 1);
      meta[key] = list;
      i = next;
      continue;
    }
    meta[key] = unquote(rawVal);
    i += 1;
  }
  return meta;
}

function isListItem(line) {
  return line != null && ITEM_START_RE.test(line);
}

// Consume a run of `- subkey: value` items (plus their indented
// continuations) starting at index `start`. Returns [items, nextIndex].
function parseList(lines, start) {
  const items = [];
  let i = start;
  let current = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }
    const startM = ITEM_START_RE.exec(line);
    if (startM) {
      current = {};
      current[startM[1]] = unquote(startM[2]);
      items.push(current);
      i += 1;
      continue;
    }
    const contM = current && ITEM_CONT_RE.exec(line);
    if (contM) {
      current[contM[1]] = unquote(contM[2]);
      i += 1;
      continue;
    }
    // A non-indented / non-item line ends the list.
    break;
  }
  return [items, i];
}
