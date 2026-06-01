import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Phase 23 — skills curator (lifecycle).
//
// A usage tracker + classifier + archiver layered over the existing
// <configDir>/skills/ store from skills.mjs. Every time-dependent
// function takes an injected `now` (epoch-ms) so the boundaries are
// deterministic and the wall-clock never leaks into the core logic.
//
//   recordUsage(name, configDir, now)  → bump per-skill counters
//   usageOf(name, configDir)           → read a skill's counters
//   classify(name, configDir, now)     → 'active' | 'stale' | 'archived'
//   curate(configDir, now)             → archive idle AGENT skills only

const REPO_ROOT = process.cwd();

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

async function loadCurator() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'skills_curator.mjs')).href;
  return await import(url) as typeof import('../skills_curator.mjs');
}

async function loadSkills() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'skills.mjs')).href;
  return await import(url) as typeof import('../skills.mjs');
}

const DAY = 24 * 60 * 60 * 1000;

// Build a SKILL.md whose frontmatter carries a given created_by so the
// curator can tell agent-authored skills from human-curated ones.
function writeSkill(configDir: string, name: string, createdBy: string) {
  const dir = path.join(configDir, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  const doc = [
    '---',
    `name: ${name}`,
    `description: a ${createdBy} skill`,
    'version: 1',
    `created_by: ${createdBy}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Body content.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${name}.md`), doc);
}

test.describe('Phase 23 — skills curator', () => {
  test('STALE_MS and ARCHIVE_MS are the 30d / 90d constants', async () => {
    const mod = await loadCurator();
    expect(mod.STALE_MS).toBe(30 * DAY);
    expect(mod.ARCHIVE_MS).toBe(90 * DAY);
  });

  test('recordUsage creates the usage file and increments per-skill counters', async () => {
    const cfg = tmpDir('p23-record');
    const mod = await loadCurator();
    const t0 = Date.UTC(2026, 0, 1);

    // No usage yet → zeroed view.
    const before = mod.usageOf('writer', cfg);
    expect(before.uses).toBe(0);
    expect(before.lastUsedAt).toBe(0);

    mod.recordUsage('writer', cfg, t0);
    const after1 = mod.usageOf('writer', cfg);
    expect(after1.uses).toBe(1);
    expect(after1.lastUsedAt).toBe(t0);

    // The store lives at <configDir>/skills/.usage.json.
    const store = path.join(cfg, 'skills', '.usage.json');
    expect(fs.existsSync(store)).toBe(true);

    const t1 = t0 + 5 * DAY;
    mod.recordUsage('writer', cfg, t1);
    const after2 = mod.usageOf('writer', cfg);
    expect(after2.uses).toBe(2);
    expect(after2.lastUsedAt).toBe(t1);

    // A second skill is tracked independently.
    mod.recordUsage('planner', cfg, t1);
    expect(mod.usageOf('planner', cfg).uses).toBe(1);
    expect(mod.usageOf('writer', cfg).uses).toBe(2);
  });

  test('classify returns active / stale / archived at the right boundaries', async () => {
    const cfg = tmpDir('p23-classify');
    const mod = await loadCurator();
    const used = Date.UTC(2026, 0, 1);
    mod.recordUsage('writer', cfg, used);

    // Just used → active.
    expect(mod.classify('writer', cfg, used)).toBe('active');

    // 29 days later → still active (within 30d window).
    expect(mod.classify('writer', cfg, used + 29 * DAY)).toBe('active');

    // Exactly at 30d → no longer active → stale.
    expect(mod.classify('writer', cfg, used + 30 * DAY)).toBe('stale');

    // 89 days → stale (between 30d and 90d).
    expect(mod.classify('writer', cfg, used + 89 * DAY)).toBe('stale');

    // Exactly 90 days idle → archived.
    expect(mod.classify('writer', cfg, used + 90 * DAY)).toBe('archived');

    // 120 days → archived.
    expect(mod.classify('writer', cfg, used + 120 * DAY)).toBe('archived');
  });

  test('classify treats a never-used skill as archived once the clock is past the archive window', async () => {
    const cfg = tmpDir('p23-never');
    const mod = await loadCurator();
    writeSkill(cfg, 'unused', 'agent');
    // No usage recorded → lastUsedAt is 0; at a real epoch it's far past 90d.
    expect(mod.classify('unused', cfg, Date.UTC(2026, 0, 1))).toBe('archived');
  });

  test('curate archives a 91-day-idle agent skill, leaves a human skill and a fresh agent skill in place', async () => {
    const cfg = tmpDir('p23-curate');
    const mod = await loadCurator();
    const skills = await loadSkills();

    const now = Date.UTC(2026, 5, 1);

    // 1) an agent skill last used 91 days ago → should be archived.
    writeSkill(cfg, 'idle-agent', 'agent');
    mod.recordUsage('idle-agent', cfg, now - 91 * DAY);

    // 2) a human skill, also 91 days idle → must NOT be archived.
    writeSkill(cfg, 'human-skill', 'human');
    mod.recordUsage('human-skill', cfg, now - 91 * DAY);

    // 3) a fresh agent skill, used yesterday → stays active.
    writeSkill(cfg, 'fresh-agent', 'agent');
    mod.recordUsage('fresh-agent', cfg, now - 1 * DAY);

    const result = mod.curate(cfg, now);

    // The idle agent skill is the only thing archived.
    expect(result.archived).toEqual(['idle-agent']);
    expect(result.active).toContain('fresh-agent');

    const skillsDir = path.join(cfg, 'skills');
    const archiveDir = path.join(skillsDir, '.archive');

    // idle-agent moved out of the live store into .archive/.
    expect(fs.existsSync(path.join(skillsDir, 'idle-agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, 'idle-agent.md'))).toBe(true);
    // Archived doc is recoverable — contents preserved verbatim.
    expect(fs.readFileSync(path.join(archiveDir, 'idle-agent.md'), 'utf8')).toContain('created_by: agent');

    // human skill stays in the live store even though it's idle.
    expect(fs.existsSync(path.join(skillsDir, 'human-skill.md'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'human-skill.md'))).toBe(false);

    // fresh agent skill stays put.
    expect(fs.existsSync(path.join(skillsDir, 'fresh-agent.md'))).toBe(true);

    // listSkills no longer surfaces the archived skill (it's in a dotted
    // subdir, not a top-level .md).
    const names = skills.listSkills(cfg).map((s) => s.name);
    expect(names).not.toContain('idle-agent');
    expect(names).toContain('human-skill');
    expect(names).toContain('fresh-agent');
  });

  // ── Hardening regression tests ────────────────────────────────────

  test('recordUsage survives prototype-pollution skill names (__proto__ etc.)', async () => {
    const cfg = tmpDir('p23-proto');
    const mod = await loadCurator();
    const used = Date.UTC(2026, 0, 1);

    // A skill named after a reserved Object.prototype key must NOT slip
    // through the prototype chain: its counters have to round-trip as a
    // real own record rather than being silently dropped.
    for (const evil of ['__proto__', 'constructor', 'prototype']) {
      mod.recordUsage(evil, cfg, used);
      const rec = mod.usageOf(evil, cfg);
      expect(rec.uses).toBe(1);
      expect(rec.lastUsedAt).toBe(used);

      // A second bump must accumulate, proving the record actually
      // persisted (not aliased onto the prototype).
      mod.recordUsage(evil, cfg, used + 1 * DAY);
      const rec2 = mod.usageOf(evil, cfg);
      expect(rec2.uses).toBe(2);
      expect(rec2.lastUsedAt).toBe(used + 1 * DAY);
    }

    // The on-disk store must be a clean record map, never a polluted
    // global prototype: a fresh object's toString must stay intact.
    expect(({} as Record<string, unknown>).toString).toBe(Object.prototype.toString);
    const raw = JSON.parse(
      fs.readFileSync(path.join(cfg, 'skills', '.usage.json'), 'utf8'),
    );
    // The reserved keys are stored as ordinary own properties.
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true);
  });

  test('usageOf does not inherit counters from a hostile usage file', async () => {
    const cfg = tmpDir('p23-proto-read');
    const mod = await loadCurator();
    const dir = path.join(cfg, 'skills');
    fs.mkdirSync(dir, { recursive: true });

    // A hostile/corrupt usage file tries to plant inherited fields. A
    // skill that has no OWN record must still read as a clean zeroed
    // record — inherited prototype values must not leak through.
    fs.writeFileSync(
      path.join(dir, '.usage.json'),
      JSON.stringify({ __proto__: { uses: 999, lastUsedAt: 42 } }),
    );

    const rec = mod.usageOf('never-recorded', cfg);
    expect(rec.uses).toBe(0);
    expect(rec.lastUsedAt).toBe(0);
  });

  test('curate skips a dotfile skill instead of aborting the whole sweep', async () => {
    const cfg = tmpDir('p23-dotfile');
    const mod = await loadCurator();

    const now = Date.UTC(2026, 5, 1);
    const dir = path.join(cfg, 'skills');
    fs.mkdirSync(dir, { recursive: true });

    // A legitimate idle agent skill that MUST get archived.
    writeSkill(cfg, 'idle-agent', 'agent');
    mod.recordUsage('idle-agent', cfg, now - 91 * DAY);

    // A hostile dotfile: '.evil.md' yields a leading-dot skill name that
    // skillPath() rejects. Before the fix this throws and aborts curate()
    // entirely, so 'idle-agent' is never reached.
    fs.writeFileSync(
      path.join(dir, '.evil.md'),
      ['---', 'name: .evil', 'created_by: agent', '---', '', '# evil', ''].join('\n'),
    );

    // Must not throw, and must still archive the legitimate skill.
    const result = mod.curate(cfg, now);
    expect(result.archived).toContain('idle-agent');
    expect(fs.existsSync(path.join(dir, '.archive', 'idle-agent.md'))).toBe(true);

    // The invalid name is surfaced for the caller, never silently lost.
    expect(result.invalid).toContain('.evil');
  });

  test('moveToArchive does not clobber a prior archived copy of the same name', async () => {
    const cfg = tmpDir('p23-collision');
    const mod = await loadCurator();
    const now = Date.UTC(2026, 5, 1);

    const skillsRoot = path.join(cfg, 'skills');
    const archiveDir = path.join(skillsRoot, '.archive');

    // Seed a pre-existing archived copy that must survive.
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'collide.md'), 'OLD ARCHIVED COPY');

    // A new live agent skill with the SAME name, long idle → archived.
    // Keep the agent frontmatter (so it qualifies for archival) but mark
    // the body so we can tell the new copy from the seeded old one.
    fs.writeFileSync(
      path.join(skillsRoot, 'collide.md'),
      ['---', 'name: collide', 'created_by: agent', '---', '', 'NEW LIVE COPY', ''].join('\n'),
    );
    mod.recordUsage('collide', cfg, now - 91 * DAY);

    mod.curate(cfg, now);

    // The original archived copy must still exist, untouched.
    const archived = fs.readdirSync(archiveDir).filter((n) => n.startsWith('collide'));
    // Both copies present (original + disambiguated new one).
    expect(archived.length).toBe(2);
    const blob = archived
      .map((n) => fs.readFileSync(path.join(archiveDir, n), 'utf8'))
      .join('\n@@@\n');
    expect(blob).toContain('OLD ARCHIVED COPY');
    expect(blob).toContain('NEW LIVE COPY');
  });

  test('classify / recordUsage / curate reject a non-finite now', async () => {
    const cfg = tmpDir('p23-nan');
    const mod = await loadCurator();
    writeSkill(cfg, 'agent-skill', 'agent');

    // NaN / non-numeric / Infinity must throw rather than silently
    // classifying everything as archived.
    expect(() => mod.classify('agent-skill', cfg, NaN)).toThrow();
    expect(() => mod.classify('agent-skill', cfg, 'oops' as unknown as number)).toThrow();
    expect(() => mod.classify('agent-skill', cfg, Infinity)).toThrow();
    expect(() => mod.recordUsage('agent-skill', cfg, NaN)).toThrow();
    expect(() => mod.curate(cfg, NaN)).toThrow();
    // The now=0 default is gone: calling with no now must throw too.
    expect(() => (mod.classify as (n: string, c?: string) => string)('agent-skill', cfg)).toThrow();
  });

  test('curate drops the usage record of a skill it archives', async () => {
    const cfg = tmpDir('p23-prune');
    const mod = await loadCurator();
    const now = Date.UTC(2026, 5, 1);

    writeSkill(cfg, 'idle-agent', 'agent');
    mod.recordUsage('idle-agent', cfg, now - 91 * DAY);

    // Sanity: record exists before curation.
    expect(mod.usageOf('idle-agent', cfg).lastUsedAt).toBe(now - 91 * DAY);

    mod.curate(cfg, now);

    // After archival the stale usage record is gone, so a freshly
    // re-created same-name skill starts from a clean slate (no inherited
    // lastUsedAt that would get it re-archived before first use).
    expect(mod.usageOf('idle-agent', cfg).lastUsedAt).toBe(0);
    expect(mod.usageOf('idle-agent', cfg).uses).toBe(0);
  });
});
