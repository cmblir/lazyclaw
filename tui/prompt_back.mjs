// tui/prompt_back.mjs — a raw-mode line prompt that can return BACK on Esc.
//
// The setup wizard's typed questions used cooked-mode readline, which never
// sees Esc (it only resolves on Enter), so "Esc to go back a step" did nothing.
// This reads keys in raw mode: Enter submits, Esc goes back, arrow keys (which
// are Esc-PREFIXED sequences) are ignored, Backspace edits, Ctrl-C cancels.
//
// classifyKey is pure (unit-tested); promptWithBack is driven by an injectable
// input/output so it's testable with a fake TTY (no real keyboard).

// Map a raw input chunk to an action. A LONE Esc is "back"; an Esc that begins
// an escape sequence (\x1b[ or \x1bO — arrows, function keys) is "escseq" and
// must be ignored so navigation keys don't fire "back".
export function classifyKey(chunk) {
  const s = String(chunk == null ? '' : chunk);
  if (s === '\x1b') return { type: 'back' };
  if (/^\x1b[[O]/.test(s)) return { type: 'escseq' };
  if (s === '\r' || s === '\n' || s === '\r\n') return { type: 'submit' };
  if (s === '\x03') return { type: 'cancel' };           // Ctrl-C
  if (s === '\x7f' || s === '\b') return { type: 'backspace' };
  const text = s.replace(/[\x00-\x1f\x7f]/g, '');         // strip control bytes
  return text ? { type: 'text', text } : { type: 'ignore' };
}

// Prompt for a line, resolving { value, back }. `back` is true when the user
// pressed Esc. Falls back to a plain (no-Esc) readline on a non-TTY input.
// escDelayMs disambiguates a lone Esc from an Esc-sequence that arrives split
// across two data events (rare, but some terminals do it).
export function promptWithBack(label, opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const escDelayMs = opts.escDelayMs == null ? 40 : opts.escDelayMs;

  if (!(input.isTTY && typeof input.setRawMode === 'function')) {
    return _plainLine(label, input, output);
  }

  return new Promise((resolve) => {
    output.write('\n' + label);
    try { input.setRawMode(true); } catch { /* ignore */ }
    input.resume();
    // resume() does NOT re-reference an unref'd handle, and _arrowMenu's
    // cleanup unrefs process.stdin (tui/pickers.mjs) so `lazyclaw setup` can
    // exit rather than hang. Without this ref() a backPrompt that follows an
    // arrow menu — the wizard's context-window step into the permission step —
    // attaches its listener to an unreferenced handle, the event loop drains,
    // and node exits 0 with the prompt on screen and the answer never read.
    // _quickPrompt pairs resume()+ref() for the same reason.
    if (input.ref) input.ref();
    let buf = '';
    let escTimer = null;
    const finish = (result) => {
      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
      input.off('data', onData);
      try { input.setRawMode(false); } catch { /* ignore */ }
      output.write('\n');
      resolve(result);
    };
    const onData = (d) => {
      const s = d.toString('utf8');
      // A lone Esc byte: wait briefly — if a [ / O follows it was an arrow/nav
      // sequence (ignore), otherwise it's a real Esc (back).
      if (s === '\x1b') {
        escTimer = setTimeout(() => { escTimer = null; finish({ value: '', back: true }); }, escDelayMs);
        return;
      }
      if (escTimer) {
        clearTimeout(escTimer); escTimer = null;
        if (/^[[O]/.test(s)) return;   // the tail of a split Esc-sequence
      }
      const k = classifyKey(s);
      switch (k.type) {
        case 'escseq': case 'ignore': return;
        case 'back': return finish({ value: '', back: true });
        case 'submit': return finish({ value: buf.trim(), back: false });
        case 'cancel': finish({ value: '', back: false, cancel: true }); try { process.exit(130); } catch { /* tests */ } return;
        case 'backspace': if (buf) { buf = buf.slice(0, -1); output.write('\b \b'); } return;
        case 'text': buf += k.text; output.write(k.text); return;
        default: return;
      }
    };
    input.on('data', onData);
  });
}

async function _plainLine(label, input, output) {
  const readline = await import('node:readline');
  output.write('\n');
  const rl = readline.createInterface({ input, output });
  const value = await new Promise((res) => rl.question(label, res));
  rl.close();
  return { value: String(value).trim(), back: false };
}
