# 스페이스 크루 실제 플레이 프로토타입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 데모를 BGA식 반응형 게임 테이블 UI + 서버 판정 실시간 멀티플레이로 바꾸고 `https://crew.bsh00.com`에 공개해 친구들과 실제로 미션 1~4를 플레이한다.

**Architecture:** Node 24 단일 컨테이너가 빌드된 SPA(`dist/`)와 REST API(`/api/*`), WebSocket 변경 알림(`/ws`)을 함께 제공한다. 게임 판정은 기존 순수 엔진 `src/game/engine.ts`(`applyCommand`/`project`)를 서버에서 그대로 사용하고, 방 상태는 `DATA_DIR`의 JSON 파일로 원자적 저장한다. 프론트는 기존 `GameService` 인터페이스의 새 구현 `ServerService`로 연결되며, 배포는 home Coolify(Git+Dockerfile) → `home-coolify` Cloudflare Tunnel → `crew.bsh00.com`.

**Tech Stack:** React 19, Vite 8, TypeScript 7, zod 4, `ws`(WebSocket), Node 24, Vitest 5, Playwright 1.63, Docker, Coolify 4.3.18 CLI, Cloudflare Tunnel.

**Spec:** 사용자 요청(2026-09-11) + [PLAN.ko.md](../../PLAN.ko.md) §4·§6·§10 + [RESEARCH.ko.md](../../RESEARCH.ko.md) §3. 이 프로토타입은 PLAN의 Supabase 구성을 대체하는 경량 경로이며, PLAN의 서버 판정·손패 비공개·revision 원칙은 유지한다.

## Global Constraints

- 저장소: `/Users/byeonsanghun/goinfre/mission`, 브랜치 `feat/realtime-prototype`. `main` 직접 작업 금지. 에이전트는 커밋하지 않는다(HQ가 체크포인트 커밋).
- UI 문구는 한국어. 코드 식별자는 영어. 기존 명명(camelCase)과 파일 스타일을 따른다.
- 플레이 가능 미션은 기존과 동일하게 1~4. 인원 3~5명.
- 서버는 클라이언트가 보낸 playerId를 신뢰하지 않는다. 실행 주체는 Bearer `playerToken`으로만 결정.
- 상대 손패는 절대 응답/WS payload에 포함하지 않는다(`project()` 결과만 반환). WS는 `{type:"revision", revision}`만 전송.
- 반응형: 360px부터 가로 스크롤 없음, 터치 영역 44px 이상, 기준 폭 360/768/1024/1440.
- 규칙상 낼 수 없는 카드: 회색(grayscale) + 선택 불가 + `aria-disabled="true"` + 이유 안내.
- 컨테이너: 포트 `8080`, `0.0.0.0` 수신, 헬스 `GET /healthz`, 데이터 `DATA_DIR=/data`.
- 공개 주소 `https://crew.bsh00.com`, Coolify origin 도메인 `http://crew.bsh00.com`. 기존 Coolify 앱·터널 ingress·DNS 레코드는 변경하지 않고 추가만 한다.
- 비밀값(토큰·키)을 로그·argv·Git에 남기지 않는다.

## File Structure

| 경로 | 책임 | 담당 Task |
| --- | --- | --- |
| `server/rooms.ts` | 방 저장소: 생성·입장·스냅샷·명령·초대·AI 대원. 엔진 호출과 토큰 인증 | 2 |
| `server/persist.ts` | `DATA_DIR/rooms/<id>.json` 원자적 읽기/쓰기 | 2 |
| `server/app.ts` | HTTP 라우팅(`/api/*`, `/healthz`, 정적 파일·SPA fallback), WS 업그레이드 | 2 |
| `server/index.ts` | 진입점(포트·DATA_DIR 환경변수) | 2 |
| `src/services/server.ts` | `GameService` 구현(fetch + WebSocket 재연결) | 2 |
| `src/services/index.ts`, `shared/contracts.ts` | `mode: "server"` 추가 | 2 |
| `Dockerfile`, `.dockerignore`, `tools/prepare-web-assets.mjs`, `.gitignore` | 컨테이너 빌드, 원본 에셋 없이 빌드 가능 | 2 |
| `tests/server/*.test.ts` | 서버 단위/통합 테스트 | 2 |
| `claudedocs/BGA-UI-REFERENCE.ko.md` | BGA The Crew 테이블·가이드 화면 구조 참고 명세 | 1 |
| `src/components/table/*`, `src/styles.css`, `src/App.tsx` | BGA식 게임 테이블 레이아웃·손패·불가 카드 | 3 |
| `src/pages/GuidePage.tsx`, `src/pages/guide.css` | `/guide` 게임 방법 페이지 | 4 |
| `tests/e2e/server-multiplayer.spec.ts`, `tests/e2e/legal-cards.spec.ts` | 다중 브라우저 실제 플레이·불가 카드 E2E | 3, 5 |

---

### Task 1: BGA 화면 참고 명세 (조사, 코드 변경 없음)

**Files:**
- Create: `claudedocs/BGA-UI-REFERENCE.ko.md`

**Interfaces:**
- Produces: Task 3·4가 따르는 레이아웃 명세(영역 목록, 데스크톱/모바일 배치, 상태 표시줄 문구 패턴, 가이드 목차).

- [ ] **Step 1:** 기존 조사 `docs/RESEARCH.ko.md` §3을 읽는다.
- [ ] **Step 2:** `https://en.doc.boardgamearena.com/Gamehelpthecrew`, `https://en.boardgamearena.com/gamepanel?game=thecrew`, BGA 공통 게임 화면 구조(상단 상태 표시줄 "X must play a card" + 액션 버튼, 우측 플레이어 패널, 중앙 보드, 하단 내 손패)를 WebFetch 또는 aside-browser로 확인한다. 가능하면 튜토리얼/리플레이 화면 스크린샷 구조를 텍스트로 기록한다.
- [ ] **Step 3:** 다음 항목을 표로 작성한다: 화면 영역(상태 표시줄/플레이어 패널/트릭 영역/임무 영역/손패/로그), 영역별 표시 정보, 데스크톱 배치, 모바일 배치, 상호작용(카드 선택→확인, 통신 토큰 표시, 불가 카드 표시 방식), 가이드 페이지 목차와 각 절 요약(직접 작성한 한국어, 원문 복제 금지).
- [ ] **Step 4:** 출처 URL과 확인하지 못한 항목을 문서 하단에 적는다.

완료 기준: 문서만으로 Task 3·4 구현자가 BGA를 보지 않고 배치를 결정할 수 있다.

---

### Task 2: Node 실시간 서버 + ServerService + Docker

**Files:**
- Create: `server/persist.ts`, `server/rooms.ts`, `server/app.ts`, `server/index.ts`, `src/services/server.ts`, `tests/server/rooms.test.ts`, `tests/server/app.test.ts`, `Dockerfile`, `.dockerignore`
- Modify: `shared/contracts.ts:185` (`mode` 유니온에 `"server"`), `src/services/index.ts`, `package.json`(scripts·`ws`·`@types/ws`), `tools/prepare-web-assets.mjs`, `.gitignore`(`public/cards/` 제외 해제), `vitest.config.ts`(필요 시 server 테스트 포함), `.env.example`
- 수정 금지: `src/App.tsx`, `src/styles.css`, `src/components/**`, `src/pages/**` (Task 3·4 소유)

**Interfaces:**
- Consumes: `applyCommand`, `createState`, `newPlayer`, `project`, `fail`, `State` (`src/game/engine.ts`), `CreateRoomSchema`/`JoinRoomSchema`/`EnvelopeSchema`/`EntrySchema`/`ErrorSchema`/`ApiError` (`shared/contracts.ts`), 기존 `MockService`의 생성·입장·중복 명령·AI 대원 로직(`src/services/mock.ts:71-270`)을 서버로 이식.
- Produces (HTTP, 모두 JSON, 오류는 `ErrorSchema`):
  - `GET /healthz` → `200 {"ok":true}`
  - `GET /api/capabilities` → `CapabilitiesSchema`
  - `POST /api/rooms` body `CreateRoom` → `200 { entry: Entry, playerToken: string }`
  - `POST /api/join` body `JoinRoom` → `200 { entry: Entry, playerToken: string }` (JoinRoom에 inviteToken 포함)
  - `GET /api/rooms/:id` (Bearer) → `Snapshot`
  - `POST /api/rooms/:id/commands` (Bearer) body `Envelope` → `Snapshot`
  - `GET /api/rooms/:id/invite` (Bearer) → `{ inviteToken: string }`
  - `POST /api/rooms/:id/demo-crew` (Bearer, 방장만) → `Snapshot` (빈 좌석을 AI 대원으로 채움; 이후 AI 차례는 서버가 700ms 간격으로 자동 진행)
  - `WS /ws?roomId=<uuid>&token=<playerToken>` → 서버 메시지 `{"type":"revision","revision":number}`만. 인증 실패 시 close code 4401.
- Produces (클라이언트): `class ServerService implements GameService { readonly mode = "server" }` — `playerToken`은 `localStorage["crew.server.v1.token.<roomId>"]`에 저장. `subscribe()`는 WS 연결·지수 백오프 재연결(최대 10s)·`visibilitychange` 복귀 시 재구독 후 최신 revision 전달, 연결 상태를 `Connection`으로 보고. `fillDemoCrew`는 `/demo-crew` 호출, `demoStep`은 구현하지 않음(서버 자동 진행).
- `makeService()`: `VITE_BACKEND_MODE` 값 `mock | supabase | server`.

- [ ] **Step 1: 실패하는 저장소 테스트 작성** — `tests/server/rooms.test.ts`: (a) 방 생성 → 토큰으로 스냅샷 조회 성공, 다른 토큰은 403 `NOT_MEMBER`; (b) 초대 토큰으로 3명 입장 → 준비 → `start_mission` → 각자 스냅샷의 `me.hand`만 보이고 상대 손패가 응답 JSON 어디에도 없음(`JSON.stringify` 검사); (c) 같은 `commandId` 재전송 시 동일 결과, 다른 본문이면 `IDEMPOTENCY_CONFLICT`; (d) `expectedRevision` 불일치 시 409 + `currentRevision`; (e) 차례가 아닌 사람의 `play_card`와 `legalCardIds`에 없는 카드 거부; (f) 저장 후 새 `RoomStore` 인스턴스로 같은 방 복원(임시 디렉터리).
- [ ] **Step 2:** `npx vitest run tests/server/rooms.test.ts` → 모듈 없음으로 FAIL 확인.
- [ ] **Step 3:** `server/persist.ts`(`writeFile` 임시파일 → `rename`), `server/rooms.ts`(방별 직렬 큐로 명령 처리, 토큰은 `crypto.randomBytes(32).toString("base64url")`, 저장은 SHA-256 해시) 구현.
- [ ] **Step 4:** 테스트 PASS 확인.
- [ ] **Step 5: 실패하는 HTTP/WS 테스트 작성** — `tests/server/app.test.ts`: 임의 포트로 `createApp({ dataDir, staticDir })` 기동 후 `/healthz` 200, 방 생성→WS 구독→다른 플레이어 명령 시 revision 메시지 수신, 잘못된 토큰 WS 4401 종료, `/rooms/<uuid>` 경로가 `index.html` 반환, `/api/unknown` 404 JSON, 64KB 초과 본문 413.
- [ ] **Step 6:** FAIL 확인 → `server/app.ts`, `server/index.ts` 구현(`node:http` + `ws`의 `noServer` 업그레이드) → PASS 확인.
- [ ] **Step 7:** `src/services/server.ts` 구현, `src/services/index.ts`·`shared/contracts.ts` 수정. `npx tsc -b` 통과.
- [ ] **Step 8: 빌드 경로** — `tools/prepare-web-assets.mjs`는 `assets/cards/deck/v3`가 없고 `public/cards`에 webp 41개가 있으면 건너뛴다. `.gitignore`에서 `public/cards/` 제거. `package.json`에 `build:server`(예: `vite build --ssr server/index.ts --outDir dist-server` 또는 동등한 단일 번들)와 `start`(`node dist-server/index.js`) 추가.
- [ ] **Step 9: Dockerfile** — `node:24-alpine` 멀티스테이지. build 스테이지 `ENV VITE_BACKEND_MODE=server` 후 `npm ci && npm run build && npm run build:server`. runtime 스테이지는 `npm ci --omit=dev`, `dist/`·`dist-server/`만 복사, `USER node`, `ENV PORT=8080 DATA_DIR=/data`, `EXPOSE 8080`, `HEALTHCHECK`(wget `/healthz`). `.dockerignore`에 `node_modules assets artifacts test-results graphify-out .git`.
- [ ] **Step 10: 로컬 컨테이너 검증** — `docker build -t crew:local . && docker run --rm -d -p 18080:8080 -v crew-data:/data --name crew-local crew:local`, `curl -fsS localhost:18080/healthz`, 브라우저 없이 `curl`로 방 생성 응답 확인 후 컨테이너 정리.

완료 기준: `npm test` 전체 PASS, `npx tsc -b` PASS, 컨테이너 헬스 200.

---

### Task 3: BGA식 반응형 게임 테이블 + 불가 카드 비활성화

**Files:**
- Create: `src/components/table/GameTable.tsx`, `src/components/table/StatusBar.tsx`, `src/components/table/PlayerPanel.tsx`, `src/components/table/TrickArea.tsx`, `src/components/table/MissionPanel.tsx`, `src/components/table/Hand.tsx`, `src/components/table/cardRules.ts`, `tests/card-rules.test.ts`, `tests/e2e/legal-cards.spec.ts`
- Modify: `src/App.tsx`(게임 화면 부분을 `GameTable`로 교체, `/guide` 라우트 연결, `service.mode`별 배너/배지), `src/styles.css`
- 수정 금지: `server/**`, `src/services/**`, `shared/contracts.ts`, `src/pages/**`

**Interfaces:**
- Consumes: `Snapshot`(`shared/contracts.ts`), `communicationMarkers(state, playerId, card)` 의미(엔진), `claudedocs/BGA-UI-REFERENCE.ko.md`.
- Produces:
  - `cardRules.ts`: `export type CardAvailability = { cardId: CardId; enabled: boolean; reason: string | null }` / `export function handAvailability(snapshot: Snapshot, mode: "play" | "communicate" | "view"): CardAvailability[]`
    - `play` + 내 차례 + `phase==="playing"`: `legalCardIds`에 없으면 `enabled:false`, `reason: "선도 색(<색 이름>) 카드가 있으면 그 색을 내야 해요"`.
    - `play` + 내 차례 아님: 전부 `enabled:false`, `reason: "<닉네임> 대원의 차례예요"` (회색 처리하지 않고 선택만 막음 — 클래스 `card--waiting`).
    - `communicate`: 로켓 카드 및 교신 표식이 없는 카드는 `enabled:false`, `reason: "교신할 수 없는 카드예요"`.
  - `Hand` props: `{ cards: CardAvailability[]; selected: CardId | null; onSelect(cardId: CardId): void }` — disabled 카드는 `aria-disabled="true"`, 클래스 `card--illegal`(`filter: grayscale(1) brightness(.55)`, `cursor:not-allowed`), 클릭/키보드 무시, `title`=reason. 선택된 카드가 불가 상태가 되면 선택 해제.

- [ ] **Step 1: 실패하는 규칙 테스트** — `tests/card-rules.test.ts`: 선도 파랑·손패 [파랑3, 초록5, 로켓1]일 때 파랑3만 enabled; 선도 없음이면 전부 enabled; 내 차례 아니면 전부 disabled + reason에 닉네임; communicate 모드에서 로켓 disabled.
- [ ] **Step 2:** FAIL 확인 → `cardRules.ts` 구현 → PASS 확인.
- [ ] **Step 3: 레이아웃** — Task 1 명세 기준. 데스크톱(≥1024): `100dvh` 고정 그리드 — 상단 `StatusBar`(차례·안내 문구·주요 액션 버튼), 중앙 `TrickArea`(좌석 방향별 낸 카드, 선도 색 표시), 우측 `PlayerPanel` 목록(닉네임·지휘관·남은 카드·획득 트릭·교신 토큰·접속 상태), 좌/상단 `MissionPanel`(미션 번호·조건·목표 카드와 담당자), 하단 `Hand`(카드 겹침 배치, 선택 시 들어올림) + 제출 버튼. 태블릿(768~1023): 플레이어 패널을 상단 가로 스트립으로. 모바일(<768): 상단 상태바 고정, 플레이어 스트립(가로 스크롤 없이 축약 칩), 중앙 트릭, 하단 고정 손패(겹침 폭 자동 계산, 14장도 한 화면), 미션은 접이식 시트. 페이지 전체 세로 스크롤 없이 게임 조작 가능해야 한다. 로비·결과는 기존 흐름 유지하되 같은 디자인 토큰 사용.
- [ ] **Step 4: 불가 카드 E2E** — `tests/e2e/legal-cards.spec.ts`(mock 모드): 방 생성 → AI 대원 채우기 → 미션 시작 → AI가 선도할 때까지 진행 → 내 손패에서 `legalCardIds` 외 카드가 `aria-disabled="true"`이고 클릭해도 선택되지 않음, 합법 카드는 선택·제출 가능. desktop·mobile 프로젝트 모두.
- [ ] **Step 5:** 기존 `tests/e2e/*.spec.ts` 셀렉터가 깨지면 새 구조에 맞춰 수정(테스트 삭제·skip 금지). `npm run build && npm test && npm run test:e2e` PASS.
- [ ] **Step 6:** 360·768·1024·1440 폭 스크린샷을 `artifacts/qa/v2/`에 저장하고 가로 스크롤(`document.documentElement.scrollWidth <= innerWidth`) 검사.

완료 기준: 위 테스트 PASS, 네 가지 폭에서 손패·트릭·차례가 스크롤 없이 한 화면에 보임.

---

### Task 4: `/guide` 게임 방법 페이지 (BGA 도움말 구조 참고, 문구 직접 작성)

**Files:**
- Create: `src/pages/GuidePage.tsx`, `src/pages/guide.css`
- 수정 금지: 그 외 모든 파일 (라우트 연결은 Task 3이 `App.tsx`에서 `import { GuidePage } from "./pages/GuidePage.tsx"`로 수행)

**Interfaces:**
- Produces: `export function GuidePage(props: { onBack(): void }): JSX.Element`
- Consumes: 카드 이미지 `/cards/<suit>-<name>-<rank>.webp`(`public/cards`), `shared/missions.json`(미션 1~4 요약), `claudedocs/BGA-UI-REFERENCE.ko.md` 가이드 목차.

- [ ] **Step 1:** 절 구성 — 한눈에 보기(3줄 요약) / 목표 / 카드 구성(4색 1~9 + 로켓 1~4, 실제 카드 이미지) / 지휘관과 첫 트릭 / 트릭 규칙(색 따르기·로켓 우선·승자 선) — 예시 그림 3개 / 임무 카드 고르기 / 교신(최고·최저·유일, 한 번만) / 성공·실패 / 이 사이트에서 하는 법(방 만들기→초대 링크→준비→플레이, 회색 카드 의미) / 미션 1~4 요약.
- [ ] **Step 2:** 데스크톱은 좌측 고정 목차 + 본문, 모바일은 상단 접이식 목차. 360px 가로 스크롤 없음. 앵커 링크(`#tricks` 등).
- [ ] **Step 3:** `npx tsc -b` 통과(단독 컴파일 오류 없음).

완료 기준: 페이지만 읽고 처음 하는 사람이 첫 미션을 시작할 수 있다.

---

### Task 5: 서버 모드 통합 검증 (실제 다중 브라우저 플레이)

**Files:**
- Create: `tests/e2e/server-multiplayer.spec.ts`, `playwright.server.config.ts`
- Modify: `package.json`(`test:e2e:server`)

**Interfaces:**
- Consumes: Task 2 컨테이너/`npm start`, Task 3 UI 셀렉터.

- [ ] **Step 1:** `playwright.server.config.ts` — webServer `npm run build && npm run build:server && DATA_DIR=$(mktemp -d) PORT=18081 npm start`(빌드 시 `VITE_BACKEND_MODE=server`), baseURL `http://127.0.0.1:18081`.
- [ ] **Step 2:** 테스트 — 브라우저 컨텍스트 3개(데스크톱 1, 모바일 2): A 방 생성 → 초대 링크 → B·C 입장 → 전원 준비 → 미션 1 시작 → 브리핑 → 임무 선택 → 트릭을 끝까지 진행(각 컨텍스트가 자기 차례에 enabled 카드 중 첫 장 제출) → 세 화면 모두 성공/실패 결과 표시. 중간에 B 페이지 새로고침 후 같은 자리·손패로 복귀 확인. B 화면 DOM/네트워크 응답에 A 손패 카드 ID가 없음 확인.
- [ ] **Step 3:** `npm run test:e2e:server` PASS, 스크린샷 `artifacts/qa/v2/server-*.png`.
- [ ] **Step 4:** 코드 리뷰(보안: 토큰·손패 노출·본문 크기·경로 탐색 정적 파일) 후 지적 사항 수정.

---

### Task 6: GitHub 공개 저장소 + Coolify 배포 + crew.bsh00.com 연결

**Files:**
- Create: goby 기록 `/Users/byeonsanghun/orca/workspaces/Coolify_구축/goby/projects/space-crew.md`
- Modify: `/Users/byeonsanghun/orca/workspaces/Coolify_구축/goby/projects/INDEX.md`(행 추가), `README.md`(mission, 실행·배포 절 갱신)

- [ ] **Step 1:** HQ가 체크포인트 커밋 후 `gh repo create sabyunrepo/space-crew --public --source . --push` (브랜치 `feat/realtime-prototype` 포함). 푸시 전 `git ls-files | xargs du -ch | tail -1`로 대용량·비밀 파일 없음 확인.
- [ ] **Step 2: Cloudflare** — aside-browser로 로그인 환경에서 `bsh00.com` zone과 `home-coolify` 터널이 같은 계정인지 확인. 터널 Public Hostname에 `crew.bsh00.com` → `http://coolify-proxy:80` 추가(기존 `*.mystery-place.com` ingress와 동일 origin, Host header override 없음). DNS에 `crew` proxied CNAME 생성 확인. 기존 레코드·ingress 변경 없음. 계정이 다르면 중단하고 보고.
- [ ] **Step 3: Coolify** — goby `docs/ai/SESSION.md`→`NEW_PROJECT.md`→`APPLICATION.md`→`DEPLOY.md` 순서. 프로젝트 `space-crew`, 환경 `production`, `app create public` (Git `https://github.com/sabyunrepo/space-crew`, 브랜치 `feat/realtime-prototype`, 커밋 SHA 고정, `--build-pack dockerfile`, `--ports-exposes 8080`, `--domains http://crew.bsh00.com`, 헬스 `/healthz`, 메모리 512M, CPU 1). `/data` 영구 볼륨 추가(CLI 미지원 시 COMPATIBILITY 문서 경로). 배포 후 deployment UUID 기록.
- [ ] **Step 4: 공개 검증** — `curl -fsS https://crew.bsh00.com/healthz`, `/` 200, `/rooms/<임의 uuid>` 새로고침 200(SPA), WSS 연결(`wss://crew.bsh00.com/ws` 인증 실패 시 4401 종료로 업그레이드 경로 확인), HTTP→HTTPS 리다이렉트. Task 5 테스트를 `baseURL=https://crew.bsh00.com`으로 1회 실행.
- [ ] **Step 5:** 컨테이너 재배포 후 기존 방 복원(볼륨 유지) 확인.
- [ ] **Step 6:** goby 프로젝트 기록(UUID·SHA·도메인·검증 결과·롤백 방법) 작성.

완료 기준: 서로 다른 기기 3대가 `https://crew.bsh00.com` 초대 링크로 같은 방에 들어가 미션 1을 끝까지 플레이할 수 있다.

---

## 실행 순서

```text
Wave 1 (병렬): Task 1 조사 ─┐        Task 2 서버
Wave 2 (병렬): Task 3 UI ◀──┘  Task 4 가이드
Wave 3: Task 5 통합 검증 (Task 2·3·4 완료 후)
Wave 4: Task 6 배포 (HQ 커밋 후)
```

## Self-Review

- 요청 대비: BGA 가이드 페이지(Task 1·4), UI/UX 레이아웃·반응형(Task 1·3), 불가 카드 회색·선택 불가(Task 3), 실제 다인 플레이(Task 2·5), bsh00.com 하위 도메인·터널·호스팅(Task 6) — 누락 없음.
- 타입 일치: `ServerService.mode = "server"` ↔ `GameService.mode` 유니온 수정(Task 2). `handAvailability`/`CardAvailability`는 Task 3 내부에서만 사용. `GuidePage` 시그니처는 Task 3·4에 동일 표기.
- 파일 소유 분리: Task 2(server·services·contracts·빌드), Task 3(App·styles·components/table), Task 4(pages) — 병렬 편집 충돌 없음.
