---
title: Dashboard shell & motion (T1)
date: 2026-08-03
status: draft-for-review
author: yoo + Claude
---

# Dashboard shell & motion — T1 design

> 본문 한국어, 코드/식별자/경로/오류메시지는 영문 원본 (Global CLAUDE.md §2).
>
> 프로토타입: `scratchpad/dashboard-motion-study.html` (아티팩트로 배포, 21패널 동작 확인).
> 본 문서는 그 프로토타입에서 확정된 것을 레포에 옮기기 위한 설계다.

---

## 1. 배경과 범위

사용자 요구: **대시보드만으로 lazyclaw를 쓸 수 있게 한다.** hermes-agent 수준의 사용성, openclaw 수준의 확장성.

이 요구는 독립 서브시스템 3개로 갈린다. 한 스펙에 넣으면 검증 지점 없이 커진다.

| 트랙 | 내용 | 상태 |
|---|---|---|
| **T1 Shell & Motion** | 셸 재설계 · 모션 · live 갱신 · `dashboard.js` 모듈 분해 · 읽기 전용 격차 메우기 | **본 문서** |
| T2 Write parity | 게이트웨이 쓰기(페어링 디바이스) · task/workflow 실행 · 채널 페어링 · login | 후속 스펙 |
| T3 Extensibility | 패널 레지스트리 — 채널/스킬/MCP가 자기 surface 등록 | 후속 스펙 |

### 1.1 Goals

- G1 19개 평탄 탭 → 6그룹 사이드바 + `⌘K` 커맨드 팔레트 + 상시 Live 레일
- G2 `web/dashboard.js` (1796줄 단일 파일) → `web/ui/*.mjs` ES 모듈 분해. **빌드 스텝 없음**
- G3 모션 레벨 3 확정 적용 (§6). `prefers-reduced-motion` 완전 존중
- G4 이벤트 버스 최소 확장 → Live 레일이 팀 작업 외에도 살아있음
- G5 **읽기 전용으로 메울 수 있는 격차 전부 메움** — 신뢰 모델 무변경 (§8)
- G6 게이트웨이가 IA에 자리를 얻음 (읽기 전용 2패널)

### 1.2 Non-goals (T1)

- N1 게이트웨이 **쓰기** (디바이스 승인 · exec resolve) → T2. 근거 §8.5
- N2 Scheduling 생성 — `daemon/routes/scheduling.mjs`가 의도적으로 미제공. T2에서도 유지 판단 필요
- N3 프레임워크/빌드 도입 (Vite+Lit 검토 후 기각 — §5.1)
- N4 라이트 테마 — 현재 `dashboard.css`에 light 토큰이 없다. 다크 단일 커밋 유지
- N5 T3 패널 레지스트리
- N6 실제 Slack permalink 구성 (`slackThreadTs` → URL) — 데이터는 있으나 permalink 조립은 T2

---

## 2. 현황 확정 (측정값)

| 항목 | 값 |
|---|---|
| `web/dashboard.html` | 286줄, 19탭 평탄 `nav.tabs` |
| `web/dashboard.css` | 346줄. 키프레임 2개 (`tdelegate`, reduced-motion 블록) |
| `web/dashboard.js` | **1796줄 / 94.5K 단일 파일**. `.js`라 사이즈 게이트 대상 아님 |
| SSE | `GET /events` 존재. **Team Live 탭 1곳만 소비**. 나머지 18탭은 수동 Refresh |
| 이벤트 종류 | 7종, 전부 MAS 팀 경로 전용 (§7.1) |
| 게이트웨이 UI | **없음.** `dashboard.js`의 "gateway" 문자열 1건은 vLLM 설명문 |
| 사이즈 게이트 | `scripts/lint-file-size.mjs` — `.mjs`만, `LIMIT = 500`, `SKIP_DIRS = {node_modules, tests, dist-lazyclaw, .git}` |
| 패키징 | `package.json` `files`에 `"web/"` 통째로 포함 → 소스가 곧 배포물 |

### 2.1 이 설계를 이끄는 검증된 결함

프로토타입 작업 중 코드에서 확인한 것들. 전부 T1에서 고친다.

**F1 — 계층을 렌더에서 버린다.**
`teams.mjs`/`agents.mjs`에 `manager` 필드로 보고선이 존재하고 `buildTeamTree`가 그것을 읽는데,
`renderTeamCanvas` (`web/dashboard.js:1580-1588`)가 `walk`로 모든 자손을 **한 `.team-row`에 평탄화**한다.
결과: lead 한 줄 + 나머지 전부 한 줄. 데이터에 있는 구조가 화면에 없다.

**F2 — 채널 출처가 화면에 없다.**
`registerTask()`는 `slackChannel`·`slackThreadTs`를 저장한다 (`daemon/lib/team_inbound.mjs`가 채워 넣음).
`LOADERS.tasks` (`web/dashboard.js:1248`)는 id·title·team·lead·status·턴 **개수**·createdAt만 렌더한다.
출처도, 내용도 없다.

**F3 — transcript 라우트가 미사용.**
`GET /tasks/:id/transcript` (`registry.taskTranscript`)가 라우트 테이블에 있는데 대시보드에서 아무도 호출하지 않는다.
채널에서 온 대화를 대시보드에서 읽을 방법이 Recall 전문검색뿐이다.

**F4 — 권한 posture가 안 보인다.**
`team_inbound.mjs`는 inbound를 unattended 표면으로 보고 `cfg.security.unattendedExec !== true`면
claude permission mode를 **읽기 전용으로 fail-closed** 한다. 그 사실은 `inbound_team_permission_posture`
로그에만 남는다. Slack으로 시킨 일이 왜 아무것도 안 고쳤는지 대시보드에서 알 수 없다.

**F5 — SSE 이벤트가 MAS 전용.**
`emit()` 호출부는 `mas/mention_router.mjs`, `mas/agent_turn.mjs`, `mas/tools/delegation.mjs` 뿐.
팀을 안 돌리면 Live 레일이 빈 채로 있다.

**F6 — 게이트웨이 surface 0개.** §8.4.

---

## 3. Information architecture

### 3.1 그룹 구성 (21패널)

19개 기존 탭 + 게이트웨이 2패널.

| 그룹 | 패널 |
|---|---|
| **Work** | Chat · Tasks · Sessions |
| **Agents** | Agents · Teams · Team Live |
| **Automate** | Workflows · Scheduling · Trainer |
| **Knowledge** | Skills · Recall · Sandbox |
| **Gateway** | Approvals · Devices |
| **System** | Providers · Rates · Metrics · Doctor · Config · Status · Channels |

사이드바 폭 210px. 그룹 헤더는 uppercase 10px `--faint`.
항목별 카운트 배지(`.count`)는 값이 있을 때만. Approvals의 대기 건수는 `urgent` 변형(색+굵기+알약 모양 — 색 단독 아님).

### 3.2 URL과 딥링크

현행 `#<tab>` 해시가 진실의 원천이고 `hashchange`가 유일한 활성화 경로다. **유지한다.**
새 패널 id 2개 추가: `#approvals`, `#gateway`. 기존 19개 해시는 문자 그대로 보존 — 북마크가 깨지지 않는다.

### 3.3 `⌘K` 커맨드 팔레트

단일 진입점. 검색 대상:
- 21패널 (그룹명이 hint)
- 팀 (inbox 채널이 hint) → 선택 시 Team Live로 이동 + 그 팀 활성화
- 에이전트 (소속 팀이 hint) → Team Live + 팀 전환 + 해당 에이전트 선택
- 액션 (task 시작 · 팀 생성 · 채널 페어링 · config 키 설정 · workflow 실행 · index 재구축 · 승인 검토)

매칭: 부분문자열 우선(위치가 빠를수록 높은 점수), 실패 시 subsequence. 상위 8개.
키보드: `↑↓` 이동, `↵` 실행, `esc` 닫기. 열림 시 입력에 포커스, 닫힘 시 트리거로 복귀.

**탭 수가 도달성을 방해하지 않게 하는 것이 목적**이다. T3에서 패널이 늘어도 팔레트가 흡수한다.

### 3.4 Live 레일

topbar 아래 40px 스트립. 셸에서 **앰비언트 모션이 사는 유일한 곳**(§6.3).
좌측 `LIVE` 라벨 · 중앙 티커(1줄) · 우측 고정 통계(`running`, `today $`).
티커는 `aria-live="polite" aria-atomic="true"`.

### 3.5 모바일

820px 이하: 사이드바가 오프캔버스 드로어. topbar에 햄버거(`aria-expanded`/`aria-controls`), 백드롭, `Escape` 닫기.
드로어 백드롭은 `.shell` **밖**에 둔다 — 안에 두면 그리드 2열을 차지해 stage가 2행으로 밀린다(프로토타입에서 실제로 발생).

---

## 4. 모듈 아키텍처

### 4.1 결정: 제로빌드 유지

Vite+Lit(openclaw 방식)을 검토하고 기각했다.

| | 제로빌드 (채택) | Vite+Lit (기각) |
|---|---|---|
| 배포물 | `web/` 소스 그대로 (현행) | `web/dist/` — 커밋(§5.6 위반) 또는 `prepublishOnly` |
| 새 의존성 | 0 | `lit` runtime + `vite` dev |
| `git clone` 후 실행 | 즉시 | 빌드 필요 |
| 사이즈 게이트 | `.mjs`라 그대로 적용 | `.js`/`.ts`면 게이트 밖 → 아키텍처 락 약화 |
| `scripts/check-pack.mjs` | 무영향 | 재작업 |

기각 이유는 Lit이 나빠서가 아니라, **T1 스펙에 빌드·배포 파이프라인 재설계를 끌고 들어와** 셸·모션보다 그쪽 비용이 커지기 때문이다.

Lit이 줄 유일한 실익은 keyed diff다(현행은 `innerHTML` 전면 교체라 진행 중 애니메이션·포커스·스크롤이 날아간다).
그 실익이 필요한 범위는 좁다 — §4.4에서 직접 처리한다.

### 4.2 파일 배치

```
web/
  dashboard.html          셸 골격만 (사이드바/topbar/레일/패널 host/모달/팔레트)
  dashboard.css           토큰 + 셸 + 컴포넌트
  dashboard.js            엔트리. <script type="module" src="/dashboard.js">
  ui/
    shell.mjs             나브 모델 · 그룹 렌더 · 해시 라우팅 · 마커 · 모바일 드로어
    api.mjs               getToken/withAuth/apiRaw/api/apiSoft/promptForToken (현행 로직 이동)
    dom.mjs              el() · clear() · chip() · table() · rowList() · kvlist() · banner()
    modal.mjs             openModal/closeModal · 포커스 반환
    palette.mjs           ⌘K
    motion.mjs            레벨 토큰 적용 · FLIP 헬퍼 · 카운터 tween · reduced-motion 게이트
    stream.mjs            SSE 프레임 파서 + 구독 (현행 startTeamStream에서 추출)
    reconcile.mjs         keyed 리스트 갱신 (§4.4)
    panels/
      chat.mjs  tasks.mjs  sessions.mjs
      agents.mjs  teams.mjs  team_live.mjs
      workflows.mjs  scheduling.mjs  trainer.mjs
      skills.mjs  recall.mjs  sandbox.mjs
      approvals.mjs  devices.mjs
      providers.mjs  rates.mjs  metrics.mjs  doctor.mjs  config.mjs  status.mjs  channels.mjs
```

`dashboard.js`가 엔트리 파일명으로 남는 것은 의도적이다 — §11.1 참조.

**사이즈 게이트**: `web/ui/*.mjs`는 `.mjs`라 `LIMIT = 500`이 적용된다. 대시보드 코드가 처음으로 게이트 안에 들어온다.
`ALLOW` 래칫에 **새 항목을 추가하지 않는다** (그 맵은 명시적으로 "tech debt, not a blessing").
`team_live.mjs`가 가장 클 것으로 예상 — 500줄 초과 시 `team_live/topology.mjs` + `team_live/detail.mjs`로 더 쪼갠다.

### 4.3 데몬 정적 라우트 — 보안 관련

현행 라우트 테이블은 `/dashboard.css`·`/dashboard.js`를 **하드코딩**한다. `/ui/*.mjs`용 라우트 1개를 추가한다.

`daemon/route_table.mjs`:
```js
{ m: (c) => c.req.method === 'GET' && /^\/ui\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs$/.test(c.path || ''),
  h: meta.uiModule },
```

`daemon/routes/meta.mjs`에 `uiModule`을 추가하고 기존 `serveWebFile` + `_readAssetCached`를 재사용한다
(avatar 라우트와 동일한 규율: 정규식이 경로를 먼저 좁히고, 이름에 `.`이 확장자 외에 못 들어가므로 traversal 불가).
하위 디렉터리 1단(`panels/`)까지만 허용한다.

**인증 allowlist 확장이 필요하다.** `daemon/lib/auth.mjs`의 `STATIC_DASHBOARD_PATHS`는 정확 일치 `Set`이다:
```
'/', '/dashboard', '/dashboard/', '/dashboard.css', '/dashboard.js'
```
`isStaticDashboardPath`를 Set 조회 + 정규식으로 바꾼다:
```js
const UI_MODULE_RE = /^\/ui\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs$/;
export function isStaticDashboardPath(pathname) {
  return STATIC_DASHBOARD_PATHS.has(pathname) || UI_MODULE_RE.test(pathname);
}
```
`isAuthorized`가 이미 URL을 정규화한 뒤 호출하므로 dot-segment는 선차단된다. GET 전용 게이트도 그대로다.
**정규식은 소문자·숫자·`_`·`-`만 허용해 `..`과 대문자 우회를 막는다.**
기존 테스트가 단정하는 거부 케이스(`/dashboard.html`, `/dashboardx`)는 계속 거부된다.

### 4.4 keyed 갱신 — 좁게

현행은 모든 로더가 `innerHTML` 전면 교체다. 15개 패널은 탭 진입 시 1회 렌더라 그대로 둔다 —
CSS 진입 애니메이션만으로 충분하고, 전면 교체가 더 단순하다.

keyed 갱신이 **실제로 필요한 곳**은 라이브 갱신되면서 진행 중 애니메이션/기하를 잃으면 안 되는 곳이다:

1. **Team Live 토폴로지** — 보고선 엣지와 delegation flow가 타일의 실측 좌표를 읽는다. 재렌더가 좌표를 날리면 FLIP이 불가능하다
2. **Live 레일 티커** — 나가는 틱과 들어오는 틱이 공존해야 한다
3. **Approvals 카운트다운** — 1초마다 갱신되는데 매번 DOM을 갈면 포커스가 날아간다
4. **Tasks / Workflows 목록** — 상태가 SSE로 바뀐다

`web/ui/reconcile.mjs`: `reconcile(host, items, keyOf, create, update)` — 키로 노드를 재사용하고,
사라진 노드만 제거하고, 순서를 `insertBefore`로 맞춘다. 100줄 이하 목표. 라이브러리를 넣지 않는 근거가 이것이다.

---

## 5. 데이터 흐름

### 5.1 단일 SSE 구독

현행은 Team Live 탭이 자기 `startTeamStream`을 갖고 `TEAM.streaming` 플래그로 중복을 막는다.
`web/ui/stream.mjs`로 옮기고 **앱 수준 단일 구독**으로 만든다. 패널은 구독자로 등록한다.

```js
// stream.mjs
export function subscribe(fn)      // → unsubscribe
export function connect()          // idempotent
```

프레임 파서는 현행 로직 그대로다 (`\n\n` 분할 → `event:` / `data:` 라인).
`EventSource`를 쓰지 않는 이유도 그대로다 — 헤더에 bearer 토큰을 실을 수 없다.

재연결: 스트림이 끊기면 지수 백오프(1s → 최대 30s)로 재시도하고, topbar에 연결 상태를 표시한다.
현행은 끊기면 `○ disconnected`에서 멈춘다.

### 5.2 갱신 정책

| 패널 | 갱신 |
|---|---|
| Team Live · Tasks · Workflows · Approvals · Devices | SSE 구독 + 진입 시 1회 fetch |
| Chat | 자체 스트리밍 |
| Metrics · Status | 진입 시 fetch + `cost.tick`에 반응 |
| 나머지 | 진입 시 fetch + 수동 Refresh (현행 유지) |

**폴링을 도입하지 않는다.** 대시보드를 종일 열어두는 도구에서 데몬 부하를 상시로 만들지 않는다.

---

## 6. 모션 — 레벨 3

### 6.1 토큰

모든 애니메이션 규칙이 이 변수만 읽는다. 레벨 전환은 한 블록 재정의이고 캐스케이드 충돌이 없다.

```css
:root {
  --dur-fast: 160ms; --dur-mid: 260ms; --dur-slow: 460ms;
  --stagger: 46ms;   --lift: 8px;      --ambient: 1;
  --ease:     cubic-bezier(.2, .8, .2, 1);
  --ease-out: cubic-bezier(.16, 1, .3, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 1ms; --dur-mid: 1ms; --dur-slow: 1ms; --stagger: 0ms; --lift: 0px; --ambient: 0; }
  * { animation: none !important; }
}
```

레벨 1/2는 **출시하지 않는다** — 프로토타입의 비교 도구였다. 접근성 목적은 `prefers-reduced-motion`이 이미 담당한다.

### 6.2 기법

| 기법 | 구현 |
|---|---|
| nav 마커 슬라이드 | 절대배치 2px 바, `transform`+`height` 트랜지션. on/off border-bottom 대체 |
| 패널 진입 | 패널 host에 `animation`. 같은 노드 재사용 시 `getAnimations()` cancel→play로 재생 |
| 리스트/테이블 stagger | `animation-delay: calc(var(--i) * var(--stagger))`. 로더가 행마다 `--i` 설정 |
| 티커 교체 | 나가는 틱이 `--dur-fast`에 먼저 빠지고, 들어오는 틱이 그만큼 `animation-delay`. **동시 애니메이션 금지** (겹치면 한 줄 텍스트가 판독 불가 — 프로토타입에서 실제 발생) |
| 스트리밍 캐럿·thinking 셰이머 | `background-clip: text` + `background-position` 애니메이션. 팔레트는 `tui/wordmark.mjs` 4스톱 앰버 |
| 보고선 엣지 | tier별 배치 + 링크당 SVG cubic 1개, 타일 실측 좌표 기반 |
| 지휘계통 focus | hover/focus 시 조상+전체 리포트만 유지, 나머지 `opacity: .3`, 해당 엣지 강조 |
| delegation flow | 보고선 **엣지와 동일한 path**를 따라 밝은 dash 구간 이동. skip-level은 quadratic arc로 합성 |
| FLIP | 타일 rect 캡처 → `manager` 변경 → 재렌더 → WAAPI로 옛 박스→새 박스 |
| cross-team bump | 안 보는 팀에 이벤트 오면 그 팀 카드 펄스 |
| nav 배지 bump | 승인/페어링 요청 도착 시 카운트 갱신 + 해당 행 펄스 |
| 카운터 롤업 | `requestAnimationFrame` tween, 공유 루프 1개. TUI ctx 게이지와 같은 easing |
| 스파크라인 draw | `getTotalLength()` → `stroke-dashoffset`, 선이 도착한 뒤 끝점 pop |
| 승인 카운트다운 | 1초 인터벌로 남은시간 칩 + 미터. **에이전트가 막혀 있으므로 정보** |
| 앰비언트 드리프트 | Live 레일 배후 그라디언트 스윕, `--ambient` 게이트 |
| working halo | 작업 중 에이전트 링 |

### 6.3 상시 애니메이션 예산

레벨 3에서 유휴 시에도 도는 것은 **셋**이다: 레일 드리프트(14s), working halo(2.6s), 데몬 비콘(2.4s).
나머지는 전부 이벤트 트리거로 유휴 시 0이다.

- 앰비언트는 Live 레일 **1곳**에만 둔다. 다른 곳에 추가하지 않는다
- `document.visibilityState === 'hidden'`이면 앰비언트를 정지한다 (배터리/백그라운드 탭 CPU)
- halo는 `working` 상태 타일에만, Team Live 패널이 열려 있을 때만

### 6.4 SVG 함정 (프로토타입에서 확인)

- 절대배치 `<svg>`에 `inset: 0`만 주면 **intrinsic 300×150**으로 남아 엣지가 전부 잘린다. `width/height: 100%` 필수
- 엣지 stroke를 `--border`(#2a2a36)로 두면 패널(#14141c) 위에서 안 보인다. 보고선은 gridline이 아니라 구조 정보 → `--faint`, focus 시 `--dim`
- 타일 좌표를 읽는 코드는 패널이 **보이는 상태**에서 실행해야 한다 (`display:none` 하위는 rect가 0)

---

## 7. 이벤트 버스 최소 확장

### 7.1 현행

`mas/events.mjs` — 링 200, 프로세스 로컬. 7종:
`task.start` `task.done` `turn.start` `turn.end` `agent.status` `tool.call` `delegate`.
발화부: `mas/mention_router.mjs`, `mas/agent_turn.mjs`, `mas/tools/delegation.mjs`.

### 7.2 추가

| 이벤트 | 발화 위치 | payload |
|---|---|---|
| `workflow.step` | `workflow/` 실행 루프 | `{ id, step, total, name }` |
| `cost.tick` | 비용 누적 지점 (`daemon/lib/cost.mjs`) | `{ total, cap, currency }` |
| `channel.inbound` | `daemon/routes/conversation.mjs` inbound | `{ channel, to, team }` |
| `provider.error` | `providers/registry.mjs` 폴백 경로 | `{ provider, detail }` |
| `cron.fire` | `cron.mjs` / `goals_cron.mjs` | `{ name, next }` |

각 변경은 `emit()` 한 줄이다. 파일 수는 여럿이지만 납품은 얇다.
**payload에 시크릿·PII를 넣지 않는다** — 채널 메시지 본문은 싣지 않고 라우팅 사실만 싣는다.

게이트웨이 브로드캐스트(`exec.approval.requested`/`resolved`)는 **이미 존재한다** — `gateway/http_gateway.mjs`.
버스 확장 대상이 아니다. 대시보드가 소비만 하면 된다.

### 7.3 링 버퍼는 여전히 휘발성

200개를 넘기면 사라진다. Team Live는 연결 시 남아있는 것만 replay한다.
**지속 기록은 task 파일과 FTS 인덱스다.** 이벤트 스트림을 감사 로그로 쓰지 않는다.

---

## 8. 읽기 전용 격차 메우기

전부 데몬이 이미 가진 데이터의 읽기다. 신뢰 모델을 건드리지 않는다.

### 8.1 Team Live — 계층 렌더링 (F1)

`buildTeamTree` 규칙을 렌더에 그대로 반영한다. **lead가 유일한 루트**이고,
in-team `manager`가 없는 멤버는 co-root가 아니라 **lead의 자식**이다:

```js
const mgr = rec && rec.manager && members.includes(rec.manager) && rec.manager !== n ? rec.manager : lead;
```

- depth별 tier로 배치. 각 tier는 **이전 tier 순서를 따라** 정렬해 엣지 교차를 줄인다
- `manager` 순환에 안전: 도달하지 못한 멤버는 마지막 tier로 떨어진다 (무한 루프 없음)
- 같은 에이전트가 여러 팀에 속하면 팀마다 위치가 다르다. `manager`가 그 팀 로스터에 없으면
  타일에 `mgr outside team` 배지를 띄워 **왜 lead 밑에 붙었는지** 설명한다
- 팀 전환은 `<select>`가 아니라 **팀 카드**로. 멤버당 pip(작업 중이면 채움)로 인원·부하를 숫자 없이 전달.
  여러 팀이 동시에 일하는 것이 보여야 한다

### 8.2 Tasks — 출처 · transcript · posture (F2·F3·F4)

- **출처 칩**: 채널 발원이면 `⇄ #channel`, `title`에 `slackThreadTs`. CLI 발원은 `started in the CLI`
- **권한 칩**: unattended면 `read-only · <mode>` (warn), attended면 `<mode>` (ok)
- **상단 배너**: 채널 발원 태스크가 읽기 전용으로 돌고 있으면 경고 + 해제 키(`security.unattendedExec`)
- **Transcript 뷰**: `GET /tasks/:id/transcript` 호출. 출처 한 줄 · posture 배너 · 턴별 대화 ·
  FTS에서 `task:<id>`로 검색 가능하다는 안내
- 스레드 딥링크 버튼은 자리만 잡고 permalink 조립은 T2 (N6)

`resolvePermissionModeForSurface(cfg, 'unattended')`와 `cfg.security.unattendedExec`를 읽으려면
task 응답에 posture를 실어야 한다. `registry.tasksList`/`taskGet`에 `attended`/`permissionMode`를 추가한다 —
**설정값 자체가 아니라 유효 posture만** 노출한다.

### 8.3 Recall — task 히트

턴이 이미 `session_id = task:<id>`로 FTS에 미러링된다 (`tasks.mjs` `appendTurn`).
Recall 결과에서 `task:` 접두 히트를 태스크로 인식해 Transcript 뷰로 연결한다.

### 8.4 Gateway — 읽기 전용 2패널 (F6)

**Approvals** — `pendingApprovals()`. 데몬 라우트 컨텍스트에 `gateway`가 이미 주입되므로
(`daemon.mjs:297`) 네트워크 홉 없이 읽는다. 새 라우트: **`GET /approvals`** (데몬 토큰 게이트 안, 읽기 전용).

> **`/gateway/*` 아래에 두면 안 된다.** `daemon.mjs:242`의 `gwPath.startsWith('/gateway/')`가
> 그 접두를 가진 **모든** 요청을 device gateway의 `handle()`로 넘기므로, `GET /gateway/pending`은
> 라우트 테이블에 도달하지 못하고 `no such gateway route` 404가 된다. 데몬 소유 읽기 라우트는
> 평탄 이름(`/agents`·`/teams`·`/tasks`와 같은 규약)을 쓴다.

표시: tool · agentId · **이미 레댁션된** summary · 남은 시간 · 미터.
`approvalView()`가 프로세스를 떠나기 전에 요약을 캡·스크럽한다 — 대시보드가 추가로 가공하지 않는다.
용량 초과 시 oldest가 `by: 'system:capacity'`로 거부·축출되고, 타임아웃은 양끝이 클램프된다는 사실을 화면에 적는다.

승인/거부 버튼은 **T1에서 비활성**이고, 왜 비활성인지 실제 게이트 문구를 보여준다 (§8.5).

**Devices** — `PairingStore`의 `pending()`·`devicesList()`.
새 라우트: **`GET /devices`** (읽기 전용, 위와 같은 이유로 `/gateway/` 밖).
표시: pending 페어링 요청 · 승인된 디바이스(deviceId·platform·label·role·approvedAt) ·
SSE 용량(전역 256 / 디바이스당 8) · 그리고 **채널 게이트웨이 프로세스 카드**.

`devices.json`은 평문 베어러 토큰을 담는다(0600). **토큰은 응답에 절대 포함하지 않는다.**
라우트 핸들러가 `token` 필드를 명시적으로 제거한다.

### 8.5 "gateway"라는 이름이 두 개다 — 화면에 적는다

| | 어디서 도는가 | 무엇 |
|---|---|---|
| 디바이스 게이트웨이 | **데몬 안** (`daemon.mjs:107-111`, `createGateway()`) | `/gateway/*` HTTP+SSE · Ed25519 디바이스 인증 · exec 승인 |
| 채널 게이트웨이 | **별도 프로세스** (`commands/gateway.mjs`) | 채널을 in-process로, 자기 pidfile |

`/gateway/`는 공유 auth-token 게이트 **앞에서** 라우팅되고 자기 인증을 쓴다.
경로는 정규화 후 판정되어 `/gateway/../sessions`로 게이트를 건너뛸 수 없다.

**T1이 쓰기를 하지 않는 이유.** 대시보드를 서브하는 데몬은 기본값이 loopback + 무인증이다
(`lazyclaw dashboard`는 토큰을 발급하지 않는다). 반면 exec resolve는 디바이스별 Ed25519 바인딩 +
회전 베어러 토큰으로 막혀 있다. 그런데 `resolveApproval`은 **같은 프로세스의 함수**라
데몬 라우트에서 부르면 그 게이트를 통째로 우회한다. 그래서 T2에서 대시보드를
**정식 페어링 디바이스**로 만들어 동일한 4게이트를 통과시킨다. 결정 근거와 와이어 계약은 T2 스펙으로 이관한다.

---

## 9. 에러 처리

- 모든 fetch는 `api`/`apiSoft`를 통과한다. `apiSoft`는 `{status, body}`를 반환해 패널이 상태별 UI를 그린다
- 5상태 전부 구현: `idle` / `loading` / `empty` / `error` / `success`. **빈 상태는 행동 유도 문장**을 갖는다
- 401은 현행처럼 토큰을 1회 묻고 저장한다
- SSE 끊김은 조용히 넘기지 않는다 — topbar에 상태를 표시하고 백오프 재연결한다
- 패널 렌더가 던져도 셸이 죽지 않는다: `render()`가 `try/catch`로 감싸 해당 패널만 에러 상태로 만든다
- 상태색은 항상 아이콘+단어를 동반한다. **색 단독 전달 금지**

---

## 10. 접근성

- 사이드바는 `aria-current="page"`, 패널은 `<section>` + 제목. 팔레트는 `role="dialog" aria-modal="true"`
- 모달은 포커스를 첫 입력으로 옮기고 닫을 때 트리거로 복귀한다
- 티커는 `aria-live="polite" aria-atomic="true"`. 팀 카드 pip은 `aria-hidden` + 텍스트 대체(`.sr`)
- 드래그(T2 예정)에는 항상 키보드 대체 경로를 둔다 — detail 패널의 `<select>`
- 터치 타깃: nav 항목은 마우스 36px, `@media (pointer: coarse)`에서 44px
- 검증 뷰포트 375 / 768 / 1280px, 키보드 단독 조작, `prefers-reduced-motion`

---

## 11. 테스트

### 11.1 기존 테스트 영향

`dashboard`를 언급하는 테스트 파일은 16개지만, **서브된 HTML 문자열에 정규식을 거는 것은 2개**다.

| 파일 | 영향 |
|---|---|
| `f-dashboard-assets.test.mjs` | `<script[^>]+src="/dashboard\.js"` 단정. **엔트리 파일명을 `dashboard.js`로 유지하면 `type="module"` 추가에도 통과한다** (`[^>]+`가 흡수). 무변경 |
| `f-dashboard-auth.test.mjs` | `isStaticDashboardPath` allowlist를 단정. `/ui/*.mjs` 허용 케이스 **추가**, 거부 케이스(`/dashboard.html`, `/dashboardx`) 유지. + `/ui/../config` 등 traversal 거부 케이스 신규 |
| `f-dashboard-asset-cache.test.mjs` | `_readAssetCached` + `dashboardCss` 1회 디스크 읽기. `uiModule`도 같은 캐시를 쓰는지 **추가** |
| `f-dashboard-workflow-detail.test.mjs` | 워크플로 상세 렌더. 셀렉터가 바뀌면 갱신 |
| `f-dashboard-scheduling.test.mjs`, `phaseH-daemon-missing-routes.test.mjs` | 라우트 동작 테스트, 자산 무관. 무변경 |
| `tests/e2e/phaseH-e2e-matrix.spec.ts` | 대시보드를 구동하지 않는다. 무변경 |

### 11.2 신규 테스트

- `daemon/lib/auth.mjs` — `/ui/*.mjs` 허용, 대문자·`..`·2단 이상 중첩·비 `.mjs` 거부
- `uiModule` 라우트 — 200/404, content-type, traversal 거부, 자산 캐시 공유
- `buildTeamTree` 렌더 대응 — lead 단일 루트, in-team이 아닌 manager는 lead로, 순환 입력에 종료
- `reconcile.mjs` — 삽입·삭제·재정렬 시 노드 재사용(동일성 단정)
- SSE 프레임 파서 — 분할된 청크, 잘린 프레임, 잘못된 JSON 스킵
- 신규 이벤트 5종 — `emit` 호출과 payload 형태, **시크릿 부재 단정**
- 게이트웨이 읽기 라우트 — 응답에 `token` 필드가 **없음**을 단정
- posture 노출 — `attended`/`permissionMode`가 실려오고 설정값 원본은 안 실림

### 11.3 게이트

`npm test` (node --test + playwright) · `npm run lint:size` · `npm run lint:pack` 전부 통과.
`ALLOW` 래칫에 신규 항목 없음.

---

## 12. 단계

각 단계 끝에서 빌드·린트·테스트가 통과해야 한다. 원자적 커밋.

| # | 내용 | 검증 |
|---|---|---|
| 1 | `web/ui/` 골격 + `dom.mjs`/`api.mjs`/`modal.mjs` 추출 (동작 무변경) | 기존 테스트 통과 |
| 2 | `uiModule` 라우트 + auth allowlist + 테스트 | 신규 테스트 |
| 3 | `shell.mjs` — 그룹 사이드바 · 해시 라우팅 · 마커 · 모바일 드로어 | 21패널 도달, 해시 보존 |
| 4 | 패널 21개를 `panels/*.mjs`로 이동 (내용 무변경) | 기존 테스트 통과, 사이즈 게이트 |
| 5 | `motion.mjs` + CSS 토큰 · 기법 적용 | reduced-motion 확인 |
| 6 | `stream.mjs` 단일 구독 + 백오프 재연결 | 파서 테스트 |
| 7 | `reconcile.mjs` + 4개 라이브 목록 적용 | 노드 재사용 테스트 |
| 8 | Team Live 계층 렌더 (F1) + 엣지 + focus + flow | 트리 테스트 |
| 9 | `⌘K` 팔레트 | 키보드 경로 |
| 10 | 이벤트 버스 5종 확장 + Live 레일 | payload 테스트 |
| 11 | Tasks 출처·transcript·posture (F2·F3·F4) + Recall task 히트 | posture 노출 테스트 |
| 12 | Gateway 읽기 2패널 + `GET /approvals`·`GET /devices` | 토큰 부재 단정, `/gateway/` 밖 확인 |
| 13 | README 갱신 (§5.5 — 신규 UI·커맨드 팔레트·게이트웨이 뷰) | — |

---

## 13. 미해결 / T2 이관

- **게이트웨이 쓰기** — 대시보드를 페어링 디바이스로. 와이어 계약(canonical `v3` payload, base64 raw 서명,
  DER SPKI의 sha256 = deviceId, 4게이트)은 확인 완료. WebCrypto Ed25519는 Firefox 129+ / Safari 17+ / Chrome 137+.
  **미해결 문제**: 개인키는 `extractable: false`로 보관 가능하지만 게이트웨이가 돌려주는 베어러 토큰은 평문
  문자열이라 브라우저 저장소에 남는다. 완화 방향은 read-only observer와 짧은 TTL approver의 **분리 페어링**.
  T2 스펙에서 결론낸다
- **Scheduling 생성** — 데몬이 loopback 무인증이라 의도적으로 미제공. T2에서 유지 여부 판단
- **Slack permalink** — `slackThreadTs`로 URL 조립 (T2)
- **T3 패널 레지스트리** — 채널/스킬/MCP가 자기 surface 등록
