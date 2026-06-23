// tui/wizard_back.mjs — drive a sequence of setup-wizard steps with Esc-back.
//
// Each step runs its own I/O and returns one of:
//   'BACK'   — the user pressed Esc → re-run the previous step
//   'CANCEL' — abort the whole group
//   (anything else) — advance to the next step
// Esc on the FIRST step stays on it (there's nothing before it in the group).
// Pure control flow (the steps do the prompting) so it's unit-testable.

export async function runWizardSteps(stepIds, runStep) {
  let i = 0;
  while (i < stepIds.length) {
    const r = await runStep(stepIds[i], i);
    if (r === 'CANCEL') return 'CANCEL';
    if (r === 'BACK') { i = i > 0 ? i - 1 : 0; continue; }
    i += 1;
  }
  return 'DONE';
}
