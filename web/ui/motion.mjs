// web/ui/motion.mjs — the imperative half of the motion system. CSS owns
// anything expressible as a transition or keyframe; this module owns what
// CSS cannot: FLIP across a re-render, and toggling the ambient token when
// the tab is hidden.
//
// Every entry point that plays an animation no-ops under prefers-reduced-motion
// so callers do not each have to remember to check.

const RM = matchMedia('(prefers-reduced-motion: reduce)');
export function reduced() { return RM.matches; }

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
