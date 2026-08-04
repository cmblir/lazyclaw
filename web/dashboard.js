// web/dashboard.js — entry point. <script type="module" src="/dashboard.js">
// Mounts the grouped-sidebar shell. Real panel bodies move here one module
// per file in dashboard-shell-motion Task 4 (see web/ui/panels/); ids not
// yet moved still fall back to a placeholder so every panel renders.
import { mount } from '/ui/shell.mjs';
import { el } from '/ui/dom.mjs';
import { ALL } from '/ui/nav_model.mjs';

import * as chat from '/ui/panels/chat.mjs';
import * as tasks from '/ui/panels/tasks.mjs';
import * as sessions from '/ui/panels/sessions.mjs';
import * as agents from '/ui/panels/agents.mjs';
import * as teams from '/ui/panels/teams.mjs';
import * as team from '/ui/panels/team.mjs';
import * as workflows from '/ui/panels/workflows.mjs';
import * as scheduling from '/ui/panels/scheduling.mjs';
import * as trainer from '/ui/panels/trainer.mjs';
import * as skills from '/ui/panels/skills.mjs';
import * as recall from '/ui/panels/recall.mjs';
import * as sandbox from '/ui/panels/sandbox.mjs';
import * as approvals from '/ui/panels/approvals.mjs';
import * as gateway from '/ui/panels/gateway.mjs';

const panels = {};
for (const { id, label } of ALL) {
  panels[id] = { render: (host) => { host.append(el('h2', { text: label })); } };
}
Object.assign(panels, {
  chat, tasks, sessions, agents, teams, team, workflows, scheduling, trainer,
  skills, recall, sandbox, approvals, gateway,
});

mount({ panels });
