// Skill management commands (list/show/install/remove/search/curate/classify),
// extracted from cli.mjs in Phase D3. Self-contained over skills*.mjs modules.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configPath } from '../lib/config.mjs';

export async function cmdSkills(sub, positional, flags = {}) {
  const skillsMod = await import('../skills.mjs');
  const cfgDir = path.dirname(configPath());
  switch (sub) {
    case undefined:
    case 'list': {
      // Same --filter / --limit semantic as v3.33's sessions list:
      // case-insensitive name substring, then post-filter cap.
      let items = skillsMod.listSkills(cfgDir);
      if (flags.filter) {
        const f = String(flags.filter).toLowerCase();
        items = items.filter(s => s.name.toLowerCase().includes(f));
      }
      if (flags.limit !== undefined) {
        const n = parseInt(flags.limit, 10);
        if (Number.isFinite(n) && n > 0) items = items.slice(0, n);
      }
      console.log(JSON.stringify(items.map(s => ({ name: s.name, bytes: s.bytes, summary: s.summary })), null, 2));
      return;
    }
    case 'show': {
      const name = positional[0];
      if (!name) { console.error('Usage: pompos skills show <name>'); process.exit(2); }
      try { process.stdout.write(skillsMod.loadSkill(name, cfgDir)); }
      catch (e) { console.error(e.message); process.exit(1); }
      return;
    }
    case 'install': {
      // Four forms:
      //   1. install user/repo[@ref][:subpath]   — GitHub bundle
      //   2. install <name> --from <path>
      //   3. install <name> --from-url <https://...>
      //   4. install <name>                       — body via stdin
      // Detect form 1 via a slash in the first positional and the
      // absence of any --from* flag (so a literal local skill name
      // with `/` still routes to the explicit-flag branch — though
      // skillPath() rejects slashes anyway).
      const name = positional[0];
      if (!name) { console.error('Usage: pompos skills install <user/repo[@ref][:path]> | <name> [--from <path> | --from-url <https://...>]'); process.exit(2); }
      if (name.includes('/') && !flags.from && !flags['from-url']) {
        const inst = await import('../skills_install.mjs');
        try {
          const r = await inst.installFromGithub(name, cfgDir, {
            prefix: flags.prefix || '',
            force: !!flags.force,
            maxBytes: flags['max-bytes'] !== undefined ? parseInt(flags['max-bytes'], 10) : undefined,
            timeoutMs: flags['timeout-ms'] !== undefined ? parseInt(flags['timeout-ms'], 10) : undefined,
          });
          console.log(JSON.stringify({
            ok: true,
            spec: `${r.spec.owner}/${r.spec.repo}@${r.spec.ref}${r.spec.subpath ? ':' + r.spec.subpath : ''}`,
            installed: r.installed,
            skipped: r.skipped,
          }, null, 2));
          return;
        } catch (e) {
          console.error(`error: ${e?.message || e}`);
          process.exit(1);
        }
      }
      let content;
      if (flags['from-url']) {
        const url = String(flags['from-url']);
        // Refuse http/file/data — only https. The skill content goes
        // straight into the system prompt, so source authenticity matters.
        if (!url.startsWith('https://')) {
          console.error('skills install --from-url requires an https:// URL');
          process.exit(2);
        }
        const fetchFn = globalThis.fetch;
        if (!fetchFn) { console.error('fetch is not available in this Node runtime'); process.exit(1); }
        // Configurable max size — protect against pathological responses
        // that would balloon the prompt and the disk file. 1 MiB cap.
        const MAX_BYTES = 1_048_576;
        try {
          const res = await fetchFn(url, { redirect: 'follow' });
          if (!res.ok) { console.error(`fetch ${url} → ${res.status}`); process.exit(1); }
          // Stream the body so we can stop at the cap rather than loading
          // an arbitrarily large response into memory.
          const reader = res.body?.getReader?.();
          if (!reader) { content = await res.text(); }
          else {
            const chunks = [];
            let total = 0;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              total += value.length;
              if (total > MAX_BYTES) {
                console.error(`skills install: response exceeds ${MAX_BYTES} bytes; refusing`);
                process.exit(1);
              }
              chunks.push(value);
            }
            content = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
          }
        } catch (e) {
          console.error(`skills install fetch failed: ${e?.message || e}`);
          process.exit(1);
        }
      } else if (flags.from) {
        content = fs.readFileSync(flags.from, 'utf8');
      } else {
        content = await new Promise(resolve => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', d => { buf += d; });
          process.stdin.on('end', () => resolve(buf));
        });
      }
      const written = skillsMod.installSkill(name, content, cfgDir);
      console.log(JSON.stringify({ ok: true, name, path: written, bytes: content.length }));
      return;
    }
    case 'starter': {
      // Bundled starter pack — the .md skills shipped under the package's
      // skills/ directory. pickSkillFiles() already prefers a skills/ dir
      // at a repo root, so the same heuristic that resolves a GitHub
      // bundle resolves the local package. Existing names are skipped
      // unless --force, so user edits survive re-runs.
      const inst = await import('../skills_install.mjs');
      const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
      const picked = inst.pickSkillFiles(pkgRoot);
      if (!picked.length) {
        console.error('no bundled starter skills found (package incomplete?)');
        process.exit(1);
      }
      const r = inst.installPickedSkills(picked, cfgDir, { force: !!flags.force });
      console.log(JSON.stringify({ ok: true, installed: r.installed, skipped: r.skipped }, null, 2));
      return;
    }
    case 'remove': {
      const name = positional[0];
      if (!name) { console.error('Usage: pompos skills remove <name>'); process.exit(2); }
      skillsMod.removeSkill(name, cfgDir);
      console.log(JSON.stringify({ ok: true, removed: name }));
      return;
    }
    case 'search': {
      // Mirror of `pompos sessions search` — case-insensitive substring
      // by default, --regex for pattern mode. Returns per-skill match
      // count + first-excerpt window (40 chars before/after match).
      // The skill body IS markdown so users typically search for terms
      // mentioned in instructions or examples.
      const query = positional[0];
      if (!query) { console.error('Usage: pompos skills search <query> [--regex]'); process.exit(2); }
      const useRegex = !!flags.regex;
      let matcher;
      if (useRegex) {
        try { matcher = new RegExp(query, 'i'); }
        catch (e) { console.error(`invalid regex: ${e.message}`); process.exit(2); }
      } else {
        const q = query.toLowerCase();
        matcher = { test: (s) => String(s).toLowerCase().includes(q) };
      }
      const items = skillsMod.listSkills(cfgDir);
      const matches = [];
      for (const s of items) {
        let body;
        try { body = skillsMod.loadSkill(s.name, cfgDir); }
        catch { continue; }   // file may have been removed mid-listing
        // Count matches across the whole body, not per-line. For a
        // skill body that's a few KB this is plenty fast and the count
        // matches the user's intuition of "how many times does it
        // mention X."
        let matchCount = 0;
        let firstExcerpt = null;
        if (useRegex) {
          // Re-anchor the regex with /gi so we can iterate; the original
          // matcher was /i for boolean test() above. Rebuild here.
          const gFlag = new RegExp(query, 'gi');
          for (const m of body.matchAll(gFlag)) {
            matchCount++;
            if (firstExcerpt === null) {
              const pos = m.index ?? 0;
              const start = Math.max(0, pos - 40);
              const end = Math.min(body.length, pos + m[0].length + 40);
              firstExcerpt = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
            }
          }
        } else {
          const lower = body.toLowerCase();
          const q = query.toLowerCase();
          let pos = 0;
          while (true) {
            const i = lower.indexOf(q, pos);
            if (i < 0) break;
            matchCount++;
            if (firstExcerpt === null) {
              const start = Math.max(0, i - 40);
              const end = Math.min(body.length, i + q.length + 40);
              firstExcerpt = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
            }
            pos = i + q.length;
          }
        }
        if (matchCount > 0) {
          matches.push({
            name: s.name,
            bytes: s.bytes,
            matchCount,
            excerpt: firstExcerpt,
          });
        }
      }
      console.log(JSON.stringify({ query, regex: useRegex, matches }, null, 2));
      return;
    }
    case 'curate': {
      // Lifecycle sweep: agent-authored skills unused >90d move into
      // skills/.archive/ (recoverable). Human-authored skills are never
      // moved. The real clock is injected here; the module stays pure.
      const curator = await import('../skills_curator.mjs');
      const r = curator.curate(cfgDir, Date.now());
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'classify': {
      const name = positional[0];
      if (!name) { console.error('Usage: pompos skills classify <name>'); process.exit(2); }
      const curator = await import('../skills_curator.mjs');
      console.log(JSON.stringify({ name, state: curator.classify(name, cfgDir, Date.now()), usage: curator.usageOf(name, cfgDir) }, null, 2));
      return;
    }
    default:
      console.error('Usage: pompos skills <list|show <name>|install <name> [--from path]|starter [--force]|remove <name>|search <query> [--regex]|curate|classify <name>>');
      process.exit(2);
  }
}
