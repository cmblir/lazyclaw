// web/dashboard.js — entry point. <script type="module" src="/dashboard.js">
// Mounts the grouped-sidebar shell. Real panel bodies move here one module
// per file in dashboard-shell-motion Task 4 (see web/ui/panels/); until then
// every id renders a placeholder so the shell, hash router, and marker can
// be exercised end to end.
import { mount } from '/ui/shell.mjs';
import { el } from '/ui/dom.mjs';
import { ALL } from '/ui/nav_model.mjs';

const panels = {};
for (const { id, label } of ALL) {
  panels[id] = { render: (host) => { host.append(el('h2', { text: label })); } };
}

mount({ panels });
