// commands/chat_legacy_slash.mjs — legacy (non-Ink) readline slash router.
//
// Extracted VERBATIM from commands/chat.mjs's `handleSlash` closure to keep that
// file under its file-size ceiling (lint:size). PURE module-extraction, no
// behaviour change. The handler closes over a lot of mutable chat state
// (activeProvName, prov, messages, sessionId, …) which it both reads AND
// reassigns; to avoid a circular import back into ./chat.mjs we receive that
// state through a factory `ctx` carrying getter/setter accessors. cmdChat builds
// the handler once (after rl/_ghost exist, just before the read loop) with a ctx
// wired to its own `let` bindings, so a /provider or /goal switch propagates to
// the very next turn exactly as before.
//
// This module MUST NOT import from ./chat.mjs (cycle). It owns legacySlashRoute
// and LEGACY_DELEGATED_SLASHES; chat.mjs re-exports legacySlashRoute for tests.
import { renderRecord } from '../lib/render.mjs';
import { getRegistry } from '../lib/registry_boot.mjs';
import { _resolveAuthKey, _resolveBaseUrl } from '../lib/config.mjs';
import {
  _pauseChatForSubMenu, _pickModelInteractive, _pickProviderInteractive,
} from '../tui/pickers.mjs';
import { dispatchSlash as _dispatchSlash, parseSlashLine as _parseSlashLine } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { wrapInteractiveProv } from './chat_hardening.mjs';

// Legacy (non-Ink) slash routing for dispatcher-style, ctx-only commands.
// The Ink REPL routes every slash through _dispatchSlash/SLASH_HANDLERS, but
// the legacy readline path uses a hand-written switch (below). This exported
// helper is the wiring BOTH that switch and the regression test drive.
// Returns 'EXIT' to break the loop, undefined when not owned here.
export function legacySlashRoute(cmd, ctx) {
  switch (cmd) {
    // Legacy readline path has no modal picker, so BOTH /setup and /config
    // route to the full wizard here (the Ink path gives /config its
    // single-setting picker via tui/config_picker.mjs).
    case '/config':
    case '/setup':
      ctx.requestSetup = true;
      return 'EXIT';
    default:
      return undefined;
  }
}

// Dispatcher commands the legacy readline path's default branch may delegate to
// _dispatchSlash. Kept to ctx-safe handlers only (no _inkCtx-only setters /
// openPicker / version), so legacy doesn't silently degrade. /channels has a
// lib/config fallback so it's safe; add others only after confirming ctx-safety.
const LEGACY_DELEGATED_SLASHES = new Set(['/channels', '/orchestrator', '/context']);

// Factory: builds the legacy readline slash handler bound to cmdChat's mutable
// state via `ctx`. `ctx` exposes the stable deps (cfg, cfgDir, lookupProv,
// persistTurn, accumulateUsage, legacyCtx, useTerminal, sandboxSpec, rl, ghost)
// and getX/setX accessors for the reassignable bindings. cmdChat builds the
// handler AFTER rl/_ghost are created (just before the read loop), matching the
// original call-time read of those bindings, so rl/ghost are captured live.
export function makeLegacySlashHandler(ctx) {
  const { cfg, cfgDir, lookupProv, persistTurn, accumulateUsage } = ctx;
  const _legacyCtx = ctx.legacyCtx;
  const useTerminal = ctx.useTerminal;
  const sandboxSpec = ctx.sandboxSpec;
  const rl = ctx.rl;
  const _ghost = ctx.ghost;

  const _legacyHandleSlash = async (line) => {
    const cmd = line.split(/\s+/)[0];
    switch (cmd) {
      case '/help': {
        process.stdout.write('slash commands:\n');
        for (const c of SLASH_COMMANDS) process.stdout.write(`  ${c.cmd.padEnd(8)} — ${c.help}\n`);
        return true;
      }
      case '/status': {
        const out = {
          provider: ctx.getActiveProvName(),
          model: ctx.getActiveModel(),
          keyMasked: getRegistry().maskApiKey(cfg['api-key']),
          messageCount: ctx.getMessages().length,
        };
        process.stdout.write(JSON.stringify(out) + '\n');
        return true;
      }
      case '/provider': {
        // `/provider <name>` switches the active provider for subsequent
        // turns. The conversation history stays put — the next user
        // message goes to the new provider with the existing context.
        // `/provider` (no arg) opens the family/provider/model picker so
        // the user can switch with arrow keys instead of memorising names.
        const arg = line.slice('/provider'.length).trim();
        if (!arg) {
          if (!useTerminal) {
            process.stdout.write(`provider: ${ctx.getActiveProvName()}\n`);
            return true;
          }
          await _pauseChatForSubMenu(rl, _ghost, async () => {
            const picked = await _pickProviderInteractive();
            if (picked && picked.provider) {
              const next = lookupProv(picked.provider);
              if (!next) {
                process.stdout.write(`unknown provider: ${picked.provider}\n`);
                return;
              }
              ctx.setActiveProvName(picked.provider);
              ctx.setProv(wrapInteractiveProv(next));
              if (picked.model) ctx.setActiveModel(picked.model);
              process.stdout.write(`provider → ${ctx.getActiveProvName()}${picked.model ? ` · model → ${picked.model}` : ''}\n`);
            }
          });
          return true;
        }
        const next = lookupProv(arg);
        if (!next) {
          process.stdout.write(`unknown provider: ${arg} (known: ${Object.keys(getRegistry().PROVIDERS).join(', ')})\n`);
          return true;
        }
        ctx.setActiveProvName(arg);
        ctx.setProv(wrapInteractiveProv(next));
        process.stdout.write(`provider → ${arg}\n`);
        return true;
      }
      case '/model': {
        // `/model <name>` updates the active model without touching the
        // provider. `/model` (no arg) opens the per-provider model picker
        // — same UX as setup step 3, scoped to the active provider.
        const arg = line.slice('/model'.length).trim();
        if (!arg) {
          if (!useTerminal) {
            process.stdout.write(`model: ${ctx.getActiveModel() || '(default)'}\n`);
            return true;
          }
          await _pauseChatForSubMenu(rl, _ghost, async () => {
            const chosen = await _pickModelInteractive(ctx.getActiveProvName(), { titlePrefix: 'Pompos chat —' });
            if (chosen === 'CANCEL' || chosen === 'BACK' || !chosen) return;
            ctx.setActiveModel(chosen);
            process.stdout.write(`model → ${ctx.getActiveModel()}\n`);
          });
          return true;
        }
        // Honor unified provider/model: `/model anthropic/claude-opus-4-7`
        // splits and switches both.
        const { parseSlashProviderModel } = getRegistry();
        const parsed = parseSlashProviderModel(arg);
        if (parsed.provider) {
          const next = lookupProv(parsed.provider);
          if (!next) {
            process.stdout.write(`unknown provider: ${parsed.provider}\n`);
            return true;
          }
          ctx.setActiveProvName(parsed.provider);
          ctx.setProv(wrapInteractiveProv(next));
        }
        ctx.setActiveModel(parsed.model || arg);
        process.stdout.write(`model → ${ctx.getActiveModel()}${parsed.provider ? ` (provider → ${parsed.provider})` : ''}\n`);
        return true;
      }
      case '/new':
      case '/reset':
      case '/clear': {
        // /clear is dispatcher-only (no explicit legacy case before this),
        // so without it /clear fell through to `default:` → _dispatchSlash →
        // _newReset, which clears via ctx.set* setters that _legacyCtx does
        // NOT expose — returning 'cleared' while the closure's messages/
        // charsSent/runningUsage stayed intact (a lying no-op). Alias /clear
        // to the /new+/reset direct-mutation body, matching the dispatcher's
        // /clear → /new/reset session-reset aliasing.
        ctx.setMessages([]);
        ctx.setCharsSent(0);
        ctx.setRunningUsage(null);
        if (ctx.getSessionId()) {
          const sm = await import('../sessions.mjs');
          sm.resetSession(ctx.getSessionId(), cfgDir);
        }
        process.stdout.write('cleared — new conversation\n');
        return true;
      }
      case '/usage': {
        const out = { messageCount: ctx.getMessages().length, charsSent: ctx.getCharsSent() };
        if (ctx.getRunningUsage()) out.tokens = ctx.getRunningUsage();
        // When cfg.rates has a card for the active provider/model AND
        // we accumulated real usage, surface the running cost too. The
        // computation is local (pure arithmetic), no extra network.
        if (ctx.getRunningUsage() && cfg.rates && typeof cfg.rates === 'object') {
          try {
            const { costFromUsage } = await import('../providers/rates.mjs');
            const r = costFromUsage(
              { provider: ctx.getActiveProvName(), model: ctx.getActiveModel(), usage: ctx.getRunningUsage() },
              cfg.rates,
            );
            if (r) out.cost = r;
          } catch { /* never let cost-card lookup fail the slash */ }
        }
        process.stdout.write(JSON.stringify(out) + '\n');
        return true;
      }
      case '/skill': {
        // `/skill name1,name2` — replace the active system message with a
        // composition of the named skills. `/skill` (no arg) clears the
        // system message. The replacement happens in-place on the
        // messages array; the prior system turn (if any) is dropped so
        // we don't end up with two stacked system messages talking past
        // each other. When --session is set we persist the new system
        // message so the next invocation resumes with the same context.
        const arg = line.slice('/skill'.length).trim();
        const names = arg.split(',').map(s => s.trim()).filter(Boolean);
        const sysIdx = ctx.getMessages().findIndex(m => m.role === 'system');
        if (names.length === 0) {
          if (sysIdx >= 0) ctx.getMessages().splice(sysIdx, 1);
          if (ctx.getSessionId()) {
            // Persistent session: rewrite the file from scratch so the
            // dropped system turn doesn't linger as a stale entry.
            const sm = await import('../sessions.mjs');
            sm.resetSession(ctx.getSessionId(), cfgDir);
            for (const m of ctx.getMessages()) sm.appendTurn(ctx.getSessionId(), m.role, m.content, cfgDir);
          }
          process.stdout.write('cleared system prompt (no active skills)\n');
          return true;
        }
        try {
          const sys = await (async () => {
            const mod = await import('../skills.mjs');
            return mod.composeSystemPrompt(names, cfgDir);
          })();
          if (!sys) {
            process.stdout.write('no skill content composed (empty input?)\n');
            return true;
          }
          if (sysIdx >= 0) ctx.getMessages()[sysIdx] = { role: 'system', content: sys };
          else ctx.getMessages().unshift({ role: 'system', content: sys });
          if (ctx.getSessionId()) {
            const sm = await import('../sessions.mjs');
            sm.resetSession(ctx.getSessionId(), cfgDir);
            for (const m of ctx.getMessages()) sm.appendTurn(ctx.getSessionId(), m.role, m.content, cfgDir);
          }
          process.stdout.write(`active skills: ${names.join(', ')}\n`);
        } catch (e) {
          process.stdout.write(`skill error: ${e?.message || e}\n`);
        }
        return true;
      }
      case '/loop': {
        // `/loop <prompt> [--max N] [--until "<regex>"]` — repeats one
        // user prompt against the active provider in the current session.
        // Default --max 3, hard cap 50. --until short-circuits when its
        // regex matches the latest assistant turn. Ctrl+C aborts the
        // current stream AND the whole loop (not just the in-flight
        // turn). Implementation lives in loop-engine.mjs; here we wire
        // it to the same provider streaming + buffered-writer used by a
        // normal user turn.
        const arg = line.slice('/loop'.length).trim();
        const loopMod = await import('../loop-engine.mjs');
        if (!arg) {
          process.stdout.write(`usage: /loop <prompt> [--max N] [--until "<regex>"]\n`);
          process.stdout.write(`  default --max ${loopMod.LOOP_MAX_DEFAULT}, ceiling ${loopMod.LOOP_MAX_CEILING}\n`);
          process.stdout.write(`  session: ${ctx.getSessionId() || '(none — turns will not be persisted)'}\n`);
          return true;
        }
        let parsed;
        try { parsed = loopMod.parseLoopArgs(arg); }
        catch (e) { process.stdout.write(`loop error: ${e?.message || e}\n`); return true; }
        let untilRe = null;
        try { untilRe = loopMod.compileUntil(parsed.until); }
        catch (e) { process.stdout.write(`loop error: ${e?.message || e}\n`); return true; }

        // Per-loop AbortController. Ctrl+C aborts the current provider
        // call (via signal) AND prevents the next iteration (the engine
        // sees signal.aborted on its loop check). Same handler shape as
        // the normal-turn path; symmetry keeps `/exit` clean afterwards.
        const loopAc = new AbortController();
        const onSigint = () => {
          loopAc.abort();
          process.stdout.write('\n^C interrupted — loop aborted\n');
        };
        process.on('SIGINT', onSigint);

        const sendOnce = async (msgs, signal) => {
          let acc = '';
          let _writeBuf = '';
          let _writeTimer = null;
          const _flush = () => {
            if (_writeBuf) { process.stdout.write(_writeBuf); _writeBuf = ''; }
            _writeTimer = null;
          };
          const _writeChunk = (s) => {
            _writeBuf += s;
            if (!_writeTimer) _writeTimer = setTimeout(_flush, 30);
          };
          try {
            for await (const chunk of ctx.getProv().sendMessage(msgs, {
              apiKey: _resolveAuthKey(cfg, ctx.getActiveProvName()),
              model: ctx.getActiveModel(),
              sandbox: sandboxSpec,
              signal,
              onUsage: accumulateUsage,
            })) {
              _writeChunk(chunk);
              acc += chunk;
            }
            if (_writeTimer) clearTimeout(_writeTimer);
            _flush();
            process.stdout.write('\n');
            return acc;
          } catch (err) {
            if (_writeTimer) clearTimeout(_writeTimer);
            _flush();
            throw err;
          }
        };

        if (useTerminal) _ghost.suspend();
        // Capture the chat's existing system message (workspace / skill
        // composition) before we let the engine touch it; we restore it
        // after the loop so the chat continues with the same system.
        const _sysBefore = ctx.getMessages().find(m => m.role === 'system')?.content ?? null;
        const memMod = (parsed.useMemory || parsed.recall) ? await import('../memory.mjs') : null;
        const buildSystem = memMod ? (() => {
          // Called per iteration: memory.loadCore + recall re-read from
          // disk every call so a parallel writer mutating core.md /
          // episodic/* between iterations is reflected immediately.
          const parts = [];
          if (parsed.useMemory) {
            const core = memMod.loadCore(cfgDir);
            if (core && core.trim()) parts.push(core);
          }
          if (parsed.recall) {
            const text = memMod.recall(parsed.recall, { topN: 3 }, cfgDir);
            if (text && text.trim()) parts.push(text);
          }
          if (_sysBefore) parts.push(_sysBefore);
          return parts.join('\n\n---\n\n');
        }) : null;
        try {
          const result = await loopMod.runLoop({
            prompt: parsed.prompt,
            max: parsed.max,
            until: untilRe,
            messages: ctx.getMessages(),
            sendOnce,
            persist: (role, content) => persistTurn(role, content),
            onIteration: ({ i, max }) => {
              process.stderr.write(`\x1b[2m  ↻ loop iteration ${i}/${max}\x1b[22m\n`);
            },
            signal: loopAc.signal,
            buildSystem,
          });
          ctx.setCharsSent(ctx.getCharsSent() + (parsed.prompt.length * result.iterations));
          if (result.stoppedBy === 'until') {
            process.stderr.write(`\x1b[2m  ✓ loop stopped by --until\x1b[22m\n`);
          } else if (result.stoppedBy === 'abort') {
            process.stderr.write(`\x1b[2m  ⊘ loop aborted after ${result.iterations}/${parsed.max} iteration(s)\x1b[22m\n`);
          }
        } catch (err) {
          process.stdout.write(`loop error: ${err?.message || String(err)}\n`);
        } finally {
          process.off('SIGINT', onSigint);
          if (useTerminal) _ghost.resume();
          // Restore the chat's prior system message. The engine may have
          // overwritten messages[0] with the per-iter memory composition;
          // we put the original (workspace / skill) back so the
          // subsequent free-form chat turn sees the same system the user
          // configured before /loop ran.
          if (buildSystem) {
            const sysIdx = ctx.getMessages().findIndex(m => m.role === 'system');
            if (_sysBefore) {
              if (sysIdx >= 0) ctx.getMessages()[sysIdx] = { role: 'system', content: _sysBefore };
              else ctx.getMessages().unshift({ role: 'system', content: _sysBefore });
            } else if (sysIdx >= 0) {
              ctx.getMessages().splice(sysIdx, 1);
            }
          }
        }
        return true;
      }
      case '/goal': {
        // /goal                 → list active goals
        // /goal <name>          → switch chat context to goal:<name>
        // /goal add <name> [--desc "..."] [--cron "<spec>"]
        // /goal list            → JSON of all goals
        // /goal show <name>     → JSON of one
        // /goal close <name> [done|abandoned]
        const rawArg = line.slice('/goal'.length).trim();
        const goalsMod = await import('../goals.mjs');
        const loopMod = await import('../loop-engine.mjs');
        if (!rawArg) {
          const items = goalsMod.listGoals(cfgDir).filter(g => g.status === 'active');
          if (!items.length) { process.stdout.write('no active goals\n'); }
          else {
            for (const g of items) {
              process.stdout.write(`  ${g.name}${g.description ? ' — ' + g.description : ''}${g.schedule ? ' (cron: ' + g.schedule + ')' : ''}\n`);
            }
          }
          return true;
        }
        let tokens;
        try { tokens = loopMod.splitArgs(rawArg); }
        catch (e) { process.stdout.write(`goal error: ${e?.message || e}\n`); return true; }
        const sub = tokens[0];
        const rest = tokens.slice(1);
        if (sub === 'add') {
          let name = null, desc = '', cron = null;
          for (let i = 0; i < rest.length; i++) {
            const t = rest[i];
            if (t === '--desc') desc = rest[++i] || '';
            else if (t === '--cron') cron = rest[++i] || null;
            else if (t.startsWith('--')) { process.stdout.write(`goal error: unknown flag ${t}\n`); return true; }
            else if (!name) name = t;
            else { process.stdout.write(`goal error: unexpected arg "${t}"\n`); return true; }
          }
          if (!name) { process.stdout.write('usage: /goal add <name> [--desc "..."] [--cron "<spec>"]\n'); return true; }
          try {
            const g = goalsMod.registerGoal({ name, description: desc, schedule: cron }, cfgDir);
            if (cron) {
              try { await (await import('../commands/automation.mjs'))._attachGoalCron(name, cron); }
              catch (e) { process.stdout.write(`goal warning: cron attach failed (${e?.message || e})\n`); }
            }
            process.stdout.write(`✓ goal ${g.name} added (status: active${cron ? `, cron: ${cron}` : ''})\n`);
          } catch (e) { process.stdout.write(`goal error: ${e?.message || e}\n`); }
          return true;
        }
        if (sub === 'list') {
          process.stdout.write(JSON.stringify(goalsMod.listGoals(cfgDir), null, 2) + '\n');
          return true;
        }
        if (sub === 'show') {
          const name = rest[0];
          if (!name) { process.stdout.write('usage: /goal show <name>\n'); return true; }
          const g = goalsMod.getGoal(name, cfgDir);
          if (!g) { process.stdout.write(`no goal "${name}"\n`); return true; }
          process.stdout.write(JSON.stringify(g, null, 2) + '\n');
          return true;
        }
        if (sub === 'close') {
          const name = rest[0];
          const outcome = rest[1] || 'done';
          if (!name) { process.stdout.write('usage: /goal close <name> [done|abandoned]\n'); return true; }
          try {
            const g = goalsMod.closeGoal(name, outcome, cfgDir);
            try { await (await import('../commands/automation.mjs'))._detachGoalCron(name); }
            catch (e) { process.stdout.write(`goal warning: cron detach failed (${e?.message || e})\n`); }
            process.stdout.write(`✓ goal ${g.name} closed (status: ${g.status})\n`);
          } catch (e) { process.stdout.write(`goal error: ${e?.message || e}\n`); }
          return true;
        }
        // Single-arg branch: switch context to goal:<name>.
        const goalName = sub;
        const g = goalsMod.getGoal(goalName, cfgDir);
        if (!g) {
          process.stdout.write(`no goal "${goalName}" — try: /goal add ${goalName} --desc "..."\n`);
          return true;
        }
        if (g.status !== 'active') {
          process.stdout.write(`goal "${goalName}" is ${g.status}; cannot switch\n`);
          return true;
        }
        // Switch: replace the chat's active session id and reload turns
        // from the goal's session. The provider, model, workspace, and
        // skill state stay put — only the conversation surface changes.
        ctx.setSessionId(g.sessionId);
        ctx.setActiveGoalName(g.name);
        const prior = ctx.sessionsMod.loadTurns(ctx.getSessionId(), cfgDir);
        ctx.setMessages(prior.map(t => ({ role: t.role, content: t.content })));
        // Prepend a one-line goal note to the system message so the
        // model sees the current objective without us having to mutate
        // any persistent record on every switch.
        const sysIdx = ctx.getMessages().findIndex(m => m.role === 'system');
        const goalNote = `## Goal: ${g.description || g.name}`;
        if (sysIdx >= 0) {
          ctx.getMessages()[sysIdx] = { role: 'system', content: `${goalNote}\n\n${ctx.getMessages()[sysIdx].content}` };
        } else {
          ctx.getMessages().unshift({ role: 'system', content: goalNote });
        }
        process.stdout.write(`✓ switched to goal: ${g.name} (session: ${ctx.getSessionId()}, ${prior.length} prior turn(s))\n`);
        return true;
      }
      case '/memory': {
        const arg = line.slice('/memory'.length).trim();
        const memMod = await import('../memory.mjs');
        const tokens = arg.split(/\s+/).filter(Boolean);
        const which = tokens[0] || 'core';
        if (which === 'core') {
          const body = memMod.loadCore(cfgDir);
          process.stdout.write(body || '(empty core memory)\n');
          return true;
        }
        if (which === 'recent') {
          const items = memMod.loadRecent(20, cfgDir);
          process.stdout.write(JSON.stringify(items, null, 2) + '\n');
          return true;
        }
        if (which === 'episodic') {
          const topic = tokens[1];
          if (topic) {
            const body = memMod.loadEpisodic(topic, cfgDir);
            process.stdout.write(body || `(no episodic file "${topic}")\n`);
          } else {
            process.stdout.write(JSON.stringify(memMod.listEpisodic(cfgDir), null, 2) + '\n');
          }
          return true;
        }
        process.stdout.write('usage: /memory [core|recent|episodic [topic]]\n');
        return true;
      }
      case '/dream': {
        const memMod = await import('../memory.mjs');
        process.stdout.write('  ↯ dreaming…\n');
        try {
          const r = await memMod.dream(ctx.getSessionId(), {
            provider: ctx.getProv(),
            model: ctx.getActiveModel(),
            apiKey: _resolveAuthKey(cfg, ctx.getActiveProvName()),
          }, cfgDir);
          process.stdout.write(`✓ wrote ${r.topics.length} episodic file(s): ${r.topics.join(', ') || '(none)'}\n`);
        } catch (e) { process.stdout.write(`dream error: ${e?.message || e}\n`); }
        return true;
      }
      case '/agent': {
        const rawArg = line.slice('/agent'.length).trim();
        const agentsMod = await import('../agents.mjs');
        const loopMod = await import('../loop-engine.mjs');
        let tokens;
        try { tokens = loopMod.splitArgs(rawArg); }
        catch (e) { process.stdout.write(`/agent error: ${e?.message || e}\n`); return true; }
        const sub = tokens[0];
        const rest = tokens.slice(1);
        const aname = rest[0];
        try {
          if (!sub || sub === 'list') {
            const agents = agentsMod.listAgents(cfgDir);
            if (agents.length === 0) process.stdout.write('no agents registered. /agent add <name> [...] to create.\n');
            else for (const a of agents) {
              const provLine = a.model ? `${a.provider}/${a.model}` : a.provider;
              process.stdout.write(`• ${a.name} — ${a.displayName} — ${provLine} — tools=[${(a.tools || []).join(',')}]\n`);
            }
          } else if (sub === 'show') {
            if (!aname) { process.stdout.write('usage: /agent show <name> [json]\n'); return true; }
            const a = agentsMod.getAgent(aname, cfgDir);
            if (!a) process.stdout.write(`no agent "${aname}"\n`);
            else if (rest[1] === 'json') process.stdout.write(JSON.stringify(a, null, 2) + '\n');
            else process.stdout.write(renderRecord(a, { fields: ['name', 'displayName', 'provider', 'model', 'role', 'tools', 'tags', 'iconEmoji', 'memoryWrite', 'skillWrite', 'createdAt', 'updatedAt'] }) + '\n');
          } else if (sub === 'add') {
            if (!aname) { process.stdout.write('usage: /agent add <name> [role text…]\n'); return true; }
            const roleText = rest.slice(1).join(' ').trim();
            const a = agentsMod.registerAgent({ name: aname, role: roleText }, cfgDir);
            process.stdout.write(`✓ added agent ${a.name} (tools=${a.tools.join(',')})\n`);
          } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
            if (!aname) { process.stdout.write('usage: /agent remove <name>\n'); return true; }
            agentsMod.removeAgent(aname, cfgDir);
            process.stdout.write(`✓ removed agent ${aname}\n`);
          } else {
            process.stdout.write(`/agent: unknown sub "${sub}" — list|show|add|remove\n`);
          }
        } catch (e) {
          process.stdout.write(`/agent error: ${e?.message || e}\n`);
        }
        return true;
      }
      case '/team': {
        const rawArg = line.slice('/team'.length).trim();
        const teamsMod = await import('../teams.mjs');
        const loopMod = await import('../loop-engine.mjs');
        let tokens;
        try { tokens = loopMod.splitArgs(rawArg); }
        catch (e) { process.stdout.write(`/team error: ${e?.message || e}\n`); return true; }
        const sub = tokens[0];
        const rest = tokens.slice(1);
        const tname = rest[0];
        try {
          if (!sub || sub === 'list') {
            const teams = teamsMod.listTeams(cfgDir);
            if (teams.length === 0) process.stdout.write('no teams registered. /team add <name> --agents a,b --lead a [--channel #x]\n');
            else for (const t of teams) {
              const chLine = t.slackChannel ? ` — ${t.slackChannel}` : '';
              process.stdout.write(`• ${t.name} — ${t.displayName} — lead=${t.lead} — agents=[${t.agents.join(',')}]${chLine}\n`);
            }
          } else if (sub === 'show') {
            if (!tname) { process.stdout.write('usage: /team show <name>\n'); return true; }
            const t = teamsMod.getTeam(tname, cfgDir);
            if (!t) process.stdout.write(`no team "${tname}"\n`);
            else process.stdout.write(JSON.stringify(t, null, 2) + '\n');
          } else if (sub === 'add') {
            // /team add <name> --agents a,b,c [--lead a] [--channel #x]
            if (!tname) { process.stdout.write('usage: /team add <name> --agents a,b,c [--lead a] [--channel #x]\n'); return true; }
            let agentsCsv = null, lead = null, channel = '';
            for (let i = 1; i < rest.length; i++) {
              const t = rest[i];
              if (t === '--agents') agentsCsv = rest[++i] || '';
              else if (t === '--lead') lead = rest[++i] || null;
              else if (t === '--channel') channel = rest[++i] || '';
              else { process.stdout.write(`/team error: unknown token "${t}"\n`); return true; }
            }
            if (!agentsCsv) { process.stdout.write('/team add: --agents is required\n'); return true; }
            const agents = teamsMod.parseListFlag(agentsCsv);
            const ch = channel ? await teamsMod.resolveSlackChannel(channel, {
              botToken: process.env.SLACK_BOT_TOKEN || null,
              apiBase: process.env.SLACK_API_BASE || 'https://slack.com/api',
              logger: () => {},
            }) : '';
            const team = teamsMod.registerTeam({ name: tname, agents, lead, slackChannel: ch }, cfgDir);
            process.stdout.write(`✓ added team ${team.name} (lead=${team.lead}, agents=${team.agents.join(',')})\n`);
          } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
            if (!tname) { process.stdout.write('usage: /team remove <name>\n'); return true; }
            teamsMod.removeTeam(tname, cfgDir);
            process.stdout.write(`✓ removed team ${tname}\n`);
          } else {
            process.stdout.write(`/team: unknown sub "${sub}" — list|show|add|remove\n`);
          }
        } catch (e) {
          process.stdout.write(`/team error: ${e?.message || e}\n`);
        }
        return true;
      }
      case '/handoff': {
        // /handoff <target-channel> <externalId> [--note=...] — migrates the
        // active thread (bound to replState.channel / replState.externalId)
        // to a new channel and posts transition stubs on both sides. In the
        // local-only chat REPL there is no bound channel, so we surface a
        // clear error and stay in the REPL (acceptance test §F).
        const parts = line.trim().split(/\s+/).slice(1);
        if (parts.length < 2) {
          process.stderr.write('usage: /handoff <target-channel> <externalId> [--note=...]\n');
          return true;
        }
        const target = parts[0];
        const externalId = parts[1];
        const note = (parts.find(p => p.startsWith('--note=')) || '').slice(7);
        try {
          const { openThreads } = await import('../channels/threads.mjs');
          const { runHandoff } = await import('../channels/handoff.mjs');
          const threads = openThreads(cfgDir);
          const replState = globalThis.__pomposReplState || {};
          const cur = replState.channel && replState.externalId
            ? threads.findByExternal(replState.channel, replState.externalId)
            : null;
          if (!cur) {
            process.stderr.write(
              `handoff: no thread bound to ${replState.channel || '(none)'}:${replState.externalId || '(none)'}\n`,
            );
            return true;
          }
          const next = await runHandoff({
            threads, channels: replState.channels || {},
            threadId: cur.threadId, target, externalId, note,
          });
          process.stdout.write(`handoff -> ${next.channel}:${next.externalId} (session ${next.sessionId})\n`);
          replState.channel = next.channel;
          replState.externalId = next.externalId;
        } catch (e) {
          process.stderr.write(`handoff failed: ${e.code || 'ERR'}: ${e.message}\n`);
        }
        return true;
      }
      case '/personality': {
        // Phase G: thin slash wrapper over cmdPersonality.
        const tail = line.slice('/personality'.length).trim();
        const parts = tail.split(/\s+/).filter(Boolean);
        await (await import('../commands/config.mjs')).cmdPersonality(parts[0] || 'list', parts[1], parts[2]);
        return true;
      }
      case '/exit': {
        // v5 Group A (C4): fire one updateUserModel call before exit so
        // the Honcho-style USER.md captures the durable facts surfaced
        // in this session. Wrapped in a 3-second timeout so a slow
        // trainer never makes /exit hang. Best-effort: failure logs are
        // suppressed so we don't disturb the clean shutdown.
        try {
          const turns = ctx.getSessionId()
            ? ctx.sessionsMod.loadTurns(ctx.getSessionId(), cfgDir)
            : ctx.getMessages().map((t) => ({ role: t.role, content: t.content }));
          if (turns && turns.length) {
            const trainer = (typeof getRegistry()?.resolveTrainer === 'function')
              ? getRegistry().resolveTrainer(cfg)
              : { provider: ctx.getActiveProvName(), model: ctx.getActiveModel() };
            const userModelPromise = import('../mas/user_modeler.mjs').then((m) =>
              m.updateUserModel({
                sessionTurns: turns,
                provider: trainer.provider,
                model: trainer.model,
                apiKey: _resolveAuthKey(cfg, trainer.provider),
                baseUrl: _resolveBaseUrl(trainer.provider),
                configDir: cfgDir,
              }),
            ).catch(() => null);
            await Promise.race([
              userModelPromise,
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
          }
        } catch { /* /exit must never hang or throw */ }
        return 'EXIT';
      }
      case '/config':
      case '/setup': {
        // Shared legacySlashRoute wiring (tests/f-config-slash-splash.test.mjs):
        // sets requestSetup + 'EXIT'; the post-loop guard runs the wizard.
        return legacySlashRoute(cmd, _legacyCtx);
      }
      default: {
        // Delegate ONLY ctx-safe dispatcher commands to the shared handler.
        // _legacyCtx is intentionally thin (no setters / openPicker / version),
        // so a blanket delegation would silently degrade picker- or setter-
        // driven handlers (/menu, /clear, /version, …). /channels is ctx-safe
        // (it has a lib/config fallback); everything else stays an honest
        // "unknown slash". 'EXIT' breaks the loop; a returned string prints.
        if (LEGACY_DELEGATED_SLASHES.has(cmd)) {
          const { args } = _parseSlashLine(line);
          const r = await _dispatchSlash(cmd, args, _legacyCtx, (s) => process.stdout.write(s));
          if (r === 'EXIT') return 'EXIT';
          if (typeof r === 'string' && r.length) process.stdout.write(r + '\n');
          return true;
        }
        process.stdout.write(`unknown slash: ${cmd} (try /help)\n`);
        return true;
      }
    }
  };

  return _legacyHandleSlash;
}
