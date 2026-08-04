// web/ui/panels/gateway.mjs — paired devices for the Slack/gateway bridge.
// No daemon route exists yet: GET /devices lands in dashboard-shell-motion
// Task 12. Placeholder only — no fetch until that route exists.
import { phead, banner } from '../dom.mjs';

export function render(host) {
  host.append(phead('Devices', 'Devices paired to this gateway.'));
  host.append(banner('warn', '!', 'The GET /devices route lands in a later task. Nothing to show yet.'));
}
