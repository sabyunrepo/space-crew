# 프론트 구현 및 셀프호스팅 연동 인계

갱신: 2026-09-14. 프론트와 로컬 규칙 데모는 실행 가능하다. 원격 Supabase 프로젝트를 생성하거나 원격 DB에 SQL을 적용하지 않았다. 제공된 Edge Function은 인증·검증·라우팅 골격이며, 게임 트랜잭션 저장소는 아직 구현하지 않았다.

## 바로 실행

Node 22.12 이상 LTS 또는 Node 24 LTS를 권장한다. 패키지는 `package-lock.json`으로 고정했다. 개발 환경의 Node 23에서도 빌드/테스트를 실행했지만 Vitest의 공식 지원 버전 범위에는 들어가지 않는다.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

`http://localhost:5173`에서 실행한다. 기본 `VITE_BACKEND_MODE=mock`이므로 서버 키가 없어도 된다. 실행/빌드 시 v3 PNG 원본에서 WebP 41장을 자동 준비한다. 원본 카드나 v1/v2는 수정하지 않는다. 카드 전송량은 원본 약 86MB에서 WebP 약 4MB로 줄였다.

- 새 방 → 준비 완료 → 데모 대원 채우기 → 임무 시작.
- 브리핑 확인 후 **데모 대원 진행** 버튼으로 다른 대원의 차례를 진행한다. 전략을 판단하는 AI가 아니라 규칙 흐름을 확인하는 데모 대원이다.
- 자신의 목표를 선택하고, 손패를 고른 뒤 **선택한 카드 내기**를 누른다. 선도 색 따르기와 차례 검증이 적용된다.
- 교신 가능한 카드 선택 시 최고/최저/유일 버튼이 나타난다.
- 같은 브라우저의 새로고침/재방문은 좌석·손패·목표·교신·임무 시도를 유지한다.
- 로컬 초대 링크는 같은 브라우저 저장소만 읽는다. 다른 기기 간 실시간 플레이는 `VITE_BACKEND_MODE=server`와 Node 서버로 지원한다.

## 현재 구현 범위

| 영역 | 준비 상태 |
| --- | --- |
| 한국어 PC/모바일 웹 | 홈, 방 생성, 대기실, 브리핑, 목표 선택, 테이블, 손패, 교신, 성공/실패 |
| 카드 | v3 앞면 40장 + 뒷면 1종, 스폰지밥 7번 포함, 카드 도감 |
| 미션 | 50개 조건 데이터와 시작 번호 선택; 공유 엔진 1~50 및 특수 준비 단계 |
| 랜덤 | 실행 가능한 미션 1~50 중 선택, 성공 후 미추첨 미션, 실패/복귀 시 같은 번호 |
| 방 복귀 | 같은 브라우저의 저장된 익명/로컬 식별자 사용; 닉네임으로 자리를 찾지 않음 |
| 데이터 계층 | `GameService`를 공유하는 MockService / ServerService / SupabaseService |
| 실시간 어댑터 | `room_versions` 구독, 연결 후 snapshot 재조회, 포커스/복귀/15초 폴링 재동기화 |
| 명령 | commandId, expectedRevision, attemptId; 충돌 시 재조회; 응답 불명 시 동일 요청 재전송 |
| DB | private 권한/RLS/참조키/인덱스/Realtime 최소 데이터 migration |
| Edge Function | JWT 사용자 확인, Origin 제한, JSON/Zod 검증, CORS, 경로, 오류 응답 |
| Supabase 게임 저장소 | 미구현. `PendingRepository`는 쓰기/읽기에 501, capabilities는 backendReady=false |
| 배포 | 기존 Cloudflare Tunnel + 홈 서버 Coolify의 crew.bsh00.com. Node 프론트/API/WS 통합 서비스. [운영 문서](DEPLOYMENT.ko.md) |

미션 1~50은 공통 엔진과 Node 저장소에 적용했다. Supabase의 실제 동시 사용자 DB 트랜잭션, 운영 환경 인증/Realtime, 기기를 바꿨을 때의 자리 복구는 다음 백엔드 단계다. 현재 브라우저 저장소가 지워지거나 시크릿 창을 바꾸면 기존 익명 식별자로 복귀하지 못한다. 초대 토큰은 기존 대원의 자리 복구 비밀로 사용하지 않는다.

## 파일 안내

- `src/App.tsx`, `src/styles.css`: 화면과 반응형 디자인
- `src/game/engine.ts`: 로컬·Node 공유 규칙 엔진 (1~50), 사용자별 snapshot 투영
- `src/services/mock.ts`: localStorage + Web Locks + 탭 간 알림; 데모 전용
- `src/services/supabase.ts`: Auth/HTTP/Realtime 어댑터
- `shared/contracts.ts`: 요청/응답 타입과 런타임 검증의 기준
- `shared/missions.json`: 50개 임무 목록, `playable`은 capabilities로 최종 결정
- `docs/openapi.json`: OpenAPI 3.1; `npm run contracts`로 재생성
- `supabase/migrations/20260909044625_crew_contract_v1.sql`: CLI로 생성한 migration
- `supabase/functions/_shared/handler.ts`: 테스트 가능한 HTTP 경계와 저장소 인터페이스
- `supabase/functions/crew-api/index.ts`: Deno 실행 진입점
- `supabase/functions/_shared/contracts.ts`, `missions.ts`: 공유 원본에서 생성된 배포 복사본. 직접 수정하지 않음

## 연결 환경 변수

프론트 `.env.local` 또는 Vercel의 환경 변수:

```dotenv
VITE_BACKEND_MODE=supabase
VITE_SUPABASE_URL=https://실제-프로젝트-API-호스트
VITE_SUPABASE_ANON_KEY=공개-클라이언트-키
VITE_CREW_API_URL=https://실제-프로젝트-API-호스트/functions/v1/crew-api
```

`VITE_CREW_API_URL`을 비우면 기본 `/functions/v1/crew-api`를 사용한다. **관리 콘솔 주소는 프로젝트 API URL이 아니다.** `service_role`, DB 비밀번호, sbp 기계 토큰을 VITE 변수에 넣지 않는다. 빌드 환경 변수 변경 후 Vercel을 재빌드한다. 서버 연결에 실패해도 조용히 mock으로 전환하지 않는다.

Edge runtime:

```dotenv
SUPABASE_URL=실제-프로젝트-내부-또는-공개-API
SUPABASE_ANON_KEY=공개-클라이언트-키
CREW_ALLOWED_ORIGINS=https://실제-프론트.vercel.app,http://localhost:5173
CREW_DATABASE_URL=서버-전용-DB-연결-문자열
```

`CREW_DATABASE_URL`은 후속 저장소 구현을 위한 예약 항목이다. 현재 골격에서는 사용하지 않는다. `crew_server`는 NOLOGIN이며 비밀번호를 코드로 만들지 않았다. 운영자가 전용 LOGIN 역할을 만든 뒤 crew_server 역할만 부여하고 서버 내부 TLS 연결을 제공한다. `crew_private`를 PostgREST의 exposed schemas에 추가하지 않는다.

## 원격 연동 순서

1. 실제 프로젝트 API URL/공개 키, 익명 Auth 허용 여부, Edge runtime 배포 경로, 내부 DB 연결과 WebSocket 접근을 확보한다.
2. 개발용 DB에서 migration을 검토·적용한다. 운영 DB 적용은 별도 배포 작업으로 진행한다. `supabase migration new`로 파일은 생성했지만 `db push`나 원격 SQL은 실행하지 않았다.
3. `CrewRepository`를 Postgres 트랜잭션으로 구현한다. [API 계약](./API.ko.md)의 원자적 처리 순서를 따른다. `PendingRepository`를 교체하고 구현된 미션 ID 및 rulesetVersion을 capabilities에 명시한다.
4. 셀프호스팅 runtime에 `supabase/functions` 전체를 배포한다. `crew-api/index.ts`만 복사하면 `_shared`를 찾지 못한다. `deno.json`의 npm 버전 매핑도 포함한다. 현재 config.toml은 로컬 CLI 설정이며 원격 Docker의 Auth/게이트웨이 설정을 자동 변경하지 않는다.
5. 게이트웨이 JWT 검증과 함수 내 `auth.getUser(token)`을 실제 익명 사용자 토큰으로 검증한다. 익명 계정은 로그인 후 `authenticated` 역할을 사용한다. 함수에서 닉네임·request playerId·JWT user_metadata를 권한 근거로 사용하지 않는다.
6. `public.room_versions`만 `supabase_realtime` publication에 포함한다. migration은 해당 publication이 있으면 추가한다. 없는 스택은 publication을 먼저 제공한 뒤 이 테이블을 등록한다.
7. CORS에 실제 Vercel Origin을 넣고 HTTPS REST/WebSocket을 검사한다. 서로 다른 브라우저/계정 3개로 초대·준비·동시 카드·중복 요청·재접속을 검증한다.
8. `VITE_BACKEND_MODE=supabase`로 프론트를 빌드한다. 서버가 ready=false이면 방 생성 버튼이 잠긴다. 저장소를 구현하지 않은 채 ready 플래그만 바꾸지 않는다.

sbp 0.1.0 조사에서는 임의 migration, 게임 Edge Function 배포 및 익명 Auth 설정을 모두 완료하는 운영 경로가 확인되지 않았다. 기존 [조사 결과](./RESEARCH.ko.md)를 유지하며, 일반 Supabase CLI 명령을 sbp 명령처럼 취급하지 않는다.

## Vercel

Framework: Vite / Build: `npm run build` / Output: `dist` / Node: 24 LTS. `vercel.json`에 SPA 경로 재작성과 카드 캐시를 정의했다. `/join#token`, `/rooms/<uuid>` 직접 접속과 새로고침을 확인한다. 정적 빌드에는 앱과 WebP 카드만 포함하며 원본 ZIP/문서/서버 비밀은 포함하지 않는다.

## 검증 명령

```sh
npm run contracts
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

단위/계약 테스트는 카드 분배, 선도색, 로켓, 교신, 목표 소유/순서, 랜덤/재시도, idempotency, revision/attempt 충돌, 재접속, Edge 인증/CORS/501을 확인한다. PGlite의 실제 SQL 실행으로 migration과 RLS를 검사한다. 이는 셀프호스팅 전체 스택의 E2E 검증을 대체하지 않는다. Playwright는 데스크톱 및 모바일 크기에서 로컬 임무 완주, 새로고침 복구, 50개 선택과 카드 41장 로딩을 확인한다.

## 공식 기술 참고

2026-09-09 기준 문서를 확인했다. 운영자의 셀프호스팅 버전과 설정은 별도 확인 대상이다.

- [Supabase 익명 로그인](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Edge Function 인증](https://supabase.com/docs/guides/functions/auth)
- [Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase 변경 기록](https://supabase.com/changelog)
- [Vite 시작 가이드](https://vite.dev/guide/)

## 초기 프론트 구현 검증 결과 (2026-09-09 기록)

- 프로덕션 빌드 성공: JavaScript 약 336KB (gzip 약 101KB), 카드 WebP 41장 약 4MB.
- 단위·계약·SQL/RLS 테스트 14개 통과.
- 데스크톱/모바일 브라우저 테스트 4개 통과. 초대 링크 복사·재입장 검증을 추가한 뒤 해당 2개 흐름도 재검증 통과.
- Deno 타입 검사 통과: `npx deno check --config supabase/functions/deno.json supabase/functions/crew-api/index.ts`.
- PC 홈과 모바일 임무 결과 스크린샷 시각 검수 완료.
- 원격 DB/Edge 배포 및 실제 다중 기기 통신 검증은 아직 수행하지 않음.

## 2026-09-14 미션 적용

최신 범위·테스트 결과는 [50개 미션 구현 결과](./MISSION-IMPLEMENTATION-RESULTS.ko.md)에 기록한다. Node 실시간 서버 실행은 [README](../README.md#실시간-서버-실행)를 따른다. 이 모드는 Supabase 배포 완료를 의미하지 않는다.

공유 계약에 `preparation` 단계, 준비 응답/담당자 선택/목표 분배/토큰 편집/목표 양도/구조 신호 명령을 추가했다. `missionProgress`는 공개된 역할과 판정 진행량만, `me.hand`는 본인 손패만 전달한다. 준비 중 비공개 목표와 구조 신호 선택 카드는 다른 대원의 응답에 포함하지 않는다. DB의 JSON 상태를 갱신하는 후속 저장소는 `src/game/engine.ts`의 동일 규칙과 개인 투영을 사용해야 한다.

## 미션 준비 모달 (2026-09-14)

브리핑 확인·목표 선택·역할/목표 배정은 `src/components/table/MissionSetupModal.tsx`로 집중한다. 손패와 대원별 배정 결과는 기존 게임보드에서만 표시한다. `테이블 보기`는 화면만 닫고 확인 명령을 보내지 않는다. 서버의 준비 단계·내 선택 차례가 바뀌거나 재접속하면 모달을 다시 표시한다. 상태 저장, 게임 규칙 및 API 계약 변경은 없다. 세부 흐름과 접근성은 [캐릭터와 테이블](./CHARACTERS-AND-TABLE.ko.md)을 따른다.

### 2026-09-14 UI 후속 변경

목표 총수/공개 시점은 `MissionTaskInfo`, 지휘관 응답·결정은 `PreparationPanel`을 따른다. 실제 낸 카드는 `TrickArea`의 `.central-trick`에만 렌더링한다. 플레이어 패널은 캐릭터·교신 2열, 목표는 아래 행이다. 화면 맞춤과 캐릭터 명칭/기본 이름 정책은 [최신 테이블 기록](CHARACTERS-AND-TABLE.ko.md)을 참조한다. API와 캐릭터 ID는 변경하지 않았다.

일반 draft 목표 미션은 `usesCombinedTaskSetup` 정책에 따라 조건 표시와 카드 선택을 한 모달로 처리한다. UI의 별도 확인 클릭 대신 모달을 열 때 `briefing_ready`를 전송하며 엔진의 준비 장벽은 유지한다. 특수 미션 질문에는 자동 응답하지 않는다. 종료 결과는 `MissionResultModal.tsx`로 이동했고 재도전/다음 임무는 기존 명령과 방장 권한을 사용한다.

테마는 `ThemePicker.tsx`, `theme.css`, 초기 로딩용 `public/theme-init.js`에서 관리한다. 선택값 키는 `crew.theme`, 루트 속성은 `data-theme="light|dark"`다. 새 UI에 색을 추가할 때 양 테마의 글자 대비를 함께 확인하고 카드 이미지/슈트 의미 색에는 테마 필터를 적용하지 않는다. API 변경은 없다.

후속 협동 UI: `TokenEditor`는 확정 전 로컬 교환 미리보기를 제공하며 `confirm_tokens`의 선택적 두 ID로 원자적 확정한다. `RestartVote`는 snapshot 투표 상태를 표시한다. `CardHoverInfo`는 화면에 이미 있는 공개 이미지/라벨만 확대한다. 사용자 요청 웹 변형은 v4부터 적용한다([미션 기준](MISSIONS.ko.md)).
