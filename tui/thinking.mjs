// tui/thinking.mjs — the "waiting for the first token" indicator.
//
// A turn can sit silent for seconds before the provider emits anything (cold
// CLI start, long prompt, orchestrator planning). The status bar's spinner
// says "streaming", which is a lie during that window; this says what is
// actually happening, in the live region where the reply will appear.
import React from 'react';
import { Text } from 'ink';
import { spinnerFrame, SPINNER_MS, motionEnabled, useMotion } from './motion.mjs';

export function thinkingLabel(tick) {
  return `${spinnerFrame(tick)} thinking…`;
}

export function Thinking({ active }) {
  // Short-circuit BEFORE the hook so an inactive render costs nothing and the
  // component can be called directly in a test without a renderer.
  if (!active || !motionEnabled()) return null;
  return React.createElement(ThinkingFrame, null);
}

function ThinkingFrame() {
  const tick = useMotion(true, SPINNER_MS);
  return React.createElement(Text, { dimColor: true }, thinkingLabel(tick));
}
