// web/ui/motion.mjs — the imperative half of the motion system. CSS owns
// anything expressible as a transition or keyframe; this module owns the
// three things it cannot do: restarting an animation on a reused node,
// FLIP across a re-render, and tweening a number.
//
// Every entry point no-ops under prefers-reduced-motion so callers do not
// each have to remember to check.

const RM = matchMedia('(prefers-reduced-motion: reduce)');
export function reduced() { return RM.matches; }

// Re-running a CSS animation on a node that was NOT replaced needs the
// animation cancelled and replayed; toggling a class in one task does not
// restart it because no style recalc happens in between.
export function restartEnter(node) {
  if (reduced()) return;
  node.getAnimations().forEach((a) => { a.cancel(); a.play(); });
}

export function captureRects(nodesByKey) {
  const out = new Map();
  for (const [k, node] of nodesByKey) out.set(k, node.getBoundingClientRect());
  return out;
}

// FLIP: play each surviving node from where it used to be to where it is now.
// This is the payoff for keyed updates — a full innerHTML swap loses the old
// boxes and the animation with them.
export function playFlip(before, nodesByKey) {
  if (reduced()) return;
  for (const [k, node] of nodesByKey) {
    const old = before.get(k);
    if (!old) continue;
    const now = node.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (!dx && !dy) continue;
    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }
}

// Count a value up instead of snapping. One rAF chain per call; the easing
// matches the TUI's ctx-gauge tween so the two surfaces feel the same.
export function tweenNumber(node, to, { dp = 0, prefix = '', suffix = '', ms = 620 } = {}) {
  const fmt = (v) => prefix + v.toFixed(dp) + suffix;
  if (reduced()) { node.textContent = fmt(to); return; }
  let t0 = null;
  const step = (ts) => {
    if (t0 === null) t0 = ts;
    const p = Math.min(1, (ts - t0) / ms);
    node.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  node.textContent = fmt(0);
  requestAnimationFrame(step);
}

// Ambient motion is the only always-on animation. Stop it when the tab is
// hidden so a dashboard left open all day is not spending battery.
export function watchVisibility() {
  const apply = () => {
    document.documentElement.style.setProperty(
      '--ambient', document.visibilityState === 'hidden' || reduced() ? '0' : '1');
  };
  document.addEventListener('visibilitychange', apply);
  RM.addEventListener('change', apply);
  apply();
}
