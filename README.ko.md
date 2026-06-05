# lazyclaw (한국어 안내)

> 영문 정본은 `README.md`. 본 문서는 핵심만 한국어로 안내한다.

## 설치

```bash
npm install -g lazyclaw
```

Node.js 18+ 필요. `better-sqlite3` native dep 가 빌드된다
(darwin/linux/win64 × x64/arm64 prebuilt 제공).

## 첫 실행

```bash
lazyclaw                  # 인터랙티브 splash + REPL
lazyclaw migrate v5       # v4 install 이 있는 경우
```

## v5.0 핵심 변경

- **Trainer provider 분리** — `provider` (chat) 와 `trainer`
  (skill synthesis) 를 독립 설정. Claude Pro/Max 사용자는 학습 비용
  $0 (`docs/trainer-recipes.md`).
- **FTS5 recall** — `~/.lazyclaw/index.db` 단일 SQLite + FTS5 corpus.
  cross-CLI trajectory recall 제공 (`lazyclaw recall <query>`).
- **Persona 7-layer compose** — workspace 별 SOUL.md, Hermes skin
  import (`docs/persona-cookbook.md`).
- **Sandbox 6-backend** — local / docker / ssh / singularity / modal
  / daytona.

## 마이그레이션

자세한 절차는 `docs/migration-v4-to-v5.md` 참고.

## 자주 쓰는 명령

```bash
lazyclaw recall "<query>"             # FTS5 검색
lazyclaw rates --trainer-only         # trainer 비용 추적
lazyclaw persona use <name>           # persona 활성화
lazyclaw-export --format openai-ft    # trajectory export
```
