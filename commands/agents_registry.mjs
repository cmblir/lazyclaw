// Agent registry command (cmdAgentRegistry): the agent
// add/list/show/edit/remove/memory/reflect/skill-synth handler. Extracted
// from commands/agents.mjs as a sibling module for the file-size gate.
import path from 'node:path';
import fs from 'node:fs';
import { configPath, readConfig, _resolveAuthKey, _resolveBaseUrl } from '../lib/config.mjs';
import { loadDotenvIfAny } from '../dotenv_min.mjs';

// Thin .env loader wrapper kept local so the module stays self-contained
// (importing the wrapper back from agents.mjs would create a cycle).
function _loadDotenvIfAny(cfgDir) { return loadDotenvIfAny(cfgDir); }

export async function cmdAgentRegistry(sub, positional, flags = {}) {
  const agentsMod = await import('../agents.mjs');
  const cfgDir = path.dirname(configPath());
  const name = positional[0];

  const emitJson = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

  switch (sub) {
    case undefined:
    case 'list': {
      emitJson(agentsMod.listAgents(cfgDir));
      return;
    }
    case 'add': {
      if (!name) { console.error('Usage: lazyclaw agent add <name> [--role "..."] [--provider X] [--model Y] [--display "..."] [--manager <agent>] [--tools bash,read,write,grep,skill_view] [--tags a,b] [--skill-write auto|manual|off]'); process.exit(2); }
      const tools = agentsMod.parseToolsFlag(flags.tools);
      try {
        const a = agentsMod.registerAgent({
          name,
          displayName: flags.display || flags['display-name'],
          role: flags.role || '',
          provider: flags.provider || 'claude-cli',
          model: flags.model || '',
          tools: tools === null ? undefined : tools,
          tags: agentsMod.parseToolsFlag(flags.tags) || [],
          skillWrite: flags['skill-write'],
          manager: flags.manager,
        }, cfgDir);
        emitJson(a);
      } catch (err) {
        console.error(`agent add: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'show': {
      if (!name) { console.error('Usage: lazyclaw agent show <name>'); process.exit(2); }
      const a = agentsMod.getAgent(name, cfgDir);
      if (!a) { console.error(`agent show: no agent "${name}"`); process.exit(2); }
      emitJson(a);
      return;
    }
    case 'edit': {
      if (!name) { console.error('Usage: lazyclaw agent edit <name> [--role "..."] [--provider X] [--model Y] [--display "..."] [--tools ...] [--skill-write auto|manual|off] [--memory-write auto|manual|off]'); process.exit(2); }
      const patch = {};
      if (flags.role !== undefined)         patch.role = String(flags.role);
      if (flags.provider !== undefined)     patch.provider = String(flags.provider);
      if (flags.model !== undefined)        patch.model = String(flags.model);
      if (flags.display !== undefined)      patch.displayName = String(flags.display);
      if (flags['display-name'] !== undefined) patch.displayName = String(flags['display-name']);
      if (flags.tools !== undefined)        patch.tools = agentsMod.parseToolsFlag(flags.tools);
      if (flags.tags !== undefined)         patch.tags = agentsMod.parseToolsFlag(flags.tags);
      if (flags['skill-write'] !== undefined)  patch.skillWrite = String(flags['skill-write']);
      if (flags['memory-write'] !== undefined) patch.memoryWrite = String(flags['memory-write']);
      if (Object.keys(patch).length === 0) {
        console.error('agent edit: no fields to update');
        process.exit(2);
      }
      try { emitJson(agentsMod.patchAgent(name, patch, cfgDir)); }
      catch (err) { console.error(`agent edit: ${err?.message || err}`); process.exit(2); }
      return;
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      if (!name) { console.error('Usage: lazyclaw agent remove <name>'); process.exit(2); }
      try { emitJson(agentsMod.removeAgent(name, cfgDir)); }
      catch (err) { console.error(`agent remove: ${err?.message || err}`); process.exit(2); }
      return;
    }
    case 'memory': {
      // memory <show|edit|clear> <name>
      const op = positional[0];
      const memName = positional[1];
      if (!op || !memName) {
        console.error('Usage: lazyclaw agent memory <show|edit|clear> <name>');
        process.exit(2);
      }
      const memMod = await import('../mas/agent_memory.mjs');
      try {
        if (op === 'show') {
          const max = Number.isFinite(+flags['max-chars']) && +flags['max-chars'] > 0 ? +flags['max-chars'] : memMod.DEFAULT_MAX_CHARS;
          const text = memMod.readMemory(memName, cfgDir, max);
          if (!text) process.stderr.write(`(no memory for "${memName}")\n`);
          else process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
        } else if (op === 'edit') {
          const p = memMod.memoryPath(memName, cfgDir);
          // Ensure file exists so $EDITOR doesn't start with a missing
          // file warning.
          if (!fs.existsSync(p)) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, `# ${memName} — memory\n\n`);
          }
          const editor = process.env.EDITOR || 'vi';
          const { spawn } = await import('node:child_process');
          await new Promise((resolve) => {
            const ch = spawn(editor, [p], { stdio: 'inherit' });
            ch.on('close', () => resolve());
          });
          process.stdout.write(`edited ${p}\n`);
        } else if (op === 'clear') {
          const removed = memMod.clear(memName, cfgDir);
          process.stdout.write(removed ? `cleared memory for "${memName}"\n` : `(no memory for "${memName}")\n`);
        } else {
          console.error(`Usage: lazyclaw agent memory <show|edit|clear> <name>`);
          process.exit(2);
        }
      } catch (err) {
        console.error(`agent memory ${op}: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'reflect': {
      const aname = positional[0];
      const taskId = flags.task || positional[1];
      if (!aname || !taskId) {
        console.error('Usage: lazyclaw agent reflect <name> --task <id>');
        process.exit(2);
      }
      const tasksMod = await import('../tasks.mjs');
      const memMod = await import('../mas/agent_memory.mjs');
      const a = agentsMod.getAgent(aname, cfgDir);
      if (!a) { console.error(`agent reflect: no agent "${aname}"`); process.exit(2); }
      const task = tasksMod.getTask(taskId, cfgDir);
      if (!task) { console.error(`agent reflect: no task "${taskId}"`); process.exit(2); }
      try { _loadDotenvIfAny(cfgDir); } catch { /* best-effort */ }
      const cfg = readConfig();
      const apiKey = _resolveAuthKey(cfg, a.provider);
      const baseUrl = _resolveBaseUrl(a.provider);
      try {
        const body = await memMod.reflectOnce({ agent: a, task, apiKey, baseUrl });
        if (!body || !body.trim()) {
          process.stderr.write('reflection returned empty body — nothing to write\n');
          return;
        }
        if (!flags['dry-run']) {
          memMod.prependEntry(aname, { taskId: task.id, title: task.title, body }, cfgDir);
        }
        process.stdout.write(body + (body.endsWith('\n') ? '' : '\n'));
      } catch (err) {
        console.error(`agent reflect: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'skill-synth': {
      const aname = positional[0];
      const taskId = flags.task || positional[1];
      if (!aname || !taskId) {
        console.error('Usage: lazyclaw agent skill-synth <name> --task <id> [--dry-run]');
        process.exit(2);
      }
      const tasksMod = await import('../tasks.mjs');
      const synthMod = await import('../mas/skill_synth.mjs');
      const skillsMod = await import('../skills.mjs');
      const a = agentsMod.getAgent(aname, cfgDir);
      if (!a) { console.error(`agent skill-synth: no agent "${aname}"`); process.exit(2); }
      const task = tasksMod.getTask(taskId, cfgDir);
      if (!task) { console.error(`agent skill-synth: no task "${taskId}"`); process.exit(2); }
      try { _loadDotenvIfAny(cfgDir); } catch { /* best-effort */ }
      const cfg = readConfig();
      const apiKey = _resolveAuthKey(cfg, a.provider);
      const baseUrl = _resolveBaseUrl(a.provider);
      try {
        const result = await synthMod.synthesizeSkill({ agent: a, task, apiKey, baseUrl });
        if (!result) {
          process.stderr.write('skill synthesis produced nothing worth saving\n');
          return;
        }
        if (!flags['dry-run']) {
          // installSynthesized reserves a collision-free name (never
          // clobbers a human-authored skill) and version-bumps when it
          // improves its own prior skill.
          const installed = synthMod.installSynthesized(
            { name: result.name, description: result.description, body: result.body, sourceTask: task.id },
            cfgDir,
          );
          emitJson({ skill: installed.skill, description: result.description, version: installed.version, path: installed.path });
        } else {
          process.stdout.write(result.doc + (result.doc.endsWith('\n') ? '' : '\n'));
        }
      } catch (err) {
        console.error(`agent skill-synth: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    default:
      console.error('Usage: lazyclaw agent <add|list|show|edit|remove|memory|reflect|skill-synth> ...');
      process.exit(2);
  }
}
