# 프론트 구현 및 셀프호스팅 연동 인계

갱신: 2026-09-21. 프론트와 로컬 규칙 데모는 실행 가능하다. Edge Function과 Node 서버가 공유하는 게임 트랜잭션 저장소(`PostgresRepository`)는 구현했고 PGlite로 로컬 검증했다(`tests/server/postgres-repository.test.ts`). **2026-09-21부터 운영 주소는 Node 서버가 이 저장소로 sbp 프로젝트 `spacecrew2`의 Postgres에 직접 연결한다**(상세: [운영 문서](DEPLOYMENT.ko.md), [최신 인수인계](../claudedocs/HANDOFF-20260921.ko.md)). Edge Function 자체를 sbp 플랫폼에 새로 배포하는 절차는 [sbp 플랫폼 배포](#sbp-플랫폼-배포)를 따른다.

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
| 실시간 어댑터 | private broadcast(`sbp:<프로젝트>:<uid>`) 구독, 캐시된 snapshot 반환, 재연결 시 재동기화 |
| 명령 | commandId, expectedRevision, attemptId; 충돌 시 재조회; 503/504/네트워크오류/429는 지터 재전송(최대 5회) |
| DB | `supabase/sbp/*.sql`(sbp 플랫폼용, 표+RLS+권한만, 한 파일 한 문장) / `supabase/migrations/*`(표준 Supabase CLI용, 이 플랫폼에는 적용 불가) |
| Edge Function | JWT payload 디코드(라우터가 이미 검증), Origin 제한, JSON/Zod 검증, CORS, 경로, 오류 응답 |
| Supabase 게임 저장소 | `PostgresRepository` 구현 완료. PGlite로 로컬 검증(`tests/server/postgres-repository.test.ts`); 원격 배포·실사용은 미검증 |
| 배포 | Cloudflare Tunnel + KT Cloud VM(`coolify-d1-01`) Coolify의 crew.bsh00.com. Node 서버가 정적 프론트/`/healthz`/`/api/crew`(sbp 프로젝트 `spacecrew2` Postgres 직접 연결)를 함께 제공. [운영 문서](DEPLOYMENT.ko.md) |

미션 1~50은 공통 엔진과 Node 저장소·`PostgresRepository`에 동일하게 적용했다. 원격 Supabase/sbp 프로젝트에서의 실제 다중 기기 동시 사용, 운영 환경 인증/Realtime, 기기를 바꿨을 때의 자리 복구는 다음 검증 단계다(로컬 PGlite 테스트는 셀프호스팅 전체 스택의 E2E 검증을 대체하지 않는다). 현재 브라우저 저장소가 지워지거나 시크릿 창을 바꾸면 기존 익명 식별자로 복귀하지 못한다. 초대 토큰은 기존 대원의 자리 복구 비밀로 사용하지 않는다.

## 파일 안내

- `src/App.tsx`, `src/styles.css`: 화면과 반응형 디자인
- `src/game/engine.ts`: 로컬·Node·Supabase 공유 규칙 엔진 (1~50), 사용자별 snapshot 투영
- `src/services/mock.ts`: localStorage + Web Locks + 탭 간 알림; 데모 전용
- `src/services/supabase.ts`: 익명 로그인/HTTP/private broadcast 어댑터, 명령 재전송
- `shared/contracts.ts`: 요청/응답 타입과 런타임 검증의 기준
- `shared/missions.json`: 50개 임무 목록, `playable`은 capabilities로 최종 결정
- `docs/openapi.json`: OpenAPI 3.1; `npm run contracts`로 재생성
- `supabase/sbp/NNN-*.sql`: sbp 플랫폼 배포용 DDL(표+RLS+권한). 한 파일 한 문장, 번호 순서로 적용
- `supabase/migrations/*.sql`: 표준 Supabase CLI(`supabase db push`) 대상. **sbp 플랫폼에는 적용 불가**(DO 블록·전용 역할 사용) - 참고용으로 보존
- `supabase/functions/_shared/handler.ts`: 테스트 가능한 HTTP 경계와 저장소 인터페이스(`CrewRepository`)
- `supabase/functions/_shared/postgres-repository.ts`: 실제 저장소 구현. `DbPool`/`DbTx` 인터페이스만 사용해 postgres.js와 PGlite(테스트) 양쪽에서 그대로 동작
- `supabase/functions/_shared/db.ts`, `jwt.ts`: SQL 클라이언트 계약, JWT `sub` 디코드
- `supabase/functions/crew-api/index.ts`: 표준 Supabase CLI(`supabase functions serve`/`deploy`)용 Deno 진입점. `npm:postgres` 사용
- `supabase/functions/crew-api/sbp-entry.ts`: sbp 플랫폼 배포용 진입점. `scripts/build-crew-api.mjs`가 이 파일만 번들링한다(직접 배포하지 않음)
- `scripts/build-crew-api.mjs`: postgres.js 동봉 + esbuild 번들 → `dist-edge/crew-api/{index.ts,files.json}` 생성(`npm run build:edge`)
- `supabase/functions/_shared/contracts.ts`, `missions.ts`: 공유 원본에서 생성된 배포 복사본. 직접 수정하지 않음

## 연결 환경 변수

프론트 `.env.local` 또는 Vercel의 환경 변수:

```dotenv
VITE_BACKEND_MODE=supabase
VITE_SUPABASE_URL=https://실제-프로젝트-API-호스트
VITE_SUPABASE_ANON_KEY=공개-클라이언트-키
VITE_CREW_API_URL=https://실제-프로젝트-API-호스트/functions/v1/crew-api
VITE_SUPABASE_PROJECT_ID=실제-프로젝트-UUID
```

`VITE_CREW_API_URL`을 비우면 기본 `/functions/v1/crew-api`를 사용한다. `VITE_SUPABASE_PROJECT_ID`는 private broadcast topic(`sbp:<이 값>:<auth uid>`) 구독에 필요하다. **관리 콘솔 주소는 프로젝트 API URL이 아니다.** `service_role`, DB 비밀번호, sbp 기계 토큰을 VITE 변수에 넣지 않는다. 빌드 환경 변수 변경 후 Vercel을 재빌드한다. 서버 연결에 실패해도 조용히 mock으로 전환하지 않는다.

Edge runtime (`supabase/functions/crew-api/index.ts`, 표준 Supabase CLI):

```dotenv
SUPABASE_URL=실제-프로젝트-내부-또는-공개-API
SUPABASE_ANON_KEY=공개-클라이언트-키
CREW_ALLOWED_ORIGINS=https://실제-프론트.vercel.app,http://localhost:5173
SUPABASE_DB_URL=postgres-계정-연결-문자열
CREW_PROJECT_ID=실제-프로젝트-UUID
```

sbp 플랫폼에서는 함수에 환경 변수를 직접 넣을 수 없다. 허용 출처는 `sbp secrets set --name APP_CREW_ALLOWED_ORIGINS --value-file <쉼표 목록>`으로 설정하고, 배포 manifest의 `secret_bindings`에 그 버전을 연결한다. 또 플랫폼 라우터는 `/functions/v1/crew-api` 아래의 하위 경로를 거부하므로, 클라이언트는 API 경로를 `?route=/rooms…` 쿼리로 보낸다.


sbp 플랫폼은 `SUPABASE_DB_URL`을 플랫폼이 직접 제공하고, `CREW_PROJECT_ID`는 런타임 env allowlist에 없어 [빌드 시 esbuild `define`으로 주입](#sbp-플랫폼-배포)한다. 게임 표는 `public.crew_*`에 있다. sbp는 스키마 생성(`create schema`)을 허용하지 않기 때문이다. 대신 모든 `crew_*` 표에 RLS를 켜고 정책을 두지 않으며, `anon`/`authenticated` 권한을 회수하고 `service_role`에만 부여한다. 그래서 PostgREST로 노출돼도 읽고 쓸 수 없다.

## sbp 플랫폼 배포

**전제**: 아래는 로컬 빌드·검증 절차다. 원격 배포(`sbp` 명령, SSH, 실제 DB 적용)는 운영자가 직접 실행한다.

1. **DB 표 생성**: `supabase/sbp/001-crew_rooms.sql`부터 `016-grant_sequence_service.sql`까지 **번호 순서대로 한 파일씩** `sbp db sql`로 적용한다. 각 파일은 이미 문장 하나이며 `$`·`--`·`/* */`·문장 중간 `;`이 없다. 실패 시 그 파일만 재시도하고 이후 파일은 이전 파일이 성공해야 진행한다(뒤 파일이 앞 파일의 표/컬럼을 참조).
2. **권한 확인**: 마지막 세 파일(`014`~`016`)이 끝나면 `service_role`이 `public.crew_*` 표 6개에 select/insert/update/delete를 가졌는지, `anon`/`authenticated`는 권한이 없는지 확인한다(`has_table_privilege`).
3. **함수 빌드**: `CREW_PROJECT_ID=<실제 프로젝트 UUID> npm run build:edge`. 네트워크로 `postgres@3.4.9`를 받아 Buffer/process/setImmediate 배너를 주입해 번들링하고, `supabase/functions/crew-api/sbp-entry.ts`(핸들러+저장소+엔진+contracts+missions+zod+postgres.js)를 esbuild로 단일 `dist-edge/crew-api/index.ts`(1개 파일, 약 0.57MB)로 묶는다. 실패하면 빌드를 중단한다(`CREW_PROJECT_ID` 누락 등).
4. **배포 입력 구성**: `dist-edge/crew-api/files.json`(`[{path:"index.ts", base64}]`)을 아래 manifest의 `source.files`에 넣는다.
   ```json
   {
     "project_id": "<프로젝트 UUID>",
     "expected_revision": "<현재 함수 리비전>",
     "manifest": {
       "schema_version": 1,
       "project_id": "<프로젝트 UUID>",
       "revision": "<새 리비전>",
       "platform_lock_sha256": "<플랫폼이 요구하는 잠금 해시>",
       "functions": [
         {
           "name": "crew-api",
           "revision": "<새 리비전>",
           "source": { "schema_version": 1, "files": "<files.json 내용>" },
           "auth_mode": "app_jwt",
           "limits": { "memory_mb": 128, "timeout_ms": 10000, "request_bytes": 65536, "response_bytes": 262144 },
           "secret_bindings": []
         }
       ]
     }
   }
   ```
   `sbp functions deploy`로 전달하는 정확한 CLI 인자·인증은 운영자의 sbp 원장 절차를 따른다(이 저장소는 그 명령을 실행하지 않는다).
5. **Realtime**: 추가 설정 없음 - private broadcast는 플랫폼의 `own-user-v1` 규칙(topic = `sbp:<프로젝트>:<auth uid>`)만 사용하며 `supabase_realtime` publication에 아무것도 등록하지 않는다.
6. **익명 로그인 허용**: 프로젝트의 Auth 설정에서 익명 로그인이 켜져 있어야 한다(`enable_anonymous_sign_ins`).
7. **프론트 빌드**: 위 "연결 환경 변수"의 `VITE_*` 값(`VITE_SUPABASE_PROJECT_ID` 포함)으로 `npm run build`.
8. **검증**: 서로 다른 브라우저/계정 3개로 초대·준비·동시 카드·중복 요청·재접속·트릭 자동 넘김을 확인한다. `claudedocs/SUPABASE-BPRIME-PROBE.ko.md`의 동시성 결과(동시 3~4 요청에서 멈춤 가능성)를 감안해 준비 단계처럼 전원이 동시에 누르는 지점을 특히 확인한다.

## 표준 Supabase CLI로 배포하는 경우 (sbp가 아닌 스택)

sbp 플랫폼이 아니라 표준 `supabase` CLI(Docker self-host 또는 Supabase Cloud)를 쓰는 스택도 **`supabase/sbp/*.sql`을 그대로**(001부터 순서대로) 적용한다 - sbp 전용 문법이 아니라 그냥 유효한 SQL을 파일 하나당 한 문장으로 쪼갠 것뿐이라 `psql`/`supabase db push` 어디서나 동작한다. `service_role`은 Supabase가 기본 제공하는 역할이라 별도 생성이 필요 없다. `supabase/functions/crew-api/index.ts`(`npm:postgres` import, `deno.json` import map)를 배포한다 - `index.ts`만 복사하면 `_shared`를 찾지 못하니 `supabase/functions` 전체를 배포한다. 이 경로는 `npx deno check`로 타입만 확인했고, sbp 절만큼 로컬 SQL 테스트(PGlite)로 실측하지 않았다.

`supabase/migrations/*.sql`(DO 블록, 별도 `players`/`invites` 표, `crew_server` 역할을 쓰는 이전 스키마)은 **현재 `PostgresRepository`와 호환되지 않는다.** 삭제하지 않고 참고용으로만 보존한다 - 다시 쓰려면 저장소 코드를 그 스키마에 맞게 다시 작성해야 한다.

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

단위/계약 테스트는 카드 분배, 선도색, 로켓, 교신, 목표 소유/순서, 랜덤/재시도, idempotency, revision/attempt 충돌, 재접속, Edge 인증/CORS/501을 확인한다. PGlite의 실제 SQL 실행으로 `supabase/migrations`(레거시)의 RLS와 `supabase/sbp`(현재) 위의 `PostgresRepository`를 각각 검사한다(`tests/schema.test.ts`, `tests/server/postgres-repository.test.ts`). 이는 셀프호스팅 전체 스택의 E2E 검증을 대체하지 않는다. Playwright는 데스크톱 및 모바일 크기에서 로컬 임무 완주, 새로고침 복구, 50개 선택과 카드 41장 로딩을 확인한다.

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

교신 확정은 `CommunicationModal.tsx`에서 처리한다. 시작 위치는 `TrickArea` 본인 신호 버튼이다. 미션 요약은 `StatusBar` 안의 `MissionPanel`, 재시작은 상단 액션 영역에 있다. API 변경 없이 기존 `communicate`/`request_restart`를 사용하며, D 미션에서는 `hidden` 표식을 전송한다. 브리핑부터 고정 화면을 적용하고 준비 dialog의 native close와 명시적 재열기를 동기화한다.

본인 대원 패널은 `OwnSeatDock`에서 손패 왼쪽에 배치한다. `PlayerSeat`를 본인/다른 대원이 공유하고 `TrickArea`는 본인을 제외한 패널만 렌더링한다. 중앙 트릭의 본인 슬롯은 유지한다. 본인 패널 높이는 손패 영역에 맞추며, 큰 미션의 여러 목표는 열 수를 늘려 두 줄로 배치한다.
