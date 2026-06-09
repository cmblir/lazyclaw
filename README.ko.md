# lazyclaw (한국어 안내)

> 영문 정본은 [`README.md`](./README.md). 본 문서는 핵심만 한국어로.

**터미널 에이전트 — 학습은 네 Claude 구독으로 $0, 응답은 모든 채널로.**

터미널에서 대화하면 백그라운드 학습 루프가 대화를 재사용 가능한 스킬로 증류(claude-cli 구독 = API 청구 없음). Slack·Telegram·Discord·Matrix·Email·Signal·WhatsApp·Voice 연결. 어려운 작업은 planner + workers로 분산. 작고 읽을 수 있는 Node 코어.

## 빠른 시작

```bash
npm install -g lazyclaw     # 또는: npx lazyclaw
lazyclaw                    # 새 설치 → 가이드 셋업 후 chat
```

**첫 실행 = phased 위저드** (Hermes식 — 깔끔한 대화 1개 먼저, 그 다음 레이어링):
1. **Provider + model** — 화살표 picker (`claude-cli`는 키 불요)
2. **Verify** — 1-토큰 ping으로 응답 확인
3. **Context window** — 턴당 유지할 히스토리 (선택)
4. **Channel** — Slack/Telegram/Matrix/HTTP 빌트인, 나머지는 플러그인 (선택)
5. **Workspace / skills / webhook** (선택)
6. **Orchestration** — planner + workers 켜기 (선택)

언제든 `lazyclaw setup` 또는 chat에서 `/config`로 재실행.

## $0 자가 학습

`provider`(chat)와 `trainer`(학습 루프)를 분리. Claude Pro/Max 구독이 학습을 돌리는 동안 chat은 아무 backend나. 매 턴 후 fire-and-forget 루프가 trajectory 기록 + 스킬 증류(`trained_by` 태그). `trainer: { provider: "auto" }`면 claude-cli 세션 자동 감지 → **$0**.

```jsonc
{ "provider": "openai", "model": "gpt-4.1",
  "trainer": { "provider": "auto" } }   // 학습은 네 Claude 구독으로 $0
```

## 어디서나 대화

```bash
# Slack (Socket Mode): ~/.lazyclaw/.env 에 SLACK_BOT_TOKEN + SLACK_APP_TOKEN
lazyclaw slack listen                            # @멘션 수신, 스레드 응답
lazyclaw slack listen --provider orchestrator    # …오케스트레이션 응답
lazyclaw channels                                # 설정된 채널 보기
lazyclaw channels enable|disable slack
```

수신은 Slack Socket Mode(공개 URL 불요, app-level `xapp-` 토큰), 송신은 `message send`(Incoming Webhook). 위저드 채널 단계나 chat `/channels`로 설정.

## 상시 가동 (always-on)

데몬 = 에이전트 코어(`127.0.0.1`에 단일 provider 경로 + 세션/메모리 스토어). OS 서비스로 설치하면 터미널 종료·재부팅에도 살아있음:

```bash
lazyclaw service install                 # launchd(macOS) · systemd user unit(Linux) · detached pidfile fallback
lazyclaw service status
lazyclaw service uninstall
```

백엔드 자동 감지(`--backend launchd|systemd|fallback`로 override), 데몬 플래그 통과(`lazyclaw service install --port 19600 --auth-token "$TOK"`).

> ⚠️ `security.allowUnattendedSensitive=true`이면 채널 리스너/데몬이 **부팅 거부** — 이 플래그는 모든 inbound에 대해 fail-closed tool 승인 게이트를 우회하므로 상시 표면 + 이 플래그 = RCE 경로. 민감 tool 승인은 인터랙티브로 유지.

## 멀티 에이전트 오케스트레이션

provider를 `orchestrator`로 → **Plan → Delegate → Synthesise**. planner가 분해, workers가 병렬 실행, planner가 병합.

```bash
lazyclaw orchestrator set-planner claude-cli:claude-sonnet-4-6
lazyclaw orchestrator workers add claude-cli:claude-sonnet-4-6
lazyclaw orchestrator on
```

chat에서 `/orchestrator` (빈 입력 = on/off picker) 또는 `/orchestrator on|off|planner <spec>|worker add <spec>`.

## chat에서 직접 조작 (슬래시)

| 슬래시 | 기능 |
|---|---|
| `/config` | chat 나가고 setup 위저드 재실행 |
| `/provider` · `/model` | 검색 picker로 provider/model 선택 |
| `/channels [<name> on\|off]` | 채널 보기 / 토글 |
| `/orchestrator [on\|off\|…]` | 멀티에이전트 보기 / 토글 (빈 입력=picker) |
| `/context [turns N\|tokens N]` | 히스토리 윈도우 조절 |
| `/skill` · `/personality` · `/memory` · `/loop` · `/goal` | 스킬·페르소나·메모리·루프·목표 |

`/help`로 전체 목록. 고스트 자동완성, 한글 IME는 박스 안에서 조합.

## 대시보드

```bash
lazyclaw dashboard          # http://127.0.0.1:19600 로컬 웹 UI (17 탭, 다크 앰버)
```

## 설정 / 보안

설정은 `~/.lazyclaw/config.json`(plain JSON), 시크릿은 `~/.lazyclaw/.env`(0600, 로그 안 남김). 디렉터리 이동 `LAZYCLAW_CONFIG_DIR=/path`.

> ⚠️ `config.json`은 shell rc처럼 신뢰 코드 — `$(...)` 값은 로드 시 실행됨. 신뢰 못 할 스니펫 붙여넣기 금지. 민감 tool(shell/write/network)은 기본 fail-closed(승인 hook 필요).

Node 18+ (Slack Socket Mode는 22+). macOS / Linux / WSL 1급.
