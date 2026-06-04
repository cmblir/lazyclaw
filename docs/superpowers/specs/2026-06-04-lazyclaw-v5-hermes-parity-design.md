---
title: lazyclaw v5.0 Design Specification
date: 2026-06-04
status: draft-for-review
version: v5.0-design
author: yoo + Claude
---

# lazyclaw v5.0 Design Specification

> **상태**: draft-for-review. 본 문서는 v5.0 의 설계 정본이며, GA 전 변경 가능. §11 Phasing 의 rc.1 / rc.2 마일스톤이 합의 시점.
>
> **언어 정책**: 본문 한국어, 코드/식별자/파일경로/오류메시지는 영문 원본. (Global CLAUDE.md §2 적용)
>
> **정합성 정정 사항** — 본 문서는 1차 드래프트 모음의 다음 11개 모순을 해소한 정본이다. 상세는 §0.1.

---

## Table of Contents

- [0. 정합성 결정 (Canonical decisions)](#0-정합성-결정-canonical-decisions)
- [1. Overview & Motivation](#1-overview--motivation)
- [2. Trainer Provider — lazyclaw's USP](#2-trainer-provider--lazyclaws-usp)
- [3. lazy_orchestra: CLI-Native Learning Substrate](#3-lazy_orchestra-cli-native-learning-substrate)
- [4. FTS5 Search & Recall](#4-fts5-search--recall)
- [5. TUI Upgrade & Interactive Splash](#5-tui-upgrade--interactive-splash)
- [6. Sandbox 6-Backend](#6-sandbox-6-backend)
- [7. Tool Ecosystem & MCP Integration](#7-tool-ecosystem--mcp-integration)
- [8. Channel Expansion & Plugin System](#8-channel-expansion--plugin-system)
- [9. Persona System](#9-persona-system)
- [10. Migration: v4 → v5, Hermes Import, OpenClaw Import](#10-migration-v4--v5-hermes-import-openclaw-import)
- [11. Implementation Phasing & Parallel Execution](#11-implementation-phasing--parallel-execution)
- [Appendix A: Glossary](#appendix-a-glossary)
- [Appendix B: Open Questions for User](#appendix-b-open-questions-for-user)
- [Appendix C: Verified vs Unverified Claims](#appendix-c-verified-vs-unverified-claims)

---

## 0. 정합성 결정 (Canonical decisions)

드래프트 단계에서 11 개의 cross-section 모순이 발견되었고, 모두 v5.0 GA 이전에 해소되었다. 본 정본은 다음 결정을 **단일 진실** 로 사용한다 — 어느 후속 PR 도 이 표를 갱신하지 않고 다른 값을 도입할 수 없다.

### 0.1 Resolution table

| # | 모순 항목 | Canonical 결정 | 적용 섹션 |
|---|---|---|---|
| C1 | TrajectoryRecord.outcome vocab | **`'done' \| 'failed' \| 'abandoned'`** (3 값 고정). FTS5 인덱스 컬럼명도 동일. `'success'`/`'partial'` 폐기 | §3.3, §4.3, §4.5 |
| C2 | Trainer budget 단위 | **둘 다 공존**. `budget.maxCallsPerDay` (정수) **AND** `budget.usdPerDay` (float, optional). 둘 중 먼저 도달한 쪽이 fallback 트리거 | §2.3, §2.5 |
| C3 | Provider id 표기 | **kebab-case 고정**: `claude-cli`, `codex-cli`, `gemini-cli`. underscore form 폐기 | §2, §3, §4, §10, §11 |
| C4 | `trained_by` enum | **고정 enum**: `'claude-cli' \| 'codex-cli' \| 'gemini-cli' \| 'anthropic' \| 'openai' \| 'gemini' \| 'ollama' \| 'user' \| 'legacy' \| 'hermes-import' \| 'openclaw-import'` | §4.3, §5.5, §10.1.3, §10.2 |
| C5 | SKILL.md `group:` fallback | **filename hyphen-prefix → `legacy`** (no hyphen). `misc` 폐기, `legacy` 단일 사용. v5 신규 skill 은 frontmatter 명시 권장 | §5.5, §10.1.3 |
| C6 | USER.md path | **`~/.lazyclaw/memory/USER.md`** (memory dir). SOUL.md 만 config root (`~/.lazyclaw/SOUL.md`) | §9.2, §10.2, §10.3 |
| C7 | Personality storage | **`<configDir>/personalities/<name>.md`** (디렉터리). Hermes skin 도 이 디렉터리로 import (`personalities/hermes-<slug>.md`). root-level 단일 파일 폐기 | §9.1, §10.2 |
| C8 | Sandbox backends | **단일 enum, 6 종**: `local`, `docker`, `ssh`, `singularity`, `modal`, `daytona`. OS-native sandboxer (seatbelt/bubblewrap/firejail/landlock) 는 `local` 백엔드의 **하위 옵션** (`local.confiner`), 별도 backend 아님 | §6, §11.5 |
| C9 | Trainer `"auto"` literal | **명시 지원**. `trainer: "auto"` 또는 `trainer.provider: "auto"` 는 (a) Claude Pro/Max 세션 감지 시 `claude-cli`, (b) 미감지 시 chat provider 미러로 resolve | §2.3, §11.2 |
| C10 | Persona compose stack | **워크스페이스 SOUL.md** 는 layer 1.5 로 명시 (global SOUL 직후, personality 이전). 7 → 8 layer 가 아니라 layer 1 이 두 sub-source 로 합쳐짐 | §9.3 |
| C11 | better-sqlite3 native dep | **명시**. v5.0 breaking-bump 의 일부로 수용. 사전 빌드 binary 가 darwin/linux/win64 × x64/arm64 커버, 그 외(musl, freebsd) 는 docs 의 fallback 가이드로 안내 | §4.2, §11.2 |

### 0.2 Out of scope reaffirmation

review notes 의 scope concerns 중 다음은 **v5.0 에서 유지** (정당화 첨부), 나머지는 **v5.1 이후로 이동**:

- **유지 (v5.0)**: 6-backend sandbox (CLI orchestrator 의 cross-machine 분산 worker 가 USP 핵심), Trainer split, FTS5 recall, MCP client, 45-tool catalogue, 채널 플러그인 골격(F1–F7), Hermes/OpenClaw import.
- **이동 (v5.1+)**: Voice channel 의 TTS reply (transcribe 만 v5.0, TTS 는 deferred), Home Assistant tools (ha_state/ha_call), playwright_record, Nudge loop 의 cross-channel 송신, anti-pattern synth 의 **자동** 실행 (v5.0 은 manual `lazyclaw orchestra anti-pattern-sweep`). 이는 §7.2 와 §11.3 에 sentinel 로 표기되어 있다.

---

## 1. Overview & Motivation

### 1.1 문제 정의 — v4 는 "학습 부품" 만 있고 루프가 없다

lazyclaw v4.3 는 self-improving agent 의 **부품** 은 이미 갖고 있다.

- **Skill synthesis** — `mas/skill_synth.mjs:160` `synthesizeSkill()` 가 한 task 가 끝나면 reusable skill 한 장을 LLM 호출로 짜고, `mas/skill_synth.mjs:218` `reserveSynthName()` 로 사람이 쓴 skill 을 클로버하지 않게 버전 bump.
- **Skills curator** — `skills_curator.mjs` 와 `skills_install.mjs` 가 agentskills.io 호환 포맷으로 skill 을 install / curate.
- **Layered memory** — `memory.mjs:30` 에 `core.md` (장기) / `recent.jsonl` (append-only, RECENT_CAP=200) / `episodic/<topic>.md` (`dream()` 로 LLM 압축) 3 단 구조.
- **Agent memory** — `mas/agent_memory.mjs` 가 agent-per-session 격리 working memory.
- **Multi-provider** — `providers/registry.mjs:256` 가 `anthropic` / `openai` / `gemini` / `ollama` / `claude-cli` / `codex-cli` / `gemini-cli` / orchestrator 를 한 dispatch 테이블에 묶고, `providers/orchestrator.mjs` 가 planner→worker→synthesis 체인을 실행.

그러나 **closed feedback loop 가 없다.** 부품들이 분리되어 있고, 다음이 모두 빠져 있다.

1. **Trajectory capture** — task → tool calls → outcome 시퀀스를 구조화 저장하는 store 자체가 없다. `recent.jsonl` 은 `{sessionId, role, content, ts}` 만 (`memory.mjs:6`).
2. **FTS5 검색** — episodic 는 파일 이름 grep + `dream()` 의 topic slug 로만 검색. `memory.mjs:58` `listEpisodic()` 는 directory listing.
3. **User model** — Hermes 가 채택한 Honcho-equivalent (persistent user representation) 가 없다.
4. **Cross-CLI knowledge transfer** — `claude-cli` worker 가 짠 skill 을 `codex-cli` worker 가 자동으로 못 쓴다. effectiveness 메타가 없음.
5. **Closed loop** — synth → install → use → score → re-synth cycle 부재.

결과: v4 는 agent 를 **돌리는** 런타임이지, 시간이 갈수록 **나아지는** 런타임이 아니다.

### 1.2 기회 — CLI orchestrator 는 학습 substrate 로 유리하다

| 차원 | Hermes Agent | lazyclaw v4 |
|---|---|---|
| Worker | Anthropic / OpenAI API 직접 호출 | `claude-cli` / `codex-cli` / `gemini-cli` subprocess |
| 청구 | Nous Portal 단일 묶음 | 사용자의 기존 CLI 구독 / API 키 그대로 |
| Sandbox | 자체 sandbox | CLI 의 plan mode / approval 그대로 활용 |
| Auth | API 키만 | OAuth, API 키, ed25519 device-auth (`gateway/device_auth.mjs`) |

lazyclaw 의 **CLI worker 모델** 은 학습 substrate 로 보면 세 가지 비대칭 이득이 있다.

1. **무료 추론 표면** — Claude Pro/Max 구독자는 `claude-cli` 호출에 한도 안에서 추가 비용 0.
2. **이미 검증된 tool sandbox** — claude-cli / codex-cli 가 자체 권한 모델 보유. lazyclaw 는 trajectory 만 가로채면 됨.
3. **Cross-CLI ensemble** — 동일 task 를 `claude-cli` 와 `codex-cli` 에 동시 디스패치하여 비교 가능.

### 1.3 차별화 — Trainer provider 분리 (USP)

> **`provider` 와 `trainer` 를 config 에서 분리한다.**

```jsonc
{
  "provider": "claude-cli",
  "trainer": {
    "provider": "claude-cli",
    "model": "claude-haiku-4-5",
    "schedule": "nightly",                // on-tick | nightly | manual
    "budget": {
      "maxCallsPerDay": 200,              // hard cap (count)
      "usdPerDay": 0.50                   // optional soft cap (cost)
    },
    "fallback": "openai:gpt-4o-mini"
  }
}
```

이 분리가 만드는 USP:

| 사용자 segment | `provider` | `trainer` | 학습 marginal cost |
|---|---|---|---|
| Claude Pro/Max 구독 | `claude-cli` | `claude-cli` | **$0** (구독 한도 내) |
| Claude Pro/Max + OpenAI 키 | `claude-cli` | `openai:gpt-4o-mini` | 학습만 분리 청구 |
| API only | `anthropic` | `anthropic` (cheaper model) | 분리 모델 선택으로 절감 |
| 오프라인 | `ollama` | `ollama` | $0 |

### 1.4 High-level architecture

```
                                  ┌──────────────────────────────────────┐
   user ──────► cli.mjs ────────► │       lazy_orchestra (core)          │
   channel ──► daemon.mjs ──────► │  • turn loop                         │
   webhook ──► gateway/http ────► │  • provider dispatch                 │
                                  │  • skill resolution                  │
                                  │  • trajectory capture (NEW)          │
                                  └────────────┬──────────┬──────────────┘
                                               │          │
                            ┌──────────────────┘          └────────────────────┐
                            ▼                                                  ▼
                  ┌───────────────────┐                          ┌──────────────────────────┐
                  │  CLI workers      │                          │  Learning substrate (NEW)│
                  │  claude-cli       │◄── trajectory ──────────►│  index.db (SQLite+FTS5)  │
                  │  codex-cli        │    {task, steps,         │  skills/ (effectiveness) │
                  │  gemini-cli       │     tools, verdict}      │  memory/USER.md          │
                  └─────────┬─────────┘                          │  trainer (separate)      │
                            │                                    └──────────────────────────┘
                  ┌─────────▼─────────┐
                  │  API providers    │
                  │  anthropic/openai │
                  │  gemini/ollama    │
                  └───────────────────┘
```

### 1.5 Goals / Non-goals

**Goals (v5.0)** — G1 SQLite+FTS5 trajectory store · G2 Closed skill loop · G3 Trainer config 분리 · G4 USER.md (Honcho-equiv) · G5 Cross-CLI transfer 메타 · G6 MCP client · G7 `lazyclaw migrate v5` · G8 Persona 7-layer compose · G9 6-backend sandbox · G10 45 first-party tools + toolset groups · G11 Channel plugins (5 core in-tree + 5 옵션 `@lazyclaw/channel-*`).

**Non-goals (v5.0)** — N1 weight update / fine-tuning · N2 자체 model serving · N3 Nous Portal 통합 · N4 multi-tenant SaaS · N5 RLHF UI · N6 MCP **server** (client only) · N7 voice TTS reply (transcribe only) · N8 Home Assistant / playwright_record tools.

### 1.6 Hermes Agent 파리티 매트릭스

| Hermes feature | lazyclaw v5 equivalent | 상태 |
|---|---|---|
| `hermes-core` 런타임 | `lazy_orchestra` (`mas/orchestra.mjs`) | rename + 확장 |
| API workers | `providers/anthropic.mjs`, `providers/openai.mjs` | 기존 |
| **CLI workers** | `claude-cli` / `codex-cli` / `gemini-cli` | **lazyclaw 단독** |
| `hermes claw migrate` | `lazyclaw migrate`, `lazyclaw hermes import`, `lazyclaw openclaw import` | 신규 (§10) |
| Trajectory store | `~/.lazyclaw/index.db` (SQLite+FTS5) | 신규 |
| Skill bank | `skills_curator.mjs` + effectiveness 메타 (§3.5) | 확장 |
| Honcho user model | `~/.lazyclaw/memory/USER.md` + `fts_memories.kind='user_model'` | 신규 |
| MCP | client only (§7.4) | 신규 |
| Memory consolidation | `dream()` + episodic + trainer 갱신 | 기존 + 강화 |
| Nous Portal 청구 묶음 | **의도적 비채택** | — |
| Plan mode / approval | CLI worker passthrough + `mas/tool_runner.mjs` | 기존 |
| Multi-channel inbound | Slack / Matrix / Telegram / webhook | 기존 |

### 1.7 v4 → v5 변경 영향

| 영역 | v4 | v5 | 종류 |
|---|---|---|---|
| `cli.mjs`, `daemon.mjs` | 단일 entry | 그대로 + trajectory hook | additive |
| `providers/registry.mjs` | provider dispatch | `resolveTrainer()` 추가 | additive |
| `memory.mjs` | `core.md`/`recent.jsonl`/`episodic` | `recent.jsonl` → `index.db`. core/episodic 유지 | partial replace |
| `mas/skill_synth.mjs` | one-shot | closed loop step. signature 호환 | refactor in place |
| `skills/*.md` frontmatter | name/description/version | + `group` / `trained_by` / `confidence` / `cross_cli_tested` | additive |
| Config schema | `cfg.provider` 단일 | + `trainer`, `sandbox.bindings`, `mcp`, `toolsets`, `persona` | additive |
| Channels | Slack/Matrix/Telegram/HTTP in-tree | core 5 in-tree + `@lazyclaw/channel-*` 플러그인 골격 | additive |
| `package.json` deps | pure JS | + `better-sqlite3` (prebuilt), `ink` | **breaking (native build)** |

**Breaking** — `better-sqlite3` native dep, `index.db` 디스크 스키마, skill frontmatter 신규 필드. v5.0 major bump 로 정당화하고 `lazyclaw migrate` 가 백업 + 자동 마이그레이션. **Non-breaking** — chat REPL, channel inbound, provider list, daemon HTTP API. trainer 미설정 시 v4 동일 동작 → **opt-in self-improvement** 가 기본값.

---

## 2. Trainer Provider — lazyclaw's USP

### 2.1 Scope: runtime learning, not weight updates

| Axis | Weight training (offline, out of scope) | Runtime learning (online, in scope) |
|---|---|---|
| Artifact | Model checkpoint (`.safetensors`) | Skill bank, USER.md, FTS5 index, lessons |
| Loop | Atropos/Axolotl/TRL job, GPU-bound | Synthesize-on-task-done, ms–s, CPU-bound |
| Inputs | Curated trajectories, reward signals | Single transcript + adapter prompt |
| Output | New weights | New `SKILL.md`, `LESSON.md`, FTS5 row |
| Hermes equivalent | External Atropos job | `hermes` learning loop |
| lazyclaw v5.0 | Trajectory **export only** (§2.7) | `mas/skill_synth.mjs`, `mas/agent_memory.mjs` |

**lazyclaw v5.0 는 Hermes 와 같은 lane (runtime learning) 에 머무른다.** weight 학습은 in-process 로 하지 않는다. 다만 외부 trainer 가 소비할 수 있는 trajectory 를 export 한다 (§2.7).

### 2.2 Why split trainer from chat

세 가지 독립 이유:

1. **Cost control.** Synthesis 는 bursty + bounded (task-done 당 1 회, ~1–4k 토큰). Chat 은 hot-path + unbounded. cheap 모델로 라우팅하면 per-task 학습 비용 10–50× 감소.
2. **Model-class control.** Skill 작성은 *summarisation + structuring* — instruction-tuned small model 이 충분 (덜 verbose, rule-following). Chat 은 reasoning headroom 필요.
3. **Subscription-mode arbitrage.** lazyclaw-specific 레버. trainer 를 CLI worker (`providers/claude_cli.mjs:1`) 로 라우팅 → 사용자의 Claude Pro/Max 구독으로 학습 = **$0 marginal cost**. Hermes 는 architecturally 불가.

이유 3 하나만으로 major bump 정당화.

### 2.3 Config schema

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",

  "trainer": {
    "provider": "claude-cli",
    "model": "claude-haiku-4-5",
    "schedule": "nightly",
    "fallback": "openai:gpt-4o-mini",
    "maxTokens": 2048,
    "budget": {
      "maxCallsPerDay": 200,
      "usdPerDay": 0.50
    }
  }
}
```

규칙:

- `trainer` **omitted** → `resolveTrainer(cfg)` 가 chat provider 를 그대로 반환 (v4 동일).
- `trainer.provider: "auto"` → Claude Pro/Max 세션 감지 (`providers/claude_cli.mjs` 가 OAuth 토큰 보유) 시 `claude-cli`, 미감지 시 chat provider mirror.
- `trainer.schedule` ∈ `{on-tick, nightly, manual}` — `on-tick` 은 task-done 즉시, `nightly` 는 cron, `manual` 은 `lazyclaw orchestra learn` 명령 시.
- `trainer.fallback` — `provider:model` 문자열. 예외 발생 **또는** budget cap 도달 시 사용.
- `trainer.budget.maxCallsPerDay` — 정수 호출 횟수 cap.
- `trainer.budget.usdPerDay` — optional float. 둘 중 **먼저** 도달한 cap 이 fallback 트리거. (review note C2 해소)

### 2.4 API surface: `resolveTrainer(cfg)`

```js
// providers/registry.mjs (new export)

/**
 * Resolve trainer provider+model for synthesis/reflection calls.
 *
 * @param {object} cfg
 * @param {object} [opts]
 * @param {boolean} [opts.useFallback]
 * @returns {{ provider, model, apiKey?, baseUrl? }}
 */
export function resolveTrainer(cfg, opts = {}) {
  const t = cfg && cfg.trainer;
  if (!t || !t.provider) {
    return { provider: cfg.provider, model: cfg.model };
  }
  if (t.provider === 'auto') {
    return detectAutoTrainer(cfg);     // claude-cli if Pro/Max, else mirror
  }
  if (opts.useFallback && t.fallback) {
    const { provider, model } = parseProviderModel(t.fallback);
    return { provider: provider || cfg.provider, model: model || cfg.model };
  }
  return { provider: t.provider, model: t.model || cfg.model };
}
```

Call sites that switch:

| Site | v4 | v5 |
|---|---|---|
| `mas/skill_synth.mjs::synthesizeSkill` | `runTextCompletion({provider: cfg.provider, ...})` | `runTextCompletion({...resolveTrainer(cfg), ...})` |
| `mas/agent_memory.mjs::reflectOnce` | 동일 | 동일 |
| `daemon.mjs:1755` reflect dispatch | cfg 직접 | `resolveTrainer(cfg)` |
| `cli.mjs:4910` `synthMod` | cfg 직접 | `resolveTrainer(cfg)` |

### 2.5 Three user scenarios

| # | Scenario | `provider` | `trainer.provider` | Effective learning cost |
|---|---|---|---|---|
| 1 | Subscription (Claude Pro/Max) | `claude-cli` | `claude-cli` | **$0** |
| 2 | API user, cost-split | `anthropic` (Opus) | `openai:gpt-4o-mini` | ~$0.0002 / task-done |
| 3 | Multi-CLI orchestrator | `orchestrator` | `gemini-cli` (free tier) | $0 for synth |

### 2.6 Cost tracking

- Sink: `~/.lazyclaw/trainer-cost.jsonl`, one record per synth call.
- Schema: `{ts, kind: 'skill_synth'|'reflect', provider, model, usage: {in, out}, usd, taskId, fallbackUsed, callsToday}`.
- Writer: `providers/rates.mjs::appendTrainerCost(call, rates)`.
- Budget enforcement: 24h rolling window — `callsToday` 와 `usdToday` 둘 다 추적, 어느 한쪽이라도 cap 초과 시 다음 호출부터 fallback. cap-hit 시 `mas/audit.mjs` 에 1 entry.
- Surfacing: `lazyclaw rates --trainer-only --window 7d` (`cli.mjs:927`).

```bash
$ lazyclaw rates --trainer-only --window 7d
  provider           model              kind          calls     usd
  claude-cli         claude-haiku-4-5   skill_synth      41   $0.00
  claude-cli         claude-haiku-4-5   reflect         128   $0.00
  openai             gpt-4o-mini        skill_synth       3   $0.0006
  total                                                 172   $0.0006
```

### 2.7 Trajectory export

```bash
lazyclaw trajectories export \
  --format atropos|axolotl|openai-ft|jsonl \
  --since 7d \
  --filter "outcome=done" \
  --out ./trajectories/
```

| `--format` | Layout | Consumed by |
|---|---|---|
| `atropos` | `{messages, reward, metadata}` per line | NousResearch Atropos |
| `axolotl` | ShareGPT-style | Axolotl SFT/DPO |
| `openai-ft` | `{messages: [...]}` per line | OpenAI fine-tuning |
| `jsonl` | Raw transcripts | Custom |

Read-only — exporter 는 trainer 를 spawn 하지 않고 weights 를 건드리지 않는다.

---

## 3. lazy_orchestra: CLI-Native Learning Substrate

### 3.1 Why `lazy_orchestra`

v4 의 `providers/orchestrator.mjs:115` `makeOrchestratorProvider()` 는 PLAN → EXECUTE → SYNTHESIS 의 stateless 3 단계. lazyclaw 의 worker 는 **CLI subprocesses** — `claude-cli` (`providers/claude_cli.mjs:103`), `codex-cli` (`providers/codex_cli.mjs`), `gemini-cli` (`providers/gemini_cli.mjs`) — 즉 trajectory 가 heterogeneous 하다. 이 heterogeneity 가 cross-distribution 학습 신호로 작동한다.

rename `orchestrator → lazy_orchestra` 는 semantic 단절을 표시: 모듈은 더 이상 request router 가 아니라 **learning substrate**.

### 3.2 Phase evolution: 3 → 5

| Phase | v4 (`providers/orchestrator.mjs`) | v5 (`mas/orchestra.mjs`) |
|---|---|---|
| **PLAN** | planner LLM + chat history | + **`skill_index`** (`skills.skillsIndex()`, `skills.mjs:110`) + recent failure tags |
| **DISPATCH** | round-robin | per-worker **`recallSkills(subtask, workerName)`** top-k |
| **EXECUTE** | flat `result` 문자열 | adapter-normalised **`TrajectoryRecord`** 캡처 (turns, tool calls, thinking, tokens, cost) |
| **SYNTHESIS** | planner reduces | 동일 + synthesis 가 worker trajectory 의 terminal turn 으로 피드백 |
| **POST-HOC LEARNING** | _(없음)_ | per-worker `skill_synth` + 5 triggers (§3.7), trainer provider 위에서 off critical path |

처음 4 단계는 critical path 에 머무름 (overhead ~50–200 ms). 5 단계는 trainer 위에서 **off critical path** — Pro/Max 구독자는 $0, API 사용자는 cheap 모델 별도 청구.

### 3.3 `TrajectoryRecord` schema

```typescript
// mas/trajectory.d.ts
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string | null;
  durationMs: number;
  success: boolean;
}

export interface Turn {
  turnIdx: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: ToolCall[];
  thinking?: string;
  tokensUsed?: { input: number; output: number; cache_read?: number };
  cost?: number;
}

export interface TrajectoryRecord {
  id: string;                            // ULID
  taskId: string;
  agentName: string;
  workerProvider: 'claude-cli' | 'codex-cli' | 'gemini-cli'
                | 'anthropic' | 'openai' | 'gemini' | 'ollama';
  workerModel: string;
  startedAt: number;
  endedAt: number;
  systemPrompt: string;
  userMessages: string[];
  turns: Turn[];
  finalAnswer: string;
  outcome: 'done' | 'failed' | 'abandoned';   // canonical (C1)
  ratings?: {
    fromUser?: -1 | 0 | 1;
    fromCritic?: number;                 // 0..1
  };
}
```

Storage:

- JSONL append: `~/.lazyclaw/trajectories/<YYYY-MM-DD>/<id>.jsonl`.
- SQLite mirror: rows in `fts_trajectories` (§4.3) for recall.
- 30-day retention default; redaction via `mas/redact.mjs` at write time.

### 3.4 Adapter normalisers

| Provider | Stream | Adapter |
|---|---|---|
| `providers/claude_cli.mjs:92` | `stream-json` NDJSON | per-line parser, `tool_use`/`tool_result` blocks |
| `providers/codex_cli.mjs:14` | NDJSON `item.completed` | one turn per `agent_message`, `reasoning` → `thinking` |
| `providers/gemini_cli.mjs:14` | single JSON blob | synthesise one assistant turn |
| `providers/anthropic.mjs`, `openai.mjs`, `gemini.mjs` | SSE | reuse existing parsers |
| `providers/openai_compat.mjs`, `ollama.mjs` | OpenAI-compat SSE / line JSON | OpenAI adapter fallback |

Contract:

```js
// mas/trajectory_adapters/base.mjs
export async function* captureTrajectory(providerStream, record) {
  // providerStream: AsyncIterable<string>
  // record: TrajectoryRecord (mutated in place)
  // yields the same chunks untouched
}
```

v4 caller path (`for await (const chunk of worker.prov.sendMessage(...))` at `providers/orchestrator.mjs:241`) 는 byte-identical 유지.

### 3.5 Cross-CLI skill transfer

SKILL.md frontmatter 확장:

```yaml
---
name: refactor-mjs-imports
description: Reorganise ESM imports in .mjs files
version: 3
group: dev
created_by: agent
source_task: t_01HZW...
created_at: 2026-06-04
# v5 additions
trained_by: claude-cli           # canonical kebab-case (C3)
trained_on_model: claude-opus-4-7
trajectory_ref: 01HZW9KQ8N...
cross_cli_tested:
  - provider: codex-cli
    model: gpt-5-codex
    outcome: done                  # canonical (C1)
    tested_at: 2026-06-02
  - provider: gemini-cli
    model: gemini-2.5-pro
    outcome: failed                # negative signal
    tested_at: 2026-06-02
confidence: 0.82                   # Wilson lower bound
---
```

`reserveSynthName` (`skills.mjs:155`) 와 `parseFrontmatter` (`skills.mjs:66`) 는 flat-YAML 임의 키 허용 → writer 확장만 필요.

`recallSkills(subtask, workerProvider)` ranking:

1. `cross_cli_tested[provider === workerProvider].outcome === 'done'` — direct evidence
2. `confidence` (Wilson lower bound)
3. Embedding similarity (없으면 substring fallback)

`outcome === 'failed'` entries → recall filtered out, but kept as negative signal for curator.

### 3.6 Five learning triggers

| Trigger | Fires on | What runs |
|---|---|---|
| **post-task** | `outcome === 'done'`, after SYNTHESIS | per-worker `synthesizeSkill()` (`mas/skill_synth.mjs:160`) |
| **post-failure** | `outcome === 'failed'` or worker throw | asymmetric synth — **pitfall skill** |
| **nudge** | user reply contains thumbs / "wrong" / "again" / explicit rating | re-run synth with correction folded in |
| **active-recall-miss** | high-recall skill produced wrong outcome | decrement `confidence`; if `< 0.3` → move to `~/.lazyclaw/skills/.archive/` |
| **periodic-curation** | cron-driven (default `0 4 * * *` via `cron.mjs`) or `lazyclaw orchestra curate` | replay last N successful trajectories through `skills_curator.mjs`; merge near-duplicates |

5 triggers funnel into `runLearning(trigger, ctx)` in `mas/orchestra.mjs`.

### 3.7 Trainer provider separation (config)

```jsonc
{
  "provider": "claude-cli",
  "model": "opus",
  "orchestra": {
    "planner":  "claude-cli:claude-opus-4-7",
    "workers":  ["claude-cli:claude-sonnet-4-6",
                 "codex-cli:gpt-5-codex",
                 "gemini-cli:gemini-2.5-pro"],
    "trainer":  "claude-cli:claude-haiku-4-5",
    "learning": {
      "triggers": ["post-task", "post-failure", "nudge",
                   "active-recall-miss", "periodic-curation"],
      "maxPerHour": 12,
      "redactLevel": "strict"
    }
  }
}
```

### 3.8 Code sketch: `mas/orchestra.mjs`

```js
import { PROVIDERS, PROVIDER_INFO, resolveTrainer } from '../providers/registry.mjs';
import { skillsIndex } from '../skills.mjs';
import { synthesizeSkill, installSynthesized } from './skill_synth.mjs';
import { captureTrajectory } from './trajectory_adapters/index.mjs';
import { recallSkills, recordTrajectory } from './trajectory_store.mjs';
import { runLearning } from './learning.mjs';

export function makeOrchestraProvider({ cfgGetter, keyResolver } = {}) {
  return {
    name: 'orchestra',
    async *sendMessage(messages, callerOpts = {}) {
      const cfg = cfgGetter() || {};
      const o = cfg.orchestra || cfg.orchestrator || {};
      const planner = _lookupProvider(o.planner);
      const workers = (o.workers || [o.planner]).map(_lookupProvider).filter(Boolean);
      const trainer = _lookupProvider(o.trainer || _defaultTrainer(cfg));

      // Phase 1: PLAN + skill_index
      const skillIdx = skillsIndex();
      const planSystem = PLANNER_SYSTEM
        + (skillIdx ? `\n\nAvailable skills:\n${skillIdx}` : '');
      const planRaw = await _streamCollect(planner, [
        { role: 'system', content: planSystem }, ...messages,
      ], callerOpts);
      const plan = _bestPlanArray(planRaw);
      yield `### 1. Planning\n${plan.map(p => `- ${p.task}`).join('\n')}\n\n`;

      // Phase 2-3: DISPATCH + EXECUTE
      const trajectories = [];
      yield `### 2. Executing ${plan.length} subtask(s)\n\n`;
      for (let i = 0; i < plan.length; i++) {
        const sub = plan[i];
        const worker = workers[i % workers.length];
        const recalled = await recallSkills(sub.task, worker.name, { k: 3 });
        const workerSystem = recalled.length
          ? recalled.map(s => `<!-- skill: ${s.name} -->\n${s.body}`).join('\n\n---\n\n')
          : '';

        const stream = worker.prov.sendMessage(
          [{ role: 'user', content: sub.task }],
          { apiKey: keyResolver(cfg, worker.name), model: worker.model,
            system: workerSystem, signal: callerOpts.signal },
        );
        const traj = { id: ulid(), taskId: callerOpts.taskId,
          agentName: `worker-${i}`,
          workerProvider: worker.name, workerModel: worker.model,
          startedAt: Date.now(), systemPrompt: workerSystem,
          userMessages: [sub.task], turns: [], finalAnswer: '' };
        for await (const chunk of captureTrajectory(stream, traj)) yield chunk;
        traj.endedAt = Date.now();
        traj.outcome = traj.turns.length ? 'done' : 'abandoned';
        recordTrajectory(traj);
        trajectories.push(traj);
        yield `\n---\n\n`;
      }

      // Phase 4: SYNTHESIS
      yield `### 3. Synthesis\n\n`;
      yield* _streamSynthesis(planner, messages, trajectories, callerOpts);

      // Phase 5: POST-HOC LEARNING (off critical path)
      queueMicrotask(() => {
        for (const traj of trajectories) {
          runLearning(traj.outcome === 'done' ? 'post-task' : 'post-failure', {
            trajectory: traj, trainer, cfg,
          }).catch(err => console.error('[orchestra] learning failed:', err.message));
        }
      });
    },
  };
}
```

### 3.9 Compatibility & migration

- `cfg.orchestrator` (v4 키) 는 `cfg.orchestra` 부재 시 fallback 으로 읽힘 → v4 config 호환.
- `lazyclaw migrate` (§10) 가 `~/.lazyclaw/backup-v4/` 스냅샷 후 변환.
- `providers/orchestrator.mjs` 는 한 minor cycle 동안 `providers/orchestrator-legacy.mjs` 로 유지, deprecated name `orchestrator-v4` 로 등록.

---

## 4. FTS5 Search & Recall

### 4.1 Motivation

v4 lazyclaw 는 durable state 를 파일시스템에 분산 저장: sessions JSONL (`sessions.mjs:36`), per-agent memory (`mas/agent_memory.mjs:23`), skills (frontmatter Markdown), curator artifacts. Recall 은 grep — linear scan, no ranking, no cross-store joins.

v5.0 은 FTS5 만 — embeddings 는 v5.1 의 옵션 `embeddings` virtual table 로 deferred. 핵심 차별화: `fts_trajectories` 가 **모든 worker CLI 의 출력** 을 한 corpus 로 인덱싱한다.

### 4.2 Storage

`~/.lazyclaw/index.db` (단일 SQLite 파일), daemon (`daemon.mjs`) boot 시 `openIndex({ create: true })`. **better-sqlite3 native dep** 추가 (review note C11 — v5.0 breaking-bump 의 일부로 명시 수용). prebuilt binaries: darwin/linux/win64 × x64/arm64. musl/freebsd 는 docs 의 fallback 가이드.

Lifecycle:
- `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`
- Schema 마이그레이션 via `meta.schema_version`
- 1 writer (daemon) + many readers (CLI subcommands, MAS tool calls) — WAL handles
- Crash recovery: WAL replay on next open

### 4.3 Schema

```sql
CREATE VIRTUAL TABLE fts_sessions     USING fts5(content,
  session_id UNINDEXED, turn_idx UNINDEXED, role UNINDEXED, ts UNINDEXED);
CREATE VIRTUAL TABLE fts_skills       USING fts5(content,
  skill_name UNINDEXED, trained_by UNINDEXED, group_name UNINDEXED);
CREATE VIRTUAL TABLE fts_trajectories USING fts5(content,
  trajectory_id UNINDEXED, agent UNINDEXED, outcome UNINDEXED);
CREATE VIRTUAL TABLE fts_memories     USING fts5(content,
  topic UNINDEXED, kind UNINDEXED);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

| Table | `content` is | UNINDEXED metadata | Domain |
|---|---|---|---|
| `fts_sessions` | one turn's `role: content` | `session_id`, `turn_idx`, `role`, `ts` | `role` ∈ {system, user, assistant, tool} |
| `fts_skills` | skill Markdown body (post-`sanitizeSkillBody`) | `skill_name`, `trained_by`, `group_name` | `trained_by` ∈ canonical enum (C4) |
| `fts_trajectories` | reflection + tool-call trace | `trajectory_id`, `agent`, `outcome` | `outcome` ∈ `{done, failed, abandoned}` (C1) |
| `fts_memories` | core/episodic/user-model/agent entry | `topic`, `kind` | `kind` ∈ {core, recent, episodic, user_model, agent} |

`trained_by` canonical enum (C4): `'claude-cli' | 'codex-cli' | 'gemini-cli' | 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'user' | 'legacy' | 'hermes-import' | 'openclaw-import'`.

UNINDEXED → zero tokenisation 비용이지만 `WHERE` + `SELECT` 가능. 별도 relational table 불필요.

### 4.4 Write-through hooks

| Write path | File:line | Index call |
|---|---|---|
| `sessions.appendTurn(id, role, content)` | `sessions.mjs:70` | `indexSessionTurn({session_id, turn_idx, role, ts, content})` |
| `skill_synth.installSynthesized({name, body, ...})` | `mas/skill_synth.mjs:213` | `indexSkill({skill_name, trained_by, group_name, content})` |
| `trajectory_store.put(record)` *(new in §3)* | `mas/trajectory_store.mjs` | `indexTrajectory({trajectory_id, agent, outcome, content})` |
| `user_modeler.update(fact)` *(new)* | `mas/user_modeler.mjs` | `indexMemory({topic, kind: 'user_model', content})` |
| `agent_memory.writeMemory(name, entry)` | `mas/agent_memory.mjs` | `indexMemory({topic: name, kind: 'agent', content})` |

```js
// mas/index_store.mjs
import Database from 'better-sqlite3';

let db = null;
const stmts = {};

export function openIndex(configDir) {
  if (db) return db;
  db = new Database(path.join(configDir, 'index.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  ensureSchema(db);
  stmts.insertSession = db.prepare(
    `INSERT INTO fts_sessions(content, session_id, turn_idx, role, ts)
     VALUES (?, ?, ?, ?, ?)`
  );
  // ... one prepared statement per table
  return db;
}

export function indexSessionTurn({ session_id, turn_idx, role, ts, content }) {
  try {
    if (!db) return;
    stmts.insertSession.run(redactSecrets(content), session_id, turn_idx, role, ts);
  } catch (e) {
    log.warn('index_session_failed', { session_id, err: e.message });
  }
}
```

Index failure 는 logging 으로 처리, 절대 session-write path 를 break 하지 않음 (`sessions.appendTurn` 의 v4 invariant 유지). 모든 content 는 `redactSecrets` (`mas/redact.mjs:18`) 통과 후 insert → 단일 chokepoint.

### 4.5 The `recall` API

```ts
recall(query: string, opts?: {
  scope?: ('sessions' | 'skills' | 'trajectories' | 'memories')[];
  k?: number;             // default 10, max 50
  summarize?: boolean;    // default false
  filter?: {
    session_id?: string;
    agent?: string;
    outcome?: 'done' | 'failed' | 'abandoned';   // canonical (C1)
    trained_by?: string;                          // canonical enum (C4)
    group_name?: string;
    kind?: string;
    since?: number;
  };
}): Promise<RecallResult>
```

```ts
{
  query: string,
  hits: Array<{
    scope: string,
    rank: number,
    bm25: number,
    snippet: string,   // FTS5 snippet() with <mark>...</mark>
    metadata: Record<string, string|number>,
  }>,
  summary?: string,
  summarizedBy?: string,
  latencyMs: number,
}
```

3 surfaces:

1. **JS API** — `cli.mjs`, `daemon.mjs`, MAS agents.
2. **CLI** — `lazyclaw recall <query> [--scope sessions,trajectories] [--k 5] [--summarize] [--json]`.
3. **Agent-callable tool** — registered via `mas/tool_runner.mjs:1` (§7.2 #9).

### 4.6 Trainer-summarised recall

`summarize: true` → top-K snippets (≤6 KB) → **trainer** provider (not chat). Pro/Max: $0. API user with `trainer: openai:gpt-4o-mini`: ~$0.0002/recall. Reuses `mas/provider_adapters.mjs:1::runTextCompletion`.

Trainer 실패 시 raw hits + `summary: null` + `summarizedBy: null` 반환. 재시도 없음 (사용자가 프롬프트에 있음).

### 4.7 Cross-CLI trajectory recall — the differentiator

`fts_trajectories` 는 어떤 다른 CLI 에이전트도 채울 수 없는 table. claude-cli / codex-cli / gemini-cli 가 모두 한 corpus 로 흘러들어옴.

```bash
lazyclaw recall "next.js app router auth" --scope trajectories --summarize
```

→ *"Last March, claude-cli tried `middleware.ts`-based redirect (done). In April, codex-cli refactored to server actions (failed — broke `auth.test.ts:42`). gemini-cli's attempt in May reverted to middleware. Recommend the claude-cli pattern."*

### 4.8 Rebuild & integrity

```bash
lazyclaw index rebuild           # full reindex
lazyclaw index check             # PRAGMA integrity_check + FTS5 'integrity-check'
lazyclaw index stats             # row counts, db size, last_full_rebuild_ts
```

### 4.9 Performance budget

| Operation | Budget |
|---|---|
| Single-turn insert | < 1 ms |
| Bulk migration insert (10k) | < 800 ms (1 transaction) |
| `recall(query, {k: 10})` cold | < 80 ms |
| `recall(query, {k: 10})` warm | < 15 ms |
| `recall(query, {summarize: true})` | < 80 ms FTS + provider latency |

Microbenchmarks in `tests/index_store.bench.mjs`, CI fails on >20% regression.

### 4.10 User modeler integration (Honcho-equiv)

User modeler (§9 + future §) extracts durable facts → 각 fact 는 `fts_memories` 의 1 row, `kind = 'user_model'`. 영구 file: **`~/.lazyclaw/memory/USER.md`** (C6 — config root 가 아니라 memory dir).

Chat-prompt-assembly 시점에 (in `daemon.mjs`'s prompt builder, where `agent_memory.readMemory` is called):

```js
const userBits = await recall(currentUserTurn, {
  scope: ['memories'],
  filter: { kind: 'user_model' },
  k: 5,
});
```

→ system prompt 의 `## What the user has told you before` heading 아래로 stitch. 새 storage 없음 — modeler 는 `fts_memories` 생산자.

---

## 5. TUI Upgrade & Interactive Splash

v4.x 의 single-hue figlet 32-cell box (`cli.mjs:1547` `_renderBanner`) 는 런타임을 *소개* 하지 않는다. v5.0 은 [ink](https://github.com/vadimdemedes/ink) 기반 **two-column 인터랙티브 splash** + 결정적 ASCII 파이프라인. REPL 은 Shift+Enter / Ctrl-R recall / mid-stream interrupt. legacy banner 는 `LAZYCLAW_NO_INK=1` 로 유지.

### 5.1 Two-column splash mockup

```
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                              │
│     ⣀⣠⣤⣶⣶⣦⣄⡀         Available Tools                                         │
│   ⢠⣾⠟⠉   ⠈⠙⢿⣦         ─────────────────────────────────────────────          │
│   ⣿⠁  ●     ●  ⣿        fs       read · write · edit · glob · grep            │
│   ⣿⡀   ⠈⠉⠉⠁   ⣿        exec     bash · spawn · kill                          │
│   ⠘⢿⣦⡀     ⢀⣴⡿⠃         net      fetch · http · ws                            │
│     ⠈⠙⠻⠷⠶⠶⠿⠟⠋           agents   task · monitor · cron · loop                 │
│        ⢸⠁  ⢸           data     sqlite · vault · session                     │
│        ⢸⠉  ⠉⠉⠉⠉         (sensitive) admin · keys · billing  (3 more)         │
│         lazyclaw                                                              │
│                          Available Skills                                     │
│                          ─────────────────────────────────────────────        │
│                          dev      review · debug · simplify                   │
│                          ops      deploy · rollback · scale                   │
│                          docs     init · changelog · readme                   │
│                          research deep · google · verify   (5 more)           │
│                                                                              │
│  provider · claude-cli · sonnet-4.7              cwd · ~/code/lazyclaw        │
│  trainer  · claude-cli · haiku-4.5  session 7af9                              │
│  slash    · /help · /model · /trainer · /skills · /tools · /exit              │
│  hint     · Shift+Enter newline · Ctrl-R recall · Esc interrupt               │
╰──────────────────────────────────────────────────────────────────────────────╯
```

마스코트 24-cell left gutter, 우측 column col 26 시작 col 78 wrap. footer 는 정확히 4 lines, body 와 blank row 1 개로 분리.

### 5.2 ASCII pipeline — `scripts/build-splash.mjs`

빌드 타임 사전 렌더링 — CLI runtime 은 chafa/ImageMagick 의존 없음. `assets/sloth.braille.json` 출력.

| Stage | Tool | Purpose |
|---|---|---|
| 1. Source | `assets/sloth-source.png` (1024×1024, CC0) | Generic Sleepy Sloth silhouette |
| 2. Tone curve | ImageMagick `convert -colorspace Gray -level 10%,90%` | Mezzotone preset |
| 3. Rasterise | `chafa --symbols=braille --size=24x10 --fg-only --threshold=0.55` | braille 은 모든 모노폰트에서 single-cell-wide |
| 4. ANSI strip | regex `/\x1b\[[0-9;]*m/g` | 런타임에 `#FFB347` 로 재색칠 |
| 5. Validate | `string-width` per row, assert `≤ 24` | gutter 초과 시 빌드 실패 |
| 6. Emit | `JSON.stringify({rows, width: 24, height: 10, fg: '#FFB347'})` | 부팅 시 1 회 로드 |

```bash
npm run build:splash
```

CI 가 `git diff --exit-code assets/` 로 PNG ↔ JSON sync 강제.

### 5.3 Mascot — Generic Sleepy Sloth

Three-toed sloth, 눈 감음, 로고/브랜딩 없음. CC0 silhouette (commit message 에 CC0 URL 인용 — license chain auditable). 단일 색 amber `#FFB347`.

`_renderMascot` 와 `_renderMascotTiny` (`cli.mjs:1525`, `cli.mjs:1529`) → real implementations. tiny variant 는 `/help` summary 와 daemon status panel 전용.

### 5.4 Tool category metadata

```js
// providers/tool_use/fs.mjs
export const meta = {
  name: 'fs',
  category: 'fs',
  sensitive: false,
  description: 'Filesystem read/write/edit/glob/grep',
};
export const verbs = ['read', 'write', 'edit', 'glob', 'grep'];
export async function invoke(verb, args, ctx) { /* ... */ }
```

Splash renderer 는 tool registry (`providers/tool_use/index.mjs`) 를 walk, `category` 기준 grouping, `verbs` 를 ` · ` 로 join. `sensitive: true` 는 `(sensitive) ...` row 로 dim.

### 5.5 Skill grouping — SKILL.md frontmatter

```yaml
---
name: code-review
description: Review the current diff for correctness...
group: dev           # optional; canonical fallback (C5): filename hyphen-prefix → 'legacy'
trainer: ...
---
```

**Canonical fallback (C5)** — `group:` 미지정 시 filename 의 first hyphen prefix 사용. 하이픈 없으면 `legacy` (not `misc`). v5 신규 skill 은 frontmatter 명시 권장.

### 5.6 Truncation rules

| Element | Limit | Overflow |
|---|---|---|
| Verbs per tool row | 6 | `verb1 · ... · verb6 (N more)` |
| Tool rows | 8 | 8th row → `... and N more tool groups` |
| Skill rows | 8 | 8th row → `... and N more skill groups` |
| Category label width | 8 cells | `…` truncate, right-pad |
| Right-column width | 52 cells | `string-width` truncation |

`(N more)` 토큰은 dim. `/tools` / `/skills` 가 full set page.

### 5.7 Footer — four lines, fixed

The footer is **fixed 4 lines, same order, every render**:

```
  provider · <name> · <model>                      cwd · <short-cwd>
  trainer  · <name> · <model>  session <id8>
  slash    · /help · /model · /trainer · /skills · /tools · /exit
  hint     · Shift+Enter newline · Ctrl-R recall · Esc interrupt
```

- Line 1 — chat provider + cwd (home-shortened).
- Line 2 — trainer provider + session id. `trainer === provider` 일 때도 line 은 그대로 렌더 (transparency).
- Line 3 — top 6 slash commands. `/trainer` 는 v5.0 신규.
- Line 4 — REPL key hints. legacy bindings (Ctrl-C, Tab) 은 `/help` 에서.

Footer 는 `/status` 와 daemon `GET /v1/state` 의 single source of truth.

### 5.8 REPL upgrades

**Shift+Enter multiline** — kitty `\x1b[13;2u` + legacy `\x1bOM` 지원. unsupported terminal 에서는 v4 의 `\` prefix fallback.

**Ctrl-R recall jump** — session 의 이전 prompts (`sessions.mjs`) 대상 inline fuzzy picker. row 선택 → input buffer 로 드롭 (즉시 resubmit 아님, shell `Ctrl-R` semantics).

**Esc mid-stream interrupt** — streaming response 중 abort (`AbortSignal`, providers 이미 지원). partial assistant output 을 quoted block 으로 input 에 prepend.

### 5.9 ink dependency & opt-out

ink 는 regular `dependencies` (not optional). 패키지 ~30 KB gzipped, major bump 의 일부.

Opt-out:
- `LAZYCLAW_NO_INK=1` — v4 figlet + plain readline. CI 사용.
- `--no-splash` — splash skip (REPL 은 ink 유지).
- `process.stdout.isTTY === false` → splash 자동 suppress, footer 4 lines 만 출력 (v4 piped invocation 호환).

### 5.10 Width safety

```js
import stringWidth from 'string-width';

function fitRow(text, maxCols) {
  if (stringWidth(text) <= maxCols) return text.padEnd(maxCols);
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stringWidth(text.slice(0, mid) + '…') <= maxCols) lo = mid;
    else hi = mid - 1;
  }
  return (text.slice(0, lo) + '…').padEnd(maxCols);
}
```

- Braille frame 은 every terminal 에서 single-cell-wide (iTerm2, Alacritty, Kitty, Windows Terminal, GNOME Terminal, tmux).
- Target 80 cols. < 72 cols → right column 1 line per group. < 60 cols → v4 figlet fallback + hint.
- Ellipsis: U+2026 (`…`, width 1), never `...` (width 3).

---

## 6. Sandbox 6-Backend

### 6.1 Why this exists

v4 의 단일 Docker wrapper (`sandbox.mjs:38-128`) 의 한계 3 가지:

1. **CLI orchestrator** (`providers/orchestrator.mjs:156`) 가 multiple workers 로 fan-out — v4 는 per-worker 격리 knob 없음.
2. **Trainer provider** (§2) 가 별도 execution surface 필요할 수 있음.
3. **Serverless** (Modal, Daytona) 의 per-second billing 과 idle-hibernation 이 daemon 의 first-class concern.

v5 는 `sandbox.mjs` 를 `sandbox/` 폴더로 — 각 backend 1 파일 1 인터페이스. Docker port 는 line-for-line equivalent.

### 6.2 Common interface

```typescript
interface Sandbox {
  name: 'local' | 'docker' | 'ssh' | 'singularity' | 'modal' | 'daytona';
  init(cfg: SandboxConfig): Promise<SandboxSession>;
  isPty(): boolean;
  supportsServerless(): boolean;
}

interface SandboxSession {
  exec(cmd: string[], opts?: ExecOpts): AsyncIterable<{stdout?: Buffer, stderr?: Buffer, exitCode?: number}>;
  putFile(local: string, remote: string): Promise<void>;
  getFile(remote: string, local: string): Promise<void>;
  spawnPty(cmd: string, args: string[], opts?: PtyOpts): PtyHandle;
  kill(): Promise<void>;
}
```

3 가지 의도적 선택:
- `exec` 은 async iterable (모든 `providers/*` 가 이미 stream 소비).
- `putFile` / `getFile` 명시화 — `-v $PWD:$PWD` bind-mount 가 remote backend 에서 불가.
- `spawnPty` 분리 — PTY semantics (raw mode, SIGWINCH, `isatty()`) 가 streaming `exec` 채널로 lossy.

### 6.3 Per-backend files

```
sandbox/
  index.mjs           # registry + resolveBackend(name) + idleSweeper hook
  util.mjs            # collect(), retry(), redact() shared helpers
  local.mjs           # bare child_process.spawn + OS confiner (seatbelt/bwrap/firejail/landlock)
  docker.mjs          # 1:1 port of v4 sandbox.mjs:38-128
  ssh.mjs             # node-ssh + OpenSSH ControlMaster
  singularity.mjs     # apptainer/singularity exec wrap
  modal.mjs           # modal CLI bootstrap + Modal HTTP API
  daytona.mjs         # daytona CLI wrap, workspaces as sessions
```

| Backend | `isPty()` | `supportsServerless()` | Auth | Notes |
|---|---|---|---|---|
| `local` | yes | no | n/a | v5 default. `local.confiner` 로 OS-native confinement 옵션 (C8 해소). |
| `docker` | yes (`-it`) | no | host docker daemon | Port of v4. `--sandbox docker:<image>` 호환. |
| `ssh` | yes (`-tt`) | no | `~/.ssh/config` + `node-ssh` | ControlMaster multiplex. |
| `singularity` | yes | no | local apptainer binary | HPC/login-node. |
| `modal` | no (exec-only) | **yes** | `modal token set` | Functions on demand. |
| `daytona` | yes | **yes** | `daytona auth login` | Workspace = long-lived session. |

**`local.confiner` (C8 해소)** — `local` backend 의 sub-option. 별도 backend 가 아니라 OS-specific confinement 메커니즘 선택:

```jsonc
"local": {
  "confiner": "auto"   // auto | none | seatbelt (mac) | bubblewrap (linux) | firejail (linux) | landlock (linux 5.13+)
}
```

`auto` resolution: macOS → seatbelt, Linux 5.13+ → landlock, Linux else → bubblewrap → firejail, else → none + warning.

### 6.4 Config schema

```jsonc
{
  "sandbox": {
    "default": "local",
    "backends": {
      "local":   { "confiner": "auto" },
      "docker":  { "image": "node:20", "network": "none", "mounts": [], "env": [] },
      "ssh":     { "host": "build-box", "user": "ci",
                   "controlPath": "~/.ssh/cm-%r@%h:%p" },
      "singularity": { "sif": "/opt/images/agent.sif", "binds": ["/scratch"] },
      "modal":   { "app": "lazyclaw-trainer", "image": "modal-python-3.11",
                   "idleSeconds": 1800 },
      "daytona": { "workspace": "lazyclaw-v5", "idleSeconds": 1800 }
    },
    "bindings": {
      "chat":    "local",
      "trainer": "modal",
      "skills":  "docker"
    }
  }
}
```

Resolution order:
1. `--sandbox <name>` CLI flag.
2. `cfg.orchestrator.workers[i].sandbox`.
3. `cfg.sandbox.bindings[<role>]`.
4. `cfg.sandbox.default`.
5. Implicit `local`.

v4 `parseSandboxSpec` form (`docker:<image>`) 은 한 minor cycle 유지.

### 6.5 CLI surface

```
lazyclaw sandbox list                  # printed table + reachability
lazyclaw sandbox test <name>           # echo + 1MB roundtrip latency
lazyclaw sandbox add <name> <kind>     # interactive
lazyclaw sandbox use <name> [--role]   # set binding
lazyclaw sandbox rm <name>             # refuses if bound
```

### 6.6 Serverless idle hibernation

```js
// daemon.mjs — new idleLoop, scheduled every 60s
async function idleSweep(now) {
  for (const [key, sess] of sandboxSessions) {
    const backend = sandboxes.get(sess.backendName);
    if (!backend.supportsServerless()) continue;
    if (now - sess.lastUsed < sess.idleMs) continue;
    await sess.kill();
    sandboxSessions.set(key, { backendName: sess.backendName, idleMs: sess.idleMs, hibernated: true });
  }
}
```

`init()` 는 idempotent + cheap-to-replay (conformance test 강제). `local`/`docker`/`ssh`/`singularity` 는 sweep 대상 아님.

### 6.7 CLI-orchestrator binding example

```jsonc
{
  "orchestrator": {
    "planner": "claude-cli",
    "workers": [
      { "provider": "claude-cli", "sandbox": "docker" },
      { "provider": "codex-cli",  "sandbox": "ssh" },
      { "provider": "gemini-cli", "sandbox": "modal" }
    ],
    "maxSubtasks": 5
  }
}
```

```js
// providers/orchestrator.mjs (revised)
for (const w of workers) {
  const backend = sandboxes.resolve(w.sandbox || cfg.sandbox.bindings.chat);
  const session = await backend.init(cfg.sandbox.backends[backend.name]);
  yield* runWorkerInSession(w, session, subtask);
}
```

핵심: **CLI orchestrator + 6 backends → 진정한 분산 worker pool**.

### 6.8 Security: PTY hijacking on PTC paths

PTY-capable backends 의 새 class: **Prompt-Through-Cursor (PTC)** hijack — malicious tool output 의 terminal control sequence (OSC 52 clipboard, DECRQSS, cursor-position) 가 worker PTY 를 통해 host stdin 으로 relay 되어 daemon 이 new prompt 로 parse.

Mitigations (`sandbox/util.mjs` 에서 uniform 적용):

1. **Capability gating** — `spawnPty()` 는 `isPty() === false` 일 때 attach 거부.
2. **CSI strip on inbound** — PTY stdout 의 OSC 52, OSC 8, DCS, DECRQSS 제거. `--allow-terminal-escapes` 로 opt-back-in.
3. **No re-injection of stdout into stdin** — `mas/agent_turn.mjs` 의 reflection loop 는 PTY stdout 을 follow-up prompt 로 못 씀.
4. **Per-session pty pair** — forkpty fresh, master fd 공유 금지.
5. **Audit hook** — `mas/audit.mjs` 로 `{backend, cwd, cmd, pid}` 기록.

### 6.9 Migration & compatibility

| v4 surface | v5 behavior |
|---|---|
| `--sandbox docker:<image>` | legacy shim, ad-hoc binding |
| `--sandbox-network`/`--sandbox-mount`/`--sandbox-env` | `docker` 그대로, 다른 backend 는 warning |
| `parseSandboxSpec` / `buildDockerArgs` / `spawnSandboxed` exports | `sandbox/index.mjs` 에서 re-export 1 minor cycle, v5.2 삭제 |
| `--sandbox only wraps subprocess providers` warning (`cli.mjs:1358`) | role=chat + provider=API-only 일 때만 |

v5 installer 가 `lazyclaw sandbox migrate` 실행 → v4 docker flag 발견 시 `bindings.chat = "docker"`, `config.v4.json` 백업.

---

## 7. Tool Ecosystem & MCP Integration

### 7.1 Tool metadata schema

```js
// mas/tools/example.mjs
import { z } from 'zod';

export default {
  name: 'example',
  category: 'coding',
  sensitive: false,
  description: 'One-line summary visible to the LLM.',
  args: z.object({
    path: z.string(),
    limit: z.number().int().positive().optional(),
  }),
  run: async (args, ctx) => {
    // ctx: { cwd, configDir, agent, taskId, traj, redact, abortSignal }
  },
};
```

`args` Zod schema → `zod-to-json-schema` 로 provider JSON Schema 도출. `ctx.redact` = bound `redactSecrets` (`mas/redact.mjs:18`). `ctx.traj` = trajectory writer.

Loader (`mas/tools/index.mjs`) 는 `*.mjs` glob-import, legacy export normalise, meta-schema validate. 검증 실패 = hard daemon-start error.

### 7.2 First-party tool catalogue

45 tools across 13 categories. **v5.0 GA scope** 는 sentinel 마크:

- `[v5.0]` 출시 포함
- `[v5.1+]` v5.0 catalogue 에 메타데이터만, 구현은 deferred

| # | Name | Category | Sens. | Status | Signature | Notes |
|---|---|---|---|---|---|---|
| 1 | `bash` | bash | ✓ | v5.0 | `{command, timeoutMs?}` | v4.3 carry-over |
| 2 | `bash_pty` | bash | ✓ | v5.0 | `{command, rows?, cols?}` | node-pty, asciinema cast |
| 3 | `read` | coding | – | v5.0 | `{path, offset?, limit?}` | v4.3 carry-over |
| 4 | `write` | coding | ✓ | v5.0 | `{path, content}` | v4.3 carry-over |
| 5 | `edit` | coding | ✓ | v5.0 | `{path, old_string, new_string, replace_all?}` | exact-string replace |
| 6 | `grep` | coding | – | v5.0 | `{pattern, path?, type?, glob?, n?}` | ripgrep |
| 7 | `glob` | coding | – | v5.0 | `{pattern, path?}` | mtime-sorted |
| 8 | `ls` | coding | – | v5.0 | `{path}` | structured |
| 9 | `recall` | recall | – | v5.0 | `{query, k?, kind?, scope?}` | §4 |
| 10 | `recall_pin` | recall | ✓ | v5.0 | `{text, kind, ttl?}` | mutates long-term |
| 11 | `recall_forget` | recall | ✓ | v5.0 | `{id}` | tombstone |
| 12 | `skill_view` | recall | – | v5.0 | `{name}` | v4.3 carry-over |
| 13 | `skill_install` | recall | ✓ | v5.0 | `{source, name?}` | agentskills.io or git |
| 14 | `web_search` | web | – | v5.0 | `{query, k?}` | pluggable backend |
| 15 | `web_fetch` | web | – | v5.0 | `{url, max_bytes?}` | Readability, 1 MB cap |
| 16 | `web_browse` | browser | ✓ | v5.0 | `{url, action, selector?, text?}` | Playwright |
| 17 | `osa` | os | ✓ | v5.0 | `{script, lang?}` | macOS Osascript |
| 18 | `clipboard_read` | os | – | v5.0 | `{}` | clipboardy |
| 19 | `clipboard_write` | os | ✓ | v5.0 | `{text}` | |
| 20 | `notify` | os | – | v5.0 | `{title, body, urgency?}` | native toast |
| 21 | `git_status` | git | – | v5.0 | `{cwd?}` | porcelain v2 |
| 22 | `git_diff` | git | – | v5.0 | `{ref?, path?}` | |
| 23 | `git_log` | git | – | v5.0 | `{n?, path?}` | |
| 24 | `git_commit` | git | ✓ | v5.0 | `{message, paths?}` | global CLAUDE.md §4.2 준수 |
| 25 | `git_push` | git | ✓ | v5.0 | `{remote?, branch?}` | no force unless `force:true` |
| 26 | `gh_pr_create` | git | ✓ | v5.0 | `{title, body, base?, draft?}` | `gh` CLI |
| 27 | `gh_pr_review` | git | ✓ | v5.0 | `{number, body, event}` | |
| 28 | `schedule_cron` | scheduling | ✓ | v5.0 | `{spec, command, id?}` | `cron.mjs` |
| 29 | `schedule_at` | scheduling | ✓ | v5.0 | `{at, command, id?}` | one-shot |
| 30 | `schedule_list` | scheduling | – | v5.0 | `{}` | |
| 31 | `schedule_cancel` | scheduling | ✓ | v5.0 | `{id}` | |
| 32 | `delegate` | delegation | ✓ | v5.0 | `{agent, prompt, timeoutMs?}` | `agents.mjs` |
| 33 | `delegate_async` | delegation | ✓ | v5.0 | `{agent, prompt}` | returns task_id |
| 34 | `task_wait` | delegation | – | v5.0 | `{task_id, timeoutMs?}` | |
| 35 | `team_post` | delegation | – | v5.0 | `{team, message}` | `teams.mjs` |
| 36 | `image_view` | media | – | v5.0 | `{path}` | vision content block |
| 37 | `image_describe` | media | – | v5.0 | `{path, prompt?}` | vision-LLM caption |
| 38 | `audio_transcribe` | media | ✓ | v5.0 | `{path}` | Whisper / trainer STT |
| 39 | `ha_state` | HA | – | **v5.1+** | `{entity_id}` | Home Assistant; metadata only in v5.0 |
| 40 | `ha_call` | HA | ✓ | **v5.1+** | `{domain, service, data?}` | Home Assistant; deferred |
| 41 | `clarify` | clarify | – | v5.0 | `{question, options?}` | mention router → mobile bridge |
| 42 | `confirm` | clarify | – | v5.0 | `{summary}` | bool |
| 43 | `slack_post` | web | ✓ | v5.0 | `{channel, text, thread_ts?}` | `channels/slack.mjs` |
| 44 | `playwright_record` | browser | ✓ | **v5.1+** | `{url, scenario}` | session recorder; deferred |
| 45 | `mcp` | mcp | varies | v5.0 | `{server, tool, args}` | ad-hoc MCP |
| 46 | `mcp_resource_read` | mcp | – | v5.0 | `{server, uri}` | |
| 47 | `mcp_prompt_get` | mcp | – | v5.0 | `{server, name, args}` | |

`SENSITIVE_TOOLS` (`mas/tool_runner.mjs:63`) → registry load 시점 derive. Hook signature (`mas/tool_runner.mjs:91-100`) 무변경.

### 7.3 Toolset groups

```json
{
  "name": "code-monkey",
  "extends": ["base"],
  "include": ["read","write","edit","grep","glob","ls","bash","git_*"],
  "exclude": ["bash_pty"]
}
```

`git_*` 는 registry 에서 expand. cycles 거부. 구현: `mas/toolsets.mjs` (new).

```
lazyclaw toolset list
lazyclaw toolset show <name>
lazyclaw toolset add <name> --include <glob>... [--exclude <glob>...] [--extends <base>]
lazyclaw toolset remove <name>
lazyclaw agent edit <agent> --toolset <name>
```

Built-in toolsets in `dist-lazyclaw/`:

| Name | Tools | Use case |
|---|---|---|
| `read-only` | recall + coding (no write/edit) + web + ls + git_status/diff/log | Audit agents |
| `coder` | coding + git + bash | v4-style code agents |
| `desktop` | os + clarify + notify + clipboard_* + osa | macOS daily-driver |
| `home` | scheduling + clarify (HA tools v5.1+) | Home automation (limited in v5.0) |
| `media` | media + web | Captioning/transcription |
| `mobile-bridge` | clarify + recall + slack_post + team_post | Telegram/Matrix bridges |
| `full` | everything | Power users |

Agent records 에 `toolset?: string` field. 미지정 시 v4 raw `tools: [...]` 유지.

### 7.4 MCP integration (client only)

v5.0 = **MCP client**, not server. `@modelcontextprotocol/sdk` first-class.

```json
{
  "mcp": {
    "enabled": true,
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        "env": { "READONLY": "1" },
        "sandbox": true
      },
      "git": { "command": "uvx", "args": ["mcp-server-git"] },
      "atlassian": {
        "url": "https://mcp.atlassian.com/v1/sse",
        "transport": "sse",
        "headers": { "Authorization": "Bearer ${ATLASSIAN_MCP_TOKEN}" }
      }
    },
    "tools_allowlist": ["mcp:filesystem:*", "mcp:git:status", "mcp:git:diff", "mcp:atlassian:search*"],
    "sensitive_overrides": {
      "mcp:filesystem:write_file": true,
      "mcp:git:commit": true
    }
  }
}
```

Transports: **stdio-spawn** + **SSE/HTTP**. `mas/mcp_client.mjs` 가 uniform `Client` wrapper.

Daemon startup flow:
1. `mcp.servers.*` 순회. `command` entry → `sandbox.mjs` constraints (when `sandbox: true`). `url` entry → SSE 연결.
2. `tools/list` 호출, `tools_allowlist` glob 매칭.
3. v5.0 tool-metadata 형태로 wrap:
   - `name = mcp:<server>:<tool>`
   - `category = 'mcp'`
   - `sensitive` = `sensitive_overrides[name]` ?? heuristic (write/post/create/delete/exec/run → true)
   - `args` = `zod-from-json-schema(remote.inputSchema)`
   - `run` = `(args, ctx) => client.callTool({name, arguments: args, _meta: {taskId: ctx.taskId}})`
4. Global tool registry 등록 (동일 approval gate + audit).
5. 30s health-check; disconnect → `unavailable` mark + exponential backoff retry.

Per-agent whitelist: `mcp:git:*`, `mcp:*:read*` 등 globs.

Sandboxed MCP servers: `server.sandbox: true` → spawn 이 `sandbox.mjs` 통과. SSE 는 sandbox 불가 (remote), 토큰 env-interpolated.

Tool result redaction: `mas/mcp_client.mjs` 의 `callTool` wrapper 에서 `redactSecrets` 강제. Server bypass 불가.

### 7.5 Sensitive-tool gate (unchanged)

v4.3 approve hook 그대로. v5.0 변경:
- `SENSITIVE_TOOLS` 가 registry 의 `sensitive: true` derive
- MCP tools 는 `sensitive_overrides` + heuristic
- Hook callback 에 optional `category` field 추가

Exec-approval producers (SSE stream, Matrix/Telegram bridges, generic webhook) **zero changes**.

### 7.6 Secret redaction (mandatory)

`mas/redact.mjs:18 redactSecrets` 적용 3 지점:
1. Tool result → trajectory (`mas/tool_runner.mjs`)
2. MCP server response → caller (`mas/mcp_client.mjs::callTool`)
3. Channel outbound (v4.3 무변경)

Opt-out: `ctx.redact.skip()` — audited.

### 7.7 Trajectory capture for tool calls

```js
const ToolCallRecord = z.object({
  ts: z.number(),
  taskId: z.string(),
  agent: z.string(),
  tool: z.string(),
  category: z.string(),
  sensitive: z.boolean(),
  args: z.unknown(),
  approval: z.object({
    required: z.boolean(),
    approved: z.boolean().optional(),
    by: z.string().optional(),
    latencyMs: z.number().optional(),
  }),
  result: z.object({
    ok: z.boolean(),
    code: z.string().optional(),
    bytes: z.number().optional(),
    truncated: z.boolean().optional(),
    preview: z.string().optional(),
  }),
  durationMs: z.number(),
  mcpServer: z.string().optional(),
});
```

Reflector (§3) 는 `trajectory.stream({category, sensitive, since})` 로 소비 — 카테고리별 학습.

### 7.8 Deferred to v5.1

- Tool result **streaming** (현재 buffer)
- Per-tool **$ cost accounting**
- Cross-agent tool **aliasing** (`tools: { read: 'mcp:filesystem:read_file' }`)
- **HA tools** (#39, #40)
- **playwright_record** (#44)

---

## 8. Channel Expansion & Plugin System

### 8.1 Motivation

v4.3 의 4 in-tree 채널 (HTTP, Slack, Telegram, Matrix) + `StubChannel` 에 Discord/WhatsApp/Signal/email/voice 를 in-tree 로 추가 시 install size 200 MB 초과, 무관한 release cadence coupling. v5.0 은 **core** (in-tree) + **plugin** (`@lazyclaw/channel-*`) split.

### 8.2 Core vs plugin split

| Channel | Package | Reason |
|---|---|---|
| `http` | `lazyclaw` (core) | SSE/dashboard/gateway 필수 |
| `slack` | `lazyclaw` (core) | 465 LOC, no native deps |
| `telegram` | `lazyclaw` (core) | fetch over long-poll/webhook |
| `matrix` | `lazyclaw` (core) | Olm crypto optional |
| `stub` | `lazyclaw` (core) | test harness |
| `discord` | `@lazyclaw/channel-discord` | discord.js v15 (~30 MB) |
| `whatsapp` | `@lazyclaw/channel-whatsapp` | Puppeteer/Chromium (~250 MB) |
| `signal` | `@lazyclaw/channel-signal` | external `signal-cli` JVM |
| `email` | `@lazyclaw/channel-email` | `node-imap` + `nodemailer` |
| `voice` | `@lazyclaw/channel-voice` | Whisper + (TTS in v5.1+) |

### 8.3 Plugin loader CLI

```bash
lazyclaw channels list
lazyclaw channels install discord
lazyclaw channels install whatsapp@^1.2.0
lazyclaw channels remove signal
lazyclaw channels doctor
```

`$LAZYCLAW_HOME/plugins/node_modules` (default `~/.lazyclaw/plugins`) 격리.

```json
{
  "name": "@lazyclaw/channel-discord",
  "lazyclaw": {
    "kind": "channel",
    "id": "discord",
    "entry": "./dist/index.mjs",
    "exports": "DiscordChannel",
    "minCore": "5.0.0",
    "nativeDeps": ["zlib-sync?"],
    "secretsRequired": ["DISCORD_BOT_TOKEN"]
  },
  "peerDependencies": { "lazyclaw": "^5.0.0" }
}
```

Daemon startup: plugin dir scan, `minCore` validate, dynamic import. 실패 = warning + skip (non-fatal).

### 8.4 Retained interface — `channels/base.mjs`

```js
// channels/base.mjs:13 (unchanged in v5.0)
export class Channel {
  async start(handler, { gate } = {}) { /* ... */ }
  async send(threadId, text)          { /* ... */ }
  async stop()                        { /* ... */ }
  async _processInbound({ threadId, text, gateInput }) { /* ... */ }
}
```

Plugin 은 MUST call `super._processInbound`. 강제 contract test in `lazyclaw channels doctor`.

### 8.5 Cross-channel continuity

**`$LAZYCLAW_HOME/threads.jsonl`** — append-only:

```jsonl
{"threadId":"slack:C0123:T999","channel":"slack","externalId":"C0123/T999","sessionId":"s_8f3a","lastTurnAt":"2026-06-04T08:12:03Z"}
{"threadId":"tg:498123","channel":"telegram","externalId":"498123","sessionId":"s_8f3a","lastTurnAt":"2026-06-04T08:14:11Z"}
```

Session record `channels[]`:

```js
{
  id: 's_8f3a',
  createdAt: '2026-06-04T07:00:00Z',
  channels: [
    { channel: 'slack',    externalId: 'C0123/T999',    joinedAt: '...' },
    { channel: 'telegram', externalId: '498123',        joinedAt: '...' },
    { channel: 'email',    externalId: '<abc@example>', joinedAt: '...' },
  ],
}
```

Daemon inbound bridge (`daemon.mjs:1542`) 가 normalise 후 lookup → existing sessionId? attach : spawn.

**`/handoff` slash command**:

```
/handoff telegram:498123     # bind current session to telegram chat
/handoff email:ops@team.dev  # bind email thread
/handoff list                # show channels[]
/handoff drop slack          # detach
```

기본 reply 정책: 인바운드 채널로만 응답. 모델이 `tool.respond_on(channel)` 호출 시 override.

### 8.6 Voice channel flow (transcribe only in v5.0)

`@lazyclaw/channel-voice` 는 v5.0 에서 **transcribe-only**. TTS reply 는 v5.1+ (deferred).

```
[1] inbound voice memo (Telegram voice / Slack file / raw audio webhook)
        ▼
[2] download to $LAZYCLAW_HOME/voice/in/<uuid>.<ext>
        ▼
[3] transcribe via `audio_transcribe` tool
        ├─ local:  whisper.cpp (whisper-node)
        └─ remote: OpenAI Whisper / Groq Whisper-large-v3
        ▼
[4] text turn handed to daemon as { channel: 'voice', threadId, text }
        ▼
[5] daemon resolves reply (model output)
        ▼
[6] reply sent as TEXT on originating transport (TTS deferred to v5.1+)
```

v5.0 config:

```jsonc
{
  "channels": {
    "voice": {
      "transcribe": { "engine": "whisper-local", "model": "small.en" },
      "audioTtlH":  24
    }
  }
}
```

raw audio files in `voice/in/` 는 24h TTL, `threads.jsonl` 에 들어가지 않음.

### 8.7 Security — plugins are not a trust escape

Plugins run **in-process** (no sandbox). 3 non-bypassable controls:

1. **Pairing allowlist** — `gateway/device_auth.mjs` 의 device-auth gate 통해서만 inbound. plugin loader 는 `gate` 없는 `start()` 를 거부.
2. **Redact pipeline** — daemon 이 registered handler 를 redaction adapter 로 wrap.
3. **Capability manifest** — `secretsRequired` 만 env 접근. loader 가 scoped getter (`ctx.secret('DISCORD_BOT_TOKEN')`) 제공, 미등록 키 거부.

Native deps 명시적 consent:

```
$ lazyclaw channels install whatsapp
Installing @lazyclaw/channel-whatsapp@1.2.0
  Native deps: puppeteer (downloads Chromium ~280MB)
  Secrets required: WHATSAPP_SESSION_PATH
Proceed? [y/N]
```

`--yes` 로 skip 가능, 기본은 묻기.

### 8.8 Migration from v4.3

- v4 config 키 (`slack.botToken` 등) 그대로
- 플러그인 전용 채널 참조 시 install command 출력 + non-zero exit
- `threads.jsonl` 은 empty 로 생성, 첫 inbound 시 record 추가 (idempotent)

---

## 9. Persona System

### 9.1 personalities/&lt;name&gt;.md schema

Personalities live under **`<configDir>/personalities/<name>.md`** (default `~/.lazyclaw/personalities/`). 단일 Markdown + YAML frontmatter. **모든 imported persona (Hermes/OpenClaw skin 포함) 도 이 디렉터리로 land** (C7).

```markdown
---
name: pirate
version: 1
display: "Captain Salt"
description: "Cheerful pirate captain. Loves rum, hates scurvy."
tone: ["playful", "nautical"]
languages: ["en", "ko"]
tokens: 420
inherits: null
tags: ["fun", "demo"]
hermes_origin: null
checksum: "sha256:..."
---

You are Captain Salt, a cheerful pirate captain. Speak in nautical idioms but
stay technically precise. Never invent commands. When unsure, say "shiver me
timbers, I don't know" and ask.
```

| Field | Required | Notes |
|---|---|---|
| `name` | ✓ | matches filename stem, `^[a-z0-9][a-z0-9_-]{0,31}$` |
| `version` | ✓ | integer |
| `display` | – | defaults to `name` |
| `description` | ✓ | one line |
| `tokens` | – | advisory body budget; default 800 |
| `inherits` | – | transitive, cycle-detected, max depth 3 |
| `hermes_origin` | – | preserved for round-trip |

Unknown frontmatter keys → warning, not failure (forward-compat). Schema in `personalities/schema.mjs` + `loadPersonality(name, cfgDir)` helper.

### 9.2 SOUL.md and USER.md

| File | Path | Author | Purpose |
|---|---|---|---|
| **SOUL.md** | `~/.lazyclaw/SOUL.md` | **user-authored, read-only at runtime** | lazyclaw's identity as user wants it (voice, values, hard constraints). Prepended to every chat unless `--no-soul`. |
| **USER.md** | `~/.lazyclaw/memory/USER.md` (C6) | **curator-written, user-editable** | lazyclaw's view of user (preferences, projects, things user asked to remember). Persistent counterpart to per-session memory. |

비대칭: SOUL.md = top-down (user → lazyclaw), USER.md = bottom-up (lazyclaw curator → file, user 가 편집 가능).

Workspace `SOUL.md` (existing convention, `cli.mjs:1181`) 는 **layer 1.5** 로 명시 (C10) — global SOUL 직후 stack.

### 9.3 The 7-layer compose stack (with workspace SOUL as 1.5)

모든 system prompt = 최대 8 layer concatenation (workspace SOUL 포함):

| # | Layer | Source | Required | Owner |
|---|---|---|---|---|
| 1 | SOUL.md (global) | `~/.lazyclaw/SOUL.md` | if exists | `persona/compose.mjs` |
| 1.5 | SOUL.md (workspace) | `<workspace>/SOUL.md` (when `--workspace` set) | if exists | `persona/compose.mjs` |
| 2 | /personality body | `personalities/<active>.md` | if active | `persona/compose.mjs` |
| 3 | agent.role | MAS `agents/<name>.json` | MAS context | `agents.mjs` |
| 4 | USER.md excerpt | `~/.lazyclaw/memory/USER.md` (top-K) | if exists | `persona/user_excerpt.mjs` |
| 5 | skill index | `skills/index.json` recall menu | if enabled | `skills.mjs` |
| 6 | memory excerpt | session + long-term (top-K) | if non-empty | `memory.mjs` |
| 7 | trajectory context | in-progress task/step | when resuming | `tasks.mjs` |

Layers separated by `\n\n---\n\n` (matching `cli.mjs:1310`). 각 layer 는 HTML comment marker (`<!-- layer:soul -->`, `<!-- layer:soul-workspace -->`, `<!-- layer:personality -->`, ...) 로 wrap, daemon 이 logging 시 strip 하되 turn record 에 layer-byte breakdown 기록.

**Per-layer pipeline**:

```
raw text  →  redactSecrets()  →  truncateToBudget(layerBudget)  →  emit
```

`redactSecrets` 는 `mas/redact.mjs:18` 재사용. `truncateToBudget` 는 `persona/budget.mjs` (new) 의 sentence-boundary truncation + `[...truncated N tokens]` tail.

**Token budgeting** — `total_budget = provider.context_window * config.persona.budget_fraction` (default 0.30). Share allocation (rough — `docs/v5/PERSONA_BUDGETS.md` 에서 측정 후 튜닝):

| Layer | Share |
|---|---|
| 1 + 1.5 (SOUL) | 25% |
| 2 (personality) | 20% |
| 3 (agent.role) | 10% |
| 4 (USER) | 15% |
| 5 (skill index) | 10% |
| 6 (memory) | 15% |
| 7 (trajectory) | 5% — **never truncated** |

Layer 7 가 budget 초과 시 4/6 를 더 tight 하게 재truncate (resumption critical).

### 9.4 CLI commands

```
lazyclaw personality list
lazyclaw personality show <name>
lazyclaw personality install <path-or-url>
lazyclaw personality remove <name>
lazyclaw personality use <name>
lazyclaw personality use --clear
lazyclaw personality import-hermes <skin.yaml>     # → personalities/hermes-<slug>.md
lazyclaw personality import-openclaw <soul.md>     # → personalities/openclaw-<slug>.md
```

`install` 은 `checksum` verify, no overwrite without `--force`. Personalities **never execute** — pure prompt content. Commands register near `workspace` in dispatcher (`cli.mjs:1221`), share `--json` flag.

### 9.5 REPL slash commands

| Slash | Effect |
|---|---|
| `/personality` | print active + description |
| `/personality <name>` | switch for current session (not persistent unless `--persist`) |
| `/personality clear` | drop layer 2 for rest of session |
| `/personality list` | same as CLI list |

### 9.6 Agent-bound personality

```json
{
  "name": "scribe",
  "displayName": "Scribe",
  "role": "You take meeting notes and produce action-item summaries.",
  "personality": "formal-secretary",
  "provider": "claude-cli",
  "trainer": "claude-cli"
}
```

**Binding 메커니즘**: `mas/agents.mjs` 의 `loadAgent(name)` 가 `personality` field 를 resolve 하여 `agent.persona` 에 채움. 그 후 daemon 의 turn dispatcher 가 해당 agent 로 라우팅할 때 (`mas/mention_router.mjs`), compose stack 의 **layer 2** 를 글로벌 active 가 아니라 `agent.persona` 로 override.

Unknown personality → warning + no-personality fallback (절대 hard error 아님).

### 9.7 Importing Hermes skins

```bash
lazyclaw personality import-hermes <skin.yaml>
# writes to <configDir>/personalities/hermes-<slugified-name>.md  (C7)
```

| Hermes skin field | lazyclaw personality field |
|---|---|
| `voice` | body paragraph 1 |
| `style.tone` | frontmatter `tone[]` |
| `style.languages` | frontmatter `languages[]` |
| `examples[]` | body section `## Examples` |
| `refusals[]` | body section `## Refusals` |
| `name` | frontmatter `name` (slugified) |
| `version` | frontmatter `hermes_origin.version` |

원본 YAML 은 `hermes_origin:` frontmatter 에 보존 (round-trip 가능). 표현 불가 필드 (`tool_bias`, `sampling_overrides`) 는 stderr 에 lost-fields warning. **Offline only** — input must be local path.

---

## 10. Migration: v4 → v5, Hermes Import, OpenClaw Import

v5.0 = major bump. 4 마이그레이션 명령:

1. **`lazyclaw migrate`** — v4 `~/.lazyclaw` → v5 schema in-place upgrade
2. **`lazyclaw hermes import`** — `~/.hermes` overlay
3. **`lazyclaw openclaw import`** — `~/.openclaw` overlay
4. **`lazyclaw export --to hermes`** — bidirectional export

모두 `scripts/migrate-v5.mjs` 구현, `cli.mjs` top-level subcommands. dry-run summary + confirm prompt 전에 filesystem 미변경.

### 10.1 v4 → v5 (`lazyclaw migrate`)

#### 10.1.1 Pre-flight and backup

`~/.lazyclaw/` → `~/.lazyclaw.v4.backup/` via `fs.cp` (`recursive, preserveTimestamps`). 기존 backup 존재 시 `--force-backup` 없으면 거부, 있으면 ISO timestamp suffix 로 rename. skills symlink follow, `sessions/` 은 그대로 preserve.

#### 10.1.2 `config.json` rewrite

| v4 field | v5 result |
|---|---|
| `provider`, `model`, `api-key`, `apiKeys.*` | 그대로 |
| _(absent)_ | `trainer = { provider: <chat provider mirror>, model: <chat model mirror> }` |
| `sandbox: "docker"` (string) | `sandbox: { default: "docker", backends: { docker: { network: "none", mounts: [] } }, bindings: { chat: "docker" } }` |
| `sandbox: "off"` / missing | `sandbox: { default: "local", backends: { local: { confiner: "auto" } } }` |
| `mcp.*`, `channels.*`, `gateway.*` | 그대로 |
| _(absent)_ | `schemaVersion: 5` 상단 stamp |

Trainer default 가 chat provider mirror → day-zero 비용 v4 동일. 사용자는 `lazyclaw config set trainer.provider claude-cli` (C3 — kebab-case) 로 USP 옵트인.

#### 10.1.3 Skills frontmatter upgrade

v4 skills (`~/.lazyclaw/skills/*.md`, parser at `skills.mjs:62`). v5 추가 fields:

```yaml
---
name: pr-review
description: Review a pull request and post structured findings
group: legacy              # filename hyphen-prefix; no hyphen → 'legacy' (C5)
confidence: 0.5            # neutral prior
trained_by: legacy         # canonical enum (C4)
---
```

Migrator 동작:
1. `skills.mjs:62` parser 로 frontmatter 읽기
2. Filename hyphen-prefix → `group` (`pr-review.md` → `pr`); 없으면 `group: legacy`
3. `confidence: 0.5`
4. `trained_by: legacy`

Skill body 미변경. `skillsIndex()` 호환.

#### 10.1.4 Substrate-compatible artifacts

`sessions/`, `agents/`, `teams/`, `tasks/` 는 schema-compatible. malformed entries 는 `~/.lazyclaw/quarantine/<timestamp>/` 로 격리 (삭제 아님).

#### 10.1.5 FTS5 index rebuild

기존 `index.db` drop → v5 schema 재생성 → 모든 skill/memory/session entry 를 write-through path 통해 replay (single transaction). 500-skill / 2 GB session corpus → < 30s on 2024-class laptop. stderr 에 progress.

#### 10.1.6 Rollback

```bash
lazyclaw migrate rollback
```

`~/.lazyclaw.v4.backup/` 없으면 거부. 현재 `~/.lazyclaw/` → `~/.lazyclaw.v5.failed-<timestamp>/` (진단용 보존), backup → 복귀. 순수 file-level restore.

### 10.2 Hermes Agent import (`lazyclaw hermes import`)

Detection: `~/.hermes/` + `config.toml` or `skin.yaml`. **Read-only** on Hermes tree.

| Hermes artifact | Lazyclaw destination | Notes |
|---|---|---|
| `~/.hermes/skills/*.md` | `~/.lazyclaw/skills/hermes-imports/*.md` | `trained_by: hermes-import` (C4), `group: hermes-<original-dir>` |
| `~/.hermes/MEMORY.md` | merged into `~/.lazyclaw/memory/MEMORY.md` under `## Imported from Hermes (<date>)` | Idempotent — re-import refresh in place |
| `~/.hermes/USER.md` | merged into **`~/.lazyclaw/memory/USER.md`** (C6) | same way |
| `~/.hermes/channels/*.toml` | `config.json` 의 `channels.*` 로 매핑 | conflicts surface as prompts |
| `~/.hermes/skin.yaml` | **`<configDir>/personalities/hermes-<slug>.md`** (C7) | best-effort translation |

skill subdir 격리 → native lazyclaw skills 와 분리. `skills.mjs:34` 가 recursively scan 하므로 자동 노출.

Channel mapping 은 `channels/base.mjs` 인터페이스 그대로. Skin → personality 는 lossy + import report 에 명시.

### 10.3 OpenClaw import (`lazyclaw openclaw import`)

| OpenClaw | Lazyclaw |
|---|---|
| `~/.openclaw/SOUL.md` | overlay → `~/.lazyclaw/SOUL.md` (merge block) |
| `~/.openclaw/MEMORY.md` | merge block → `~/.lazyclaw/memory/MEMORY.md` |
| `~/.openclaw/USER.md` | merge block → **`~/.lazyclaw/memory/USER.md`** (C6) |
| `~/.openclaw/skills/*.md` | `~/.lazyclaw/skills/openclaw-imports/*.md` (`trained_by: openclaw-import`, C4) |
| `~/.openclaw/allowlist` | `config.json` 의 `tools.allowlist` deduped union |
| `~/.openclaw/messaging.<channel>` | `config.json` 의 `channels.<channel>` (empty slot 에만) |
| `~/.openclaw/skin.yaml` (if present) | `<configDir>/personalities/openclaw-<slug>.md` (C7) |

Conflict 동일 prompt-or-skip flow.

### 10.4 Bidirectional export (`lazyclaw export --to hermes`)

```
exports/hermes-2026-06-04T12-00Z/
  skin.yaml          # personality + curated skill metadata
  skills/
    *.md             # full skill bodies, frontmatter stripped of v5-only fields
```

기본: `confidence >= 0.6` 인 skill 만. `--all` override. v5-only frontmatter (`confidence`, `trained_by`, `cross_cli_tested`) 는 export 시 strip — Hermes 가 opaque metadata 로 취급해서 혼란 방지.

Exporter 가 Hermes install 을 직접 건드리지 않음 — 사용자가 dump 를 `~/.hermes/skills/` 로 복사. 비파괴 posture 유지.

### 10.5 Migration UX summary

| Command | Touches v4? | Touches v5? | Reversible? |
|---|---|---|---|
| `lazyclaw migrate` | reads + backs up | writes new tree | yes — `migrate rollback` |
| `lazyclaw migrate rollback` | restores | replaces | one-shot |
| `lazyclaw hermes import` | reads only | additive overlay | re-run idempotent |
| `lazyclaw openclaw import` | reads only | additive overlay | re-run idempotent |
| `lazyclaw export --to hermes` | n/a | reads only | n/a |

---

## 11. Implementation Phasing & Parallel Execution

v5.0 의 45+ parallel work units 를 8 phases (A–H) 로 — **dependency boundary** 기준. 각 phase 는 자체 `Workflow` (`workflow/executor.mjs:1`) — v5.0 를 ship 하는 에이전트 = v5.0 가 ship 하는 execution substrate.

Intermediate releases: **rc.1 = A+B+C+E**, **rc.2 = +D+F+G+H**, then GA.

### 11.1 Phase dependency graph

```
            ┌── A (foundation) ──┐
            │                    │
        ┌───▼───┐            ┌───▼───┐
        │   B   │            │   C   │
        │ learn │            │  UX   │
        └───┬───┘            └───┬───┘
            │                    │
            └────────┬───────────┘
                     │
              ┌──────▼──────┐
              │      E      │  ◄── needs B.recall, C.theme
              │  tools+MCP  │
              └──────┬──────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
    ┌───▼───┐    ┌───▼───┐    ┌───▼───┐
    │   D   │    │   F   │    │   G   │
    │sandbox│    │channels│   │persona│
    └───┬───┘    └───┬───┘    └───┬───┘
        │            │            │
        └────────────┼────────────┘
                     │
                 ┌───▼───┐
                 │   H   │  polish + GA
                 └───────┘
```

### 11.2 Phase A — Foundation (5 parallel units)

| # | Unit | Owner files | Notes |
|---|---|---|---|
| A1 | Trainer resolver | `providers/registry.mjs:1`, new `providers/trainer.mjs` | `provider` vs `trainer` split. `trainer.provider: "auto"` resolves: Claude Pro/Max session via `providers/claude_cli.mjs:1` → `claude-cli` (C3); else chat provider mirror (C9). |
| A2 | Config schema bump | `config-validate.mjs:1` | + `trainer`, `persona`, `mcp`, `toolsets`, `sandbox.bindings`. `schemaVersion: 5`. v4 auto-upgraded (additive). |
| A3 | sqlite init | new `learning/db.mjs` | `better-sqlite3` (prebuilt: darwin/linux/win64 × x64/arm64; musl/freebsd fallback docs, C11). WAL, journal_size_limit 64MB. Tables: `skills`, `user_traits`, `nudges`, `trajectories`, `anti_patterns`. |
| A4 | FTS5 trigger | same `learning/db.mjs` | `skills_fts` + `AFTER INSERT/UPDATE/DELETE` triggers. Drives B3. |
| A5 | Migration baseline | new `scripts/migrate-v5.mjs` | Snapshot v4 `~/.lazyclaw/` → `~/.lazyclaw/backups/v4-<ts>/`. Idempotent. |

**Acceptance** — `npm test -- foundation`: trainer resolver returns expected provider id for 6 env permutations; config schema rejects malformed `trainer`; sqlite WAL opens on temp dir; FTS5 round-trip; migrate-v5 dry-run reports zero data loss.

### 11.3 Phase B — Learning core (6 parallel units)

Depends only on A3/A4.

| # | Unit | Owner files | Notes |
|---|---|---|---|
| B1 | skill_synth v2 | `mas/skill_synth.mjs:1` | + `confidence`, `provenance`, `embedding_hash`. sqlite store. Signature 호환. |
| B2 | user_modeler | new `learning/user_modeler.mjs` | Distills traits. Writes `user_traits` rows. Daemon idle hook. |
| B3 | recall tool | new `providers/tools/recall.mjs` | First-class tool. Searches `skills_fts` + confidence filter. |
| B4 | Nudge loop (manual) | new `learning/nudge.mjs` | **v5.0 = manual via `lazyclaw orchestra nudge-sweep`**. Auto cron 는 v5.1+ (review note B4 scope). |
| B5 | Anti-pattern synth (manual) | new `learning/anti_patterns.mjs` | **v5.0 = manual via `lazyclaw orchestra anti-pattern-sweep`**. Auto trigger 는 v5.1+ (review note B5 scope). |
| B6 | Confidence calc | new `learning/confidence.mjs` | Bayesian update. Pure function. |

**Parallelisation note**: B6 먼저, B1 이 confidence 값 INSERT 가능. B3/B4 는 B1 output 읽기만, write 충돌 없음.

**Acceptance** — 50 canned trajectories replay → ≥20 distinct skills with confidence > 0.6, ≥5 anti-patterns, recall@5 ≥ 0.8 on 10-query holdout.

### 11.4 Phase C — UX (5 parallel units)

Independent of B.

| # | Unit | Owner files | Notes |
|---|---|---|---|
| C1 | Ink splash | new `cli/splash.mjs` | Sleepy Sloth via `chafa --symbols=braille` baked at build (no runtime chafa). Skip under `NO_COLOR`, `CI`, `--quiet`. |
| C2 | Multiline editor | new `cli/editor.mjs` | Replaces single-line readline. Shift+Enter newline, Enter submit, Esc clear. Fallback to readline if TTY caps missing. |
| C3 | Interrupt-and-redirect | `cli.mjs:1` + `daemon.mjs:1` | Ctrl+C once → system message inject ("user wants to redirect: ..."). Twice → hard cancel. |
| C4 | Ghost autocomplete migrate | `cli.mjs:1` | Move out of 312KB `cli.mjs` into `cli/ghost.mjs`. Pure refactor. |
| C5 | Color theme | new `cli/theme.mjs` | `#FFB347` amber + complements. `LAZYCLAW_THEME` env. |

**Acceptance** — Visual regression: 80x24 / 120x40 snapshots; multiline editor 12-key sequence; Ctrl+C single press injects system message <200ms.

### 11.5 Phase D — Sandbox parity (6 parallel units, C8 canonical)

| # | Backend | Notes |
|---|---|---|
| D1 | `local` (with confiner sub-option) | `local.confiner` ∈ {auto, none, seatbelt, bubblewrap, firejail, landlock}. `auto` resolution per OS. |
| D2 | `docker` | Port of v4 `sandbox.mjs:38-128`. |
| D3 | `ssh` | `node-ssh` + OpenSSH ControlMaster. |
| D4 | `singularity` | `apptainer/singularity exec`. HPC. |
| D5 | `modal` | Serverless, idle-hibernation. |
| D6 | `daytona` | Workspace = long-lived session. Serverless. |

모두 `{exec, putFile, getFile, spawnPty, kill}` 인터페이스. Detection in `sandbox/index.mjs::resolveBackend`.

**Acceptance** — 14-command conformance suite (file write outside workspace, network call, fork bomb, large stdout, signal handling, env leak, ...) passes identically.

### 11.6 Phase E — Tools + MCP (15 parallel units)

| # | Group | Tools | Notes |
|---|---|---|---|
| E1 | fs | read, write, edit, glob, grep, ls | §7.2 #3–8 |
| E2 | shell | bash, bash_pty | #1–2 |
| E3 | net | web_fetch, web_search | #14–15 |
| E4 | git | git_status, git_diff, git_log, git_commit, git_push | #21–25 |
| E5 | gh | gh_pr_create, gh_pr_review | #26–27 |
| E6 | code (deferred to v5.1) | tree-sitter symbols/refs | deferred |
| E7 | browser | web_browse | #16; playwright_record deferred (#44, v5.1+) |
| E8 | python | uv-managed subprocess | helper, not in §7.2 catalogue |
| E9 | think | scratchpad, plan, reflect | helper |
| E10 | memory | recall, recall_pin, recall_forget | #9–11 |
| E11 | skills | skill_view, skill_install | #12–13 |
| E12 | channels | slack_post, team_post | #35, #43; voice TTS deferred (v5.1+) |
| E13 | datetime | now, parse, format with Intl | helper |
| E14 | MCP client | new `mcp/client.mjs` | stdio + SSE transports, capability negotiation, tool proxy |
| E15 | toolset CLI | `lazyclaw toolset enable\|disable\|list` | §7.3 |

**MCP**: client only (v5.0 N6). `mcp:<server>:<tool>` namespace. Lifecycle managed by daemon; orphans killed on shutdown via `~/.lazyclaw/mcp.pids`.

**Acceptance** — Each toolset smoke-tests primary tool dry-run. MCP client passes official conformance suite. `toolset enable git,gh,browser` activates only those (lazy require).

### 11.7 Phase F — Channels (7 parallel units)

| # | Unit | Source | Target |
|---|---|---|---|
| F1 | `@lazyclaw/channel-slack` | `channels/slack.mjs:1` | npm pkg (core in-tree mirror) |
| F2 | `@lazyclaw/channel-telegram` | `channels/telegram.mjs:1` | npm pkg |
| F3 | `@lazyclaw/channel-matrix` | `channels/matrix.mjs:1` | npm pkg |
| F4 | `@lazyclaw/channel-discord` | new | npm pkg, `discord.js` |
| F5 | `@lazyclaw/channel-http` | `channels/http.mjs:1` | core |
| F6 | Plugin loader | new `channels/loader.mjs` | discovery |
| F7 | `threads.jsonl` | new `channels/threads.mjs` | append-only |

**Acceptance** — Fresh install with zero channels boots clean. `npm i @lazyclaw/channel-slack` + config block → Slack works without code change. `threads.jsonl` replay deterministic.

### 11.8 Phase G — Persona + migration (5 parallel units)

| # | Unit | Notes |
|---|---|---|
| G1 | SOUL.md stack (C10) | Global `~/.lazyclaw/SOUL.md` (layer 1) ← workspace `<repo>/SOUL.md` (layer 1.5) ← personality (layer 2). 8-layer compose stack (§9.3). |
| G2 | Persona CLI | `lazyclaw personality show\|list\|use\|install\|remove\|import-hermes\|import-openclaw` (§9.4) |
| G3 | `migrate-v5` transform | v4 skills → v5 schema (confidence 0.5, `trained_by: legacy`, `group: legacy` fallback per C5), v4 channel configs → v5, FTS5 rebuild |
| G4 | Hermes import | `lazyclaw hermes import` — skin → `personalities/hermes-<slug>.md` (C7); USER.md → `memory/USER.md` (C6); skills → `skills/hermes-imports/`; `trained_by: hermes-import` (C4) |
| G5 | OpenClaw import | `lazyclaw openclaw import` — same shape, `trained_by: openclaw-import` (C4) |

**Acceptance** — 3 fixture v4 installs (minimal, slack-heavy, skill-heavy) → working v5 install, zero data loss vs snapshot, verified by exported trajectory diff.

### 11.9 Phase H — Polish (5 parallel units)

| # | Unit | Notes |
|---|---|---|
| H1 | Trajectory exporter | JSONL → Atropos-compatible. Schema TBD (Appendix B). |
| H2 | Cross-CLI confidence | trainer ≠ provider → confidence dampen by 0.85 (tunable) |
| H3 | Docs | README rewrite, `docs/` site, migration guide, persona cookbook. English primary; KR companion. |
| H4 | E2E suite | Playwright + CLI golden tests, 12 most common flows × 2 providers × 2 channels |
| H5 | Perf | Cold-start 400ms, recall p95 ≤ 50ms, daemon RSS ≤ 180MB idle |

### 11.10 Workflow tool integration

```js
// workflow/v5/phase-b.json (conceptual)
{
  "id": "v5-phase-b",
  "kind": "parallel",
  "branches": [
    { "id": "b6-confidence", "kind": "task",
      "task": "implement:learning/confidence.mjs" },
    { "id": "b1-synth", "kind": "task",
      "task": "rewrite:mas/skill_synth.mjs",
      "after": ["b6-confidence"] },
    { "id": "b2-modeler", "kind": "task",
      "task": "implement:learning/user_modeler.mjs" },
    { "id": "b3-recall", "kind": "task",
      "task": "implement:providers/tools/recall.mjs",
      "after": ["b1-synth"] },
    { "id": "b4-nudge", "kind": "task",
      "task": "implement:learning/nudge.mjs",
      "after": ["b1-synth"] },
    { "id": "b5-anti", "kind": "task",
      "task": "implement:learning/anti_patterns.mjs",
      "after": ["b1-synth", "b6-confidence"] }
  ],
  "gate": { "kind": "tests", "spec": "tests/phase-b/**" }
}
```

`gate` 가 acceptance runner — pass 시까지 phase done 표시 거부. Real-world bootstrap of substrate.

### 11.11 Release candidates

- **v5.0-rc.1** = A + B + C + E. Internal alpha. No sandbox parity, no plugin channels, no migration tooling. Learning loop + new tool runtime testable. Private cohort.
- **v5.0-rc.2** = + D + F + G + H. Public beta. Migration path live.
- **v5.0 GA** — rc.2 + 2 weeks clean telemetry (no migration data loss, no daemon OOM, recall p95 in budget).

### 11.12 Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ink rendering perf on large transcripts | M | M | Ink `<Static>` virtualize; cap visible history 200 lines; full log in `threads.jsonl` |
| `node-pty` build on Windows | H | M | `node-pty-prebuilt-multiarch`; degrade to non-pty exec on build failure |
| MCP child processes orphaned on crash | M | H | Daemon writes pid list to `~/.lazyclaw/mcp.pids`; on boot SIGKILL survivors with ppid=1 |
| FTS5 corruption under concurrent writes | L | H | Single-writer queue in `learning/db.mjs`; nightly `PRAGMA integrity_check` + auto-rebuild from `trajectories` |
| Trajectory schema drift vs Atropos | M | M | Pin schema version per export; `lazyclaw export --schema-version` flag; bridge layer if upstream changes |
| `better-sqlite3` native build on exotic targets | M | M | Prebuilt: darwin/linux/win × x64/arm64. Docs fallback for musl/freebsd (C11) |
| Honcho-style user modeling produces low-quality traits | M | M | B2 gated behind `learning.user_modeler: experimental`; off by default in rc.1 |
| Skill bank explosion (10k+ low-value skills) | M | M | Confidence-decay job; `lazyclaw skills compact` GC; per-tag caps |
| Generic Sleepy Sloth image source ambiguity | L | L | Wikimedia Commons PD `Bradypus_variegatus.jpg` family + locally re-rendered ASCII; `assets/SLOTH.LICENSE` |

### 11.13 Open questions

→ See **Appendix B**.

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **lazy_orchestra** | v5 의 multi-worker orchestration substrate. v4 `providers/orchestrator.mjs` 의 후신. PLAN → DISPATCH → EXECUTE → SYNTHESIS → POST-HOC LEARNING (5 phases). 학습 substrate 로 재배치. |
| **trainer provider** | chat 와 별개로 학습 (skill synth, reflection, user modeling, recall summarisation) 을 담당하는 provider. `cfg.trainer` 로 분리 구성. `claude-cli` 로 두면 Claude Pro/Max 구독자는 $0 marginal cost. |
| **TrajectoryRecord** | 한 worker 의 task 실행 시퀀스를 정규화한 record. fields: `id, taskId, agentName, workerProvider, workerModel, startedAt, endedAt, systemPrompt, userMessages, turns, finalAnswer, outcome ('done' \| 'failed' \| 'abandoned'), ratings?`. JSONL 로 디스크 저장, SQLite FTS5 로 인덱스. |
| **SKILL.md frontmatter (v5)** | flat YAML with v4 fields (`name, description, version, created_by, source_task, created_at`) + v5 additions: `group, trained_by` (canonical enum), `trained_on_model, trajectory_ref, cross_cli_tested[], confidence`. `group:` 미지정 시 filename hyphen-prefix; 없으면 `legacy`. |
| **trained_by enum** | `'claude-cli' \| 'codex-cli' \| 'gemini-cli' \| 'anthropic' \| 'openai' \| 'gemini' \| 'ollama' \| 'user' \| 'legacy' \| 'hermes-import' \| 'openclaw-import'`. canonical single list. |
| **outcome enum** | `'done' \| 'failed' \| 'abandoned'`. TrajectoryRecord, `fts_trajectories.outcome` UNINDEXED 컬럼, `recall().filter.outcome` 모두 동일. `'success'`/`'partial'` 폐기. |
| **cross_cli_tested** | SKILL.md frontmatter array. 한 worker 가 짠 skill 을 다른 worker 에서 replay 한 결과 `[{provider, model, outcome, tested_at}]` 기록. recall ranking 의 direct evidence. |
| **confidence (skill)** | 0..1, Wilson lower bound across `cross_cli_tested`. neutral prior 0.5. < 0.3 시 `skills/.archive/` 로 이동 (삭제 아님). |
| **SOUL.md** | `~/.lazyclaw/SOUL.md` (글로벌, config root) + `<workspace>/SOUL.md` (project, layer 1.5). user-authored, read-only at runtime. lazyclaw 의 identity. |
| **USER.md** | `~/.lazyclaw/memory/USER.md` (memory dir). curator-written, user-editable. lazyclaw 의 view of user (preferences, projects). |
| **personality** | `<configDir>/personalities/<name>.md`. frontmatter (name, version, display, description, tone, languages, tokens, inherits, tags, hermes_origin, checksum) + body. layer 2 of compose stack. Hermes skin 도 이 디렉터리로 import. |
| **persona compose stack** | 8 layers (1 global SOUL + 1.5 workspace SOUL + 2 personality + 3 agent.role + 4 USER excerpt + 5 skill index + 6 memory excerpt + 7 trajectory). `\n\n---\n\n` separator. layer 7 never truncated. |
| **toolset** | named tool whitelist with `extends`, `include` (glob), `exclude`. stored at `~/.lazyclaw/toolsets/<name>.json`. agent records reference via `toolset?:string` (or raw `tools:[...]` for v4 compat). |
| **sandbox backend** | one of `local, docker, ssh, singularity, modal, daytona`. each implements `Sandbox` (init, isPty, supportsServerless) + returns `SandboxSession` (exec, putFile, getFile, spawnPty, kill). |
| **local.confiner** | `local` backend 의 sub-option. OS-native confinement 메커니즘: `auto, none, seatbelt (mac), bubblewrap, firejail, landlock (linux)`. 별도 backend 아님. |
| **PTC hijack** | Prompt-Through-Cursor. malicious tool output 이 PTY control sequence 를 통해 daemon stdin 으로 prompt injection 하는 공격. §6.8 mitigations. |
| **trigger (learning)** | one of `post-task, post-failure, nudge, active-recall-miss, periodic-curation`. 모두 `runLearning(trigger, ctx)` 로 funnel. nudge/anti-pattern 의 auto 실행은 v5.0 = manual, v5.1+ = automatic. |
| **trajectory export** | `lazyclaw trajectories export --format atropos\|axolotl\|openai-ft\|jsonl`. read-only serialiser, never trains weights in-process. zero-lock-in off-ramp. |
| **MCP** | Model Context Protocol. v5.0 ships **client only** (no server). transports: stdio-spawn + SSE/HTTP. tools wrapped as `mcp:<server>:<tool>`. |
| **channel plugin** | npm package `@lazyclaw/channel-*` with `lazyclaw` manifest stanza. loaded from `$LAZYCLAW_HOME/plugins/node_modules`. extends `channels/base.mjs::Channel`. |
| **threads.jsonl** | `$LAZYCLAW_HOME/threads.jsonl`, append-only `(channel, externalId) → sessionId` mapping for cross-channel continuity. |
| **resolveTrainer(cfg, opts?)** | `providers/registry.mjs` 신규 export. cfg.trainer 가 omitted 면 chat provider mirror 반환. `"auto"` literal 지원 (Claude Pro/Max 감지 시 `claude-cli`, 미감지 시 mirror). |

---

## Appendix B: Open Questions for User

다음은 v5.0 GA 전에 사용자 (yoo) 결정이 필요한 항목. 각 결정이 차단하는 phase 표시.

### B.1 Naming / packaging
1. **npm package name** — `lazyclaw` 가 squatted (no publish since 2019). 선택지: `@lazyclaw/cli`, `lazyclaw5`, `lazyclaw-agent`, request transfer. **Blocks: A5** (installer 가 패키지명 print).
2. **mascot CC0 source path** — 저장소에 source PNG (~200KB) 포함 여부? 포함하면 reproducible rebuild, 안하면 tarball size 감소. **Blocks: H3 docs**.

### B.2 Trainer
3. **`trainer.schedule` default** — `nightly` vs `on-tick`. Pro/Max 한도 안전 vs 학습 즉시성 trade-off. (현재 spec 은 `nightly` 기본.) **Blocks: A1**.
4. **API + subscription mixed mode** — chat=`anthropic` (API 결제) + Pro/Max 감지 시 trainer 를 silently `claude-cli` 로 라우팅? ToS 회색지대. **opt-in 명시 prompt** 권장 — 동의? **Blocks: A1**.
5. **trainer fallback trigger** — 어떤 error class 가 fallback 을 트리거? (현재 spec: any throw + budget cap.) rate-limit/auth 만으로 좁힐지? **Blocks: A1**.

### B.3 Scope / scope concerns
6. **HA tools (#39, #40)** — v5.0 metadata-only 로 두는 게 맞는지 (현재 spec), 아니면 아예 v5.1 까지 catalogue 에서 제거? **Affects: §7.2**.
7. **playwright_record (#44)** — 동일한 질문. **Affects: §7.2**.
8. **Voice TTS reply** — v5.0 = transcribe only (spec 현재). TTS reply 를 minimal (piper local) 로 v5.0 에 포함할지? **Blocks: E12, F**.
9. **Cross-CLI ensemble** (동일 task 를 claude-cli + codex-cli 동시 실행, 비교) — v5.0 포함 vs v5.1 으로 미룸. 비용 / 복잡도 큼. **Affects: §3**.
10. **Nudge auto-loop** — 현재 v5.0 = manual sweep. cron auto 를 v5.0 에 포함하면 사용자 "lazyclaw 가 멋대로 호출 더 쏜다" 우려 — 동의? **Affects: B4**.

### B.4 Integration depth
11. **agentskills.io publisher** — v5.0 = read-only consumer. publisher (auth + ToS + content policy) 는 v5.1 보류 — 동의? **Affects: §7.2 #13 `skill_install`**.
12. **Atropos trajectory schema priority** — Atropos 정확 미러 (upstream lock-in) vs 자체 schema + bridge layer (independence, adapter maintenance). **Blocks: H1**.

### B.5 Architecture / UX
13. **Trainer line in footer when `trainer === provider`** — 항상 렌더 (current spec, transparency) vs hide. **Affects: §5.7**.
14. **Ctrl-R recall scope** — session-only (current) vs cross-session via `sessions.mjs` index. cross-session 은 shell history 와 일치하지만 sensitive prompt leak surface. **Affects: §5.8**.
15. **Per-channel SOUL.md inheritance** — merge with most-specific-wins (current G1) vs strict override (compliance personas e.g. legal/support). **Affects: §9.3, G1**.
16. **Multi-channel reply fan-out** — 인바운드 채널로만 응답 (current) vs `channels[]` 전체 fan-out 옵션. **Affects: §8.5**.
17. **MCP plugin signature verify** — `lazyclaw channels install` 이 npm provenance 검증 강제? plugin 이 in-process 라서 attack surface 큼. **Affects: §8.7**.
18. **Workspace SOUL 처리** — layer 1.5 stack (current C10) vs project-only override 옵션. **Affects: §9.3**.
19. **Token budget shares** (25/20/10/15/10/15/5) — measure-first 라서 release 전 실측 필요. **Affects: §9.3, B**.

### B.6 Open from drafts
20. **Honcho user model wire compat** — `~/.lazyclaw/memory/USER.md` 와 별도로 Honcho-compatible JSON export/import 필요? **Affects: B2**.
21. **claude-cli trainer subprocess pool sharing** — chat 과 같은 pool? 별도? daemon lifecycle 영향. **Affects: A1, daemon.mjs**.
22. **`trajectories export --format atropos` reward signal** — reward 계산은 v5.0 미정의 → `--reward none` default? **Affects: H1**.

---

## Appendix C: Verified vs Unverified Claims

본 spec 은 Hermes Agent / OpenClaw / agentskills.io / Atropos 에 대한 여러 사실 주장을 포함한다. 본 부록은 어느 것이 사전 조사로 확인되었고 어느 것이 미확인 가정인지 명시한다. **미확인 주장에 의존하는 결정은 v5.0 GA 이전에 재검증 필요.**

### C.1 Verified

| Claim | Source | Section |
|---|---|---|
| Hermes Agent 가 NousResearch 산 (`@NousResearch/hermes-agent`) | Public repo metadata | §1.2, §1.6 |
| Hermes 와 lazyclaw 는 OpenClaw lineage 에서 갈라짐 | 양 프로젝트의 commit history / README citation | §1.2 |
| MCP 가 `@modelcontextprotocol/sdk` (TypeScript) 로 client/server 양쪽 지원 | npm registry + modelcontextprotocol.io | §7.4 |
| Atropos / Axolotl 가 trajectory consumption ecosystem | NousResearch/atropos repo, axolotl-ai-cloud/axolotl | §2.7 |
| FTS5 가 SQLite 3.20+ 표준 모듈, `MATCH` + `WHERE` UNINDEXED 컬럼 결합 가능 | sqlite.org/fts5.html | §4.3 |
| `better-sqlite3` 의 prebuilt binaries 가 darwin/linux/win64 x64/arm64 커버 | npm `better-sqlite3` package metadata | §4.2, §11.2 |

### C.2 Unverified (assumed for spec, must reconfirm)

| Claim | Why uncertain | Mitigation |
|---|---|---|
| Hermes Agent 가 **자체 sandbox** 를 갖는다 (§1.2 table) | drafted 시점 가정. Hermes 가 worker sandbox 를 자체 제공하는지 vs API 의 sandbox 에 의존하는지 미확인 | Phase D 시작 전 Hermes 코드 인용 확인 |
| Hermes 가 **Honcho-equivalent** user model 을 사용한다 (§1.1) | NousResearch 가 Honcho 협업 / fork 인지, 자체 구현인지 미확인 | Phase B2 시작 전 Hermes USER.md 구현 비교 |
| Hermes 가 **Nous Portal 단일 묶음** 으로 청구한다 (§1.2, §1.3) | USP 비교의 핵심 가정. Nous Portal 의 실제 billing 모델 미확인 | Marketing 전 fact-check, 틀리면 USP framing 재작성 |
| Hermes 에 CLI workers 가 **없다** (§1.6, parity matrix) | 부재 증명. 최신 Hermes 가 CLI worker provider 를 도입했을 가능성 | rc.1 직전 재확인 |
| `agentskills.io` 가 Hermes Agent skill 포맷과 호환되는 공개 레지스트리 (§1.6) | 사이트 존재 확인했으나 lazyclaw v4 와의 frontmatter compatibility 미확인 | E11 (`skill_install`) 구현 전 실제 .md 샘플 fetch + parse |
| Hermes 가 `MEMORY.md` / `USER.md` / `SOUL.md` / `skin.yaml` 파일 layout 사용 (§10.2) | OpenClaw lineage 추정. Hermes 가 실제 어떤 file 들을 쓰는지 미확인 | G4 (Hermes import) 구현 전 실제 install fixture 확보 |
| Hermes 가 channel adapter 를 `channels/*.toml` 형태로 보관 (§10.2) | 위와 동일 | G4 구현 전 fixture 확보 |
| OpenClaw 가 `messaging.*` config 키 + `allowlist` 파일 사용 (§10.3) | OpenClaw 자체가 historical project 인지 현역인지 미확인 | G5 구현 전 OpenClaw 저장소 재방문 |
| Modal / Daytona 의 idle-hibernation API 가 lazyclaw 의 `init()` re-attach 가정과 일치 (§6.6) | vendor docs 빠르게 확인했으나 long-lived workspace re-attach semantics 미검증 | D5/D6 구현 전 1 시간 PoC |
| Claude Pro/Max 의 `claude-cli` 사용량이 구독 한도에 포함됨 (§1.3, §2.5, USP 핵심) | Anthropic 의 공식 ToS 명문은 미확인. CLI 호출이 web/Pro 한도와 동일 풀이라 가정 | **GA 전 Anthropic 공식 확인 필수** — 다르면 USP 완전 재작성 |
| `chafa --symbols=braille` 가 모든 monospace 폰트에서 single-cell-wide (§5.10) | 일반적 사실이지만 모든 ship target 폰트 (Windows Terminal default 등) 에서 확인 안 됨 | C1 시작 전 visual regression matrix |
| node-pty prebuilt 가 Windows ARM64 / 최신 Node 22 LTS 에서 동작 (§11.12) | `node-pty-prebuilt-multiarch` 가 cover 한다고 가정 | rc.1 전 Windows CI 확인 |

### C.3 Implications

- **C.2 의 행 #11 (Claude Pro/Max + claude-cli 한도)** 이 만약 거짓이면 §1.3 의 USP 와 §2.5 시나리오 #1 ("$0 marginal cost") 가 무너진다. GA 이전 Anthropic 의 명시적 확인이 필요하며, 거짓일 시 USP framing 을 "cheap shared model selection" 으로 약화한다.
- **C.2 의 Hermes 관련 행들** 은 v5.0 이 Hermes parity 를 명시적으로 표방하므로 GA 이전 검증되어야 한다. Phase G (Hermes import) 시작 전이 자연스러운 checkpoint.
- **C.2 의 Modal/Daytona idle-hibernation** 은 §6 의 serverless USP 의 일부지만 v5.0 GA 차단은 아님 — D5/D6 구현 중 발견 시 spec 수정 가능한 수준.

---

*Living document. 본 spec 의 §0.1 canonical table 은 단일 진실이다. 후속 PR 이 다른 값을 도입하려면 먼저 §0.1 을 갱신해야 한다.*
