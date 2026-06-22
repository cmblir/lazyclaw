// workflow/yaml_min.mjs — a MINIMAL, dependency-free block-YAML parser for
// declarative workflow definitions. NOT a full YAML implementation (no anchors,
// aliases, tags, multi-document, or complex keys) — it covers exactly what a
// workflow def needs and errors clearly on anything else rather than guessing:
//   - block mappings        key: value
//   - block sequences       - item
//   - sequences of mappings  - id: a\n  type: b   (the `nodes:` shape)
//   - scalars               strings / numbers / true / false / null
//   - quoted strings        "x" / 'x'
//   - inline JSON flow       [a, b] / {k: v}      (delegated to JSON.parse)
//   - block scalars         | (literal) / > (folded)   (good for llm prompts)
// Tabs are rejected (YAML forbids them for indentation). The result is a plain
// JS value passed to validateWorkflow, so a bad def still fails the same checks.

export class YamlMinError extends Error {
  constructor(message) { super(message); this.name = 'YamlMinError'; this.code = 'YAML_MIN'; }
}

function scalar(text) {
  const s = text.trim();
  if (s === '') return null;
  // A flow indicator ([ or {) must be valid inline JSON — error rather than
  // silently treating an unclosed/garbled flow value as a string.
  if (s[0] === '[' || s[0] === '{') {
    try { return JSON.parse(s); } catch (e) { throw new YamlMinError(`invalid inline JSON: ${s}`); }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s[0] === '"' && s[s.length - 1] === '"') { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  return s;
}

export function parseYamlMin(text) {
  const src = String(text).replace(/\r\n/g, '\n').split('\n');
  // Keep raw lines but track logical (non-blank/comment) ones with their index.
  const lines = [];
  for (const raw of src) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    if (/^\s*\t/.test(raw)) throw new YamlMinError('tabs are not allowed for indentation');
    lines.push(raw);
  }
  let i = 0;
  const indentOf = (l) => l.length - l.trimStart().length;
  const curIndent = () => (i < lines.length ? indentOf(lines[i]) : -1);

  function parseBlock(indent) {
    const t = lines[i].trim();
    return (t === '-' || t.startsWith('- ')) ? parseSeq(indent) : parseMap(indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && indentOf(lines[i]) === indent) {
      const line = lines[i].trim();
      const ci = line.indexOf(':');
      if (ci < 0) throw new YamlMinError(`expected "key: value", got: ${line}`);
      const key = line.slice(0, ci).trim();
      const rest = line.slice(ci + 1).trim();
      i++;
      if (rest === '|' || rest === '>') { obj[key] = blockScalar(indent, rest); }
      else if (rest === '') {
        obj[key] = (i < lines.length && curIndent() > indent) ? parseBlock(curIndent()) : null;
      } else { obj[key] = scalar(rest); }
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (i < lines.length && indentOf(lines[i]) === indent && (lines[i].trim() === '-' || lines[i].trim().startsWith('- '))) {
      const rest = lines[i].trim().slice(1).trim();
      if (rest === '') { i++; arr.push(curIndent() > indent ? parseBlock(curIndent()) : null); }
      else if (/^[^[{"'][^:]*:(\s|$)/.test(rest)) {
        // "- key: val ..." → a mapping item; re-emit the first key at indent+2
        // so parseMap reads it together with this item's deeper-indented keys.
        lines[i] = ' '.repeat(indent + 2) + rest;
        arr.push(parseMap(indent + 2));
      } else { i++; arr.push(scalar(rest)); }
    }
    return arr;
  }

  function blockScalar(parentIndent, style) {
    const out = [];
    while (i < lines.length && indentOf(lines[i]) > parentIndent) {
      out.push(lines[i].slice(parentIndent + 2));
      i++;
    }
    return out.join(style === '>' ? ' ' : '\n');
  }

  if (i >= lines.length) return {};
  return parseBlock(curIndent());
}
