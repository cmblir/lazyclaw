# pompos (한국어 안내)

> 영문 정본은 [`README.md`](./README.md). 본 문서는 핵심만 한국어로.

**터미널 에이전트 — 학습은 네 Claude 구독으로 $0, 응답은 모든 채널로.**

터미널에서 대화하면 백그라운드 학습 루프가 대화를 재사용 가능한 스킬로 증류(claude-cli 구독 = API 청구 없음). Slack·Telegram·Discord·Matrix·Email·Signal·WhatsApp·Voice 연결. 어려운 작업은 planner + workers로 분산. 작고 읽을 수 있는 Node 코어.

## 빠른 시작

```bash
npm install -g @cmblir/pompos     # 또는: npx @cmblir/pompos
pompos                    # 새 설치 → 가이드 셋업 후 chat
```

**첫 실행 = phased 위저드** (Hermes식 — 깔끔한 대화 1개 먼저, 그 다음 레이어링):
1. **Provider + model** — 화살표 picker (`claude-cli`는 키 불요)
2. **Verify** — 1-토큰 ping으로 응답 확인
3. **Context window** — 턴당 유지할 히스토리 (선택)
4. **Channel** — Slack/Telegram/Matrix/HTTP 빌트인, 나머지는 플러그인 (선택)
5. **Workspace / skills / webhook** (선택)
6. **Orchestration** — planner + workers 켜기 (선택)

언제든 `pompos setup` 또는 chat에서 `/config`로 재실행.

## $0 자가 학습

`provider`(chat)와 `trainer`(학습 루프)를 분리. Claude Pro/Max 구독이 학습을 돌리는 동안 chat은 아무 backend나. 매 턴 후 fire-and-forget 루프가 trajectory 기록 + 스킬 증류(`trained_by` 태그). `trainer: { provider: "auto" }`면 claude-cli 세션 자동 감지 → **$0**.

```jsonc
{ "provider": "openai", "model": "gpt-4.1",
  "trainer": { "provider": "auto" } }   // 학습은 네 Claude 구독으로 $0
```

## 어디서나 대화

모든 리스너는 상시 데몬의 **공유 세션 스토어**로 forward → chat·대시보드·전 채널이 메모리 하나를 쓰는 단일 에이전트(컨텍스트가 채널 간 따라옴).

```bash
pompos service install                         # 1) 상시 데몬(공유 brain)

# 2) 리스너를 데몬에 연결 (Slack Socket Mode: .env에 SLACK_BOT_TOKEN + SLACK_APP_TOKEN)
pompos slack listen                            # inbound를 데몬으로 forward, 스레드 응답
pompos slack listen --provider orchestrator    # …오케스트레이션 응답
pompos slack listen --daemon-url http://127.0.0.1:19600   # 비기본 데몬
pompos channels                                # 설정된 채널 보기
pompos channels enable|disable slack
```

리스너는 thin forwarder: 채널 소켓을 소유(Slack Socket Mode는 공개 URL 불요, app-level `xapp-` 토큰)하고 각 메시지를 데몬 `/inbound`로 POST → 데몬이 영속 세션에 바인딩 후 provider 실행. **데몬이 떠 있어야 함**(`pompos service install` 또는 `pompos daemon`); 타깃은 `--daemon-url`/`POMPOS_DAEMON_URL`로 override. 위저드 채널 단계나 chat `/channels`로 설정.

## 상시 가동 (always-on)

**한 프로세스, 모든 채널:** `pompos gateway` = 데몬 코어 + 설정된 채널 transport(Slack Socket Mode/Telegram long-poll/Matrix sync)를 단일 프로세스로. 채널이 in-process라 `/handoff`가 타깃 채널에 resume 마커 통지 가능(통지 실패 시 handoff 롤백).

```bash
pompos gateway                          # 데몬 코어 + 활성 채널 전부, 한 프로세스
pompos gateway --channels slack         # 채널 명시
pompos service install gateway          # 재부팅에도 살아있게
```

gateway는 **기본 인증** — 첫 실행 시 bearer 토큰을 만들어 `~/.pompos/gateway.token`(0600, 로그 안 남김)에 영속. 자기 채널은 자동 사용, 외부 호출자는 파일에서 읽음(`--auth-token`/`--no-auth`로 override).

분리 실행도 가능: 데몬만(`pompos service install`) + 채널별 `* listen` forwarder.

인바운드 메시지는 **idempotent** — 채널 native id(Slack `channel:ts`, Telegram `chat:message_id`, Matrix `event_id`)로 dedup, 재전송/리스너 재시작 replay는 기록된 응답 반환(provider 재실행 없음). 세션 바인딩된 채널 턴은 chat REPL과 동일한 post-task **학습 루프**에 공급(trainer `auto` → Claude 구독 $0).

> ⚠️ `security.allowUnattendedSensitive=true`이면 채널 리스너/데몬이 **부팅 거부** — 이 플래그는 모든 inbound에 대해 fail-closed tool 승인 게이트를 우회하므로 상시 표면 + 이 플래그 = RCE 경로. 민감 tool 승인은 인터랙티브로 유지.

## 멀티 에이전트 오케스트레이션

provider를 `orchestrator`로 → **Plan → Delegate → Synthesise**. planner가 분해, workers가 병렬 실행, planner가 병합.

```bash
pompos orchestrator set-planner claude-cli:claude-sonnet-4-6
pompos orchestrator workers add claude-cli:claude-sonnet-4-6
pompos orchestrator on
```

chat에서 `/orchestrator` (빈 입력 = on/off picker) 또는 `/orchestrator on|off|planner <spec>|worker add <spec>`.

## chat에서 직접 조작 (슬래시)

| 슬래시 | 기능 |
|---|---|
| `/config` | chat 나가고 setup 위저드 재실행 |
| `/provider` · `/model` | 검색 picker로 provider/model 선택 |
| `/trainer [set\|fallback]` · `/agent edit <name>` | trainer / agent의 provider+model을 같은 picker로 선택 (`auto`·custom-id 행 포함) |
| `/channels [<name> on\|off]` | 채널 보기 / 토글 |
| `/orchestrator [on\|off\|…]` | 멀티에이전트 보기 / 토글 (빈 입력=picker) |
| `/context [turns N\|tokens N]` | 히스토리 윈도우 조절 |
| `/agentic [on\|off]` · `/plan [on\|off]` | chat에서 tool 실행(approval 게이트); plan은 읽기전용 "먼저 제안" |
| `/skill` · `/personality` · `/memory` · `/loop` · `/goal` | 스킬·페르소나·메모리·루프·목표 |

`/help`로 전체 목록. 타이핑하면 자동완성: 명령어(`/...`)와 그 **인자**까지 — `/login`→`codex-cli`/`gemini-cli`, `/hud`→`on`/`off`, `/channels`→채널명, `/task`·`/team`·`/agent`·`/personality`·`/trainer`·`/orchestrator` 서브커맨드 등 — 팝업에 떠서 ↑/↓ 선택, Enter로 채움. provider→model 2단계 선택(`/model`·`/trainer set`·`/orchestrator planner`)은 `↹ pick` 힌트가 뜨고 **Tab**으로 드릴인 모달 열림. 한글 IME는 박스 안에서 조합.

스킬은 markdown 지침 번들로 시스템 프롬프트에 합성된다. `pompos skills starter`로 번들 스타터 팩 8종(`concise` · `korean` · `commit-message` · `code-review` · `channel-style` · `summarize` · `explain` · `debug-coach`) 설치, `pompos skills install <user>/<repo>`로 GitHub에서 추가 설치, chat에서는 `/skills`로 선택.

## 대시보드

```bash
pompos dashboard          # http://127.0.0.1:19600 로컬 웹 UI (그룹 사이드바 21패널, ⌘K 팔레트)
```

> ⚠️ **`pompos dashboard`로 열 것 — 맨 `pompos daemon`은 화면이 안 뜬다.** 루프백 Origin 허용은 `cmdDashboard`에만 있음. 브라우저는 `dashboard.js` 자체를 가져올 때도 `Origin` 헤더를 보내므로, 맨 데몬에서는 그 요청부터 403 — 화면이 "connecting…"에서 멈춘다.

그룹 사이드바(Work·Agents·Automate·Knowledge·Gateway·System, 21 패널) + `⌘K`/`Ctrl+K` 커맨드 팔레트 + 상단바 아래 실시간 이벤트 스트립, 전부 SSE 하나(`GET /events`)로 수신. 모션(팔레트·라이브 스트립·행 재정렬)은 `prefers-reduced-motion` 존중.

**Team Live**는 이제 실제 보고 체계를 그린다 — 매니저 아래 그 리포트들이 엣지로 연결(예전엔 리드 + 평평한 한 줄). **Tasks**는 출처(Slack 채널+스레드, 또는 CLI `pompos task start`)와 실제로 실행된 permission mode, 트랜스크립트 뷰어를 보여준다. **Approvals**·**Devices**는 신규 패널, 둘 다 **읽기 전용** — 승인 처리는 페어링된 기기의 Ed25519 토큰이 필요한데 대시보드는 그 기기가 아니므로, 페어링된 기기나 `pompos nodes`로 승인. Approvals 사이드바 배지는 Approvals 패널을 열 때만 갱신 — 그 이벤트가 아직 대시보드 SSE 스트림까지 오지 않아 다른 패널에 있는 동안은 실시간으로 안 움직인다. 라이브 스트립에 이벤트 4종 추가: `workflow.step`, `cost.tick`, `channel.inbound`, `provider.error`. `cost.tick`은 team 경유 트래픽에만 발생(`/chat`·`/agent` 경로는 설정된 cap을 cost accountant에 전달하지 않음). `cron.fire`는 없음 — 스케줄 작업은 launchd/cron이 띄우는 별도 서브프로세스에서 실행돼 데몬 이벤트 버스와 연결이 없다. `⌘K`는 패널 + 고정 액션 4개(작업 시작·새 팀·승인 검토·색인 재구축)까지만 — 팀/에이전트 이름으로는 아직 못 찾는다.

## 설정 / 보안

설정은 `~/.pompos/config.json`(plain JSON), 시크릿은 `~/.pompos/.env`(0600, 로그 안 남김). 디렉터리 이동 `POMPOS_CONFIG_DIR=/path`.

> ⚠️ `config.json`은 shell rc처럼 신뢰 코드 — `$(...)` 값은 로드 시 실행됨. 신뢰 못 할 스니펫 붙여넣기 금지. 민감 tool(shell/write/network)은 기본 fail-closed(승인 hook 필요).

Node 18+ (Slack Socket Mode는 22+). macOS / Linux / WSL 1급.

## lazyclaw에서 넘어오기

6.10.0까지는 `lazyclaw`였다. 기존에 설정한 것을 바꿀 필요는 없다.

- **상태는 그 자리에 남는다.** `~/.lazyclaw`가 있으면 그대로 계속 쓴다 — 이동·복사 없음. 새 경로로 옮기려면 `mv ~/.lazyclaw ~/.pompos`, 자동으로 인식된다.
- **`LAZYCLAW_*` 변수는 그대로 동작한다.** 시작 시 `POMPOS_*` 이름으로 미러링되므로 shell 프로필·CI 시크릿·유닛 파일이 계속 적용된다. 명시적으로 설정한 이름이 우선한다.
- **`lazyclaw` 명령도 유지된다.** 이름으로 호출하는 launchd plist·systemd 유닛·crontab, 그리고 개명 전에 만든 스케줄이 계속 돈다.
- **대시보드 로그인이 유지된다** — 옛 키에 저장된 토큰을 읽어 새 키로 옮긴다.

`npm install -g @cmblir/pompos`가 두 명령을 모두 설치한다. 릴리스는 `@cmblir/pompos`로
게시된다 — 무스코프 `pompos`는 npm이 기존 `prompts`와 너무 비슷하다고 거부해서 쓸 수 없고,
그럴 때 npm이 직접 제안하는 방식이 스코프 이름이다. 무스코프 `lazyclaw` 패키지는 npm에 있는
6.9.3에 머물고 이후 릴리스는 없다.
