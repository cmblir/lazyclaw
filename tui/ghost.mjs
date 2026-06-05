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
