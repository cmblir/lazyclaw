// web/ui/panels/approvals.mjs — pending approvals for gated agent actions.
// No daemon route exists yet: GET /approvals lands in dashboard-shell-motion
// Task 12. Placeholder only — no fetch until that route exists.
import { phead, banner } from '../dom.mjs';

export function render(host) {
  host.append(phead('Approvals', 'Actions waiting on a human before an agent can proceed.'));
  host.append(banner('warn', '!', 'The GET /approvals route lands in a later task. Nothing to show yet.'));
}
