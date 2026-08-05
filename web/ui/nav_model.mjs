// web/ui/nav_model.mjs — the panel registry. Pure data so it can be unit
// tested and so the sidebar, the hash router, and the command palette all
// read one source of truth. Panel ids are the URL hash: never rename one
// without accepting that existing deep links break.
export const GROUPS = [
  { name: 'Work', items: [
    { id: 'chat', label: 'Chat', glyph: '>' },
    { id: 'tasks', label: 'Tasks', glyph: '◇' },
    { id: 'sessions', label: 'Sessions', glyph: '≡' },
  ] },
  { name: 'Agents', items: [
    { id: 'agents', label: 'Agents', glyph: '@' },
    { id: 'teams', label: 'Teams', glyph: '⊞' },
    { id: 'team', label: 'Team Live', glyph: '◉' },
  ] },
  { name: 'Automate', items: [
    { id: 'workflows', label: 'Workflows', glyph: '⇉' },
    { id: 'scheduling', label: 'Scheduling', glyph: '◷' },
    { id: 'trainer', label: 'Trainer', glyph: '△' },
  ] },
  { name: 'Knowledge', items: [
    { id: 'skills', label: 'Skills', glyph: '✦' },
    { id: 'recall', label: 'Recall', glyph: '⌕' },
    { id: 'sandbox', label: 'Sandbox', glyph: '▢' },
  ] },
  { name: 'Gateway', items: [
    { id: 'approvals', label: 'Approvals', glyph: '!' },
    { id: 'gateway', label: 'Devices', glyph: '⧉' },
  ] },
  { name: 'System', items: [
    { id: 'providers', label: 'Providers', glyph: '⌗' },
    { id: 'rates', label: 'Rates', glyph: '¤' },
    { id: 'metrics', label: 'Metrics', glyph: '⌸' },
    { id: 'doctor', label: 'Doctor', glyph: '✚' },
    { id: 'config', label: 'Config', glyph: '⚙' },
    { id: 'status', label: 'Status', glyph: '◍' },
    { id: 'channels', label: 'Channels', glyph: '⇄' },
  ] },
];

export const ALL = GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.name })));
