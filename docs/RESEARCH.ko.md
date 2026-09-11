# 스페이스 크루 웹 — 사전 조사

조사일: 2026-09-09 KST. 대상은 **The Crew: The Quest for Planet Nine**이며, Mission Deep Sea는 범위에 포함하지 않는다. 구현 계획은 [PLAN.ko.md](./PLAN.ko.md)에 있다.

## 조사 결론

한국어 반응형 웹, 초대 링크, 실시간 다인 플레이, 중도 복귀는 제안한 구조로 구현할 수 있다. 프런트엔드는 Vercel의 정적 웹, 백엔드는 셀프호스팅 Supabase의 Auth·Postgres·Realtime·Edge Functions로 구성한다.

다만 **현재 제공된 sbp 0.1.0 관리 기능만으로 전체 게임을 배포할 수 있다고 확정할 수는 없다.** 게임 서버 코드와 데이터베이스 마이그레이션 배포 경로, 익명 인증 설정을 먼저 확보해야 한다. 셀프호스팅의 서버리스는 앱 서버를 별도 상주시키지 않는다는 설계 의미이며, Supabase 컨테이너와 서버의 운영은 남는다.

## 1. 확인 범위와 근거

| 자료 | 확인 내용 | 한계 |
| --- | --- | --- |
| 지정된 GitHub AI 가이드, README, AGENTS, API 계약 | 인증된 GitHub CLI로 읽음 | 운영 서버의 현재 상태를 조회한 것은 아님 |
| 로컬 sbp | `/Users/byeonsanghun/.local/bin/sbp`의 버전 0.1.0 및 도움말 | 기계 credential 경로 미제공으로 인증·capabilities·프로젝트 목록 미조회 |
| KOSMOS 영문 규칙서 | 기본 규칙, 통신, 특수 토큰, 인원별 변형 | 공식 한국어 규칙서의 용어·판본 대조는 남음 |
| BGA 게임 페이지·영문 도움말 | 게임 정보, 통신 예약, 온라인 옵션 | 실제 방 참가·다인 플레이·재접속 시험은 수행하지 않음 |
| BGA에 연결된 영문 항해일지 | 50개 미션 본문·목표 수·그림 토큰·특수 조건을 이미지로 전수 대조 | 제3자 호스팅 사본. 일부 상호작용 판정·한국어판 대조는 남음 |
| Supabase 공식 문서·changelog | 익명 인증, Realtime 권한, 셀프호스팅 Functions | 최신 문서와 해당 플랫폼의 고정 이미지 버전은 다를 수 있음 |
| Vercel Vite 문서 | 정적 SPA 배포와 직접 URL 접근 설정 | 프로젝트 생성·배포는 수행하지 않음 |

GitHub 조사 기준 main 커밋: `bdad0f088c89f5ab28b67fd769bd3512b1f1e274`.
가이드는 2026-09-09 갱신본이다. 이 작업 디렉터리는 조사 시작 시 비어 있었고 기존 앱이나 graphify 보고서는 없었다.

## 2. 게임에서 구현해야 할 규칙

### 기본 흐름

- 기본 3~5인, 2인은 별도의 JARVIS 변형이다.
- 일반 카드 4색 × 1~9, 로켓 1~4로 총 40장이다.
- 첫 카드와 같은 종류를 보유하면 반드시 따라 낸다. 로켓은 으뜸패이면서 독립된 종류다.
- 로켓 4 보유자가 지휘관이고, 첫 임무 선택과 첫 트릭을 시작한다.
- 담당자가 목표 카드를 포함한 트릭을 얻어야 한다. 오수령·조건 위반이면 실패하며, 재도전은 새 배분이다.
- 3인 기본형은 14/13/13장으로 나누고 마지막 남은 한 장은 사용하지 않는다.
- 완료된 트릭 중 다시 확인 가능한 것은 직전 트릭뿐이다.

근거: [KOSMOS 규칙서, pp.2–10](https://www.thamesandkosmos.com/manuals/full/691868_Crew_Manual.pdf).

### 통신과 온라인 처리

통신은 시도마다 각자 한 번, 임무 배분 후 트릭 시작 전에 한다. 일반 카드 한 장의 최고·최저·유일 여부를 알리며 로켓은 대상이 아니다. 공개한 카드는 계속 손패에 속하고, 통신 표시는 이후 손패가 바뀌어도 갱신하지 않는다. [KOSMOS 규칙서, pp.5–7](https://www.thamesandkosmos.com/manuals/full/691868_Crew_Manual.pdf).

BGA는 통신 의사를 미리 예약하고 다음 통신 단계에서 선 플레이어부터 순서대로 처리한다. 예약 후 실제 공개를 포기할 수도 있다. 도움말에는 카드 선선택과 다음 미션 진행 자동 응답 등도 설명되어 있다. 이는 온라인 편의 기능으로 구분한다. [BGA 게임 도움말](https://en.doc.boardgamearena.com/Gamehelpthecrew), [BGA 게임 페이지](https://en.boardgamearena.com/gamepanel?game=thecrew).

### 쉽게 잘못 구현하는 부분

- 임무 순번은 트릭 번호가 아니다. 같은 트릭에서 연속 순서의 임무 여러 개가 충족되는 경우도 있다.
- 구조 신호는 같은 미션의 재시도에도 사용 기록이 이어지며, 성공 기록의 시도 수에 1을 더한다.
- 5인 후반부에는 표시된 미션에서 임무 한 장 양도 규칙이 추가된다.

근거: [KOSMOS 규칙서, pp.12–19](https://www.thamesandkosmos.com/manuals/full/691868_Crew_Manual.pdf).

BGA 도움말의 Dead Zone은 최고·최저·유일을 구분하지 않는 공개를 설명한다. UI가 가운데 표식을 쓰더라도 ‘유일’과 다른 데이터여야 한다. 지휘관의 결정·분배는 질문 응답을 수집하는 별도 흐름이다. [BGA 게임 도움말](https://en.doc.boardgamearena.com/Gamehelpthecrew).

### 50개 미션의 개발상 의미

항해일지를 읽어 보면 임무 수를 늘리는 것만으로 전체 캠페인이 구현되지는 않는다. 다음 유형을 표현해야 한다.

| 조건 유형 | 엔진에서 필요한 표현 |
| --- | --- |
| 특정 카드 획득·획득 순서 | 목표 목록, 절대/상대 순서, 마지막 목표 |
| 통신 제한 | 전원/특정 플레이어 제한, 시작 트릭, 정보 축소 |
| 지휘관 판단 | 공개 시점, 제한된 응답, 대상 선택 |
| 트릭 횟수·승리 카드 조건 | 누적 횟수, 금지/필수 승리 카드, 종료 시 판정 |
| 도중 카드 이동 | 지정 시점의 일괄 이동 및 재접속 가능한 선택 상태 |
| 임무 토큰 변경 | 선택 전 위치 교환/이동의 서로 다른 연산 |
| 역할별 초반·후반 조건 | 처음/마지막 트릭, 연속 구간, 서로 다른 담당자 |

예를 들어 5번은 특정 대원의 트릭 획득 금지, 12번은 첫 트릭 이후 카드 이동, 29번은 진행 중 획득 수의 균형, 50번은 트릭 구간별 역할을 다룬다. 미션 정의를 데이터로 작성하되 조건별 판정 코드를 제공해야 한다. [BGA 연결 항해일지 사본](https://cdn.1j1ju.com/medias/dd/5a/3a-the-crew-the-quest-for-planet-nine-log-book.pdf).

후속 조사에서 미션 수록 면 전체를 이미지로 확인하고 [50개 미션 조건 대조표](./MISSIONS.ko.md)를 추가했다. 목표 수·토큰·통신 조건·주요 특수 조건의 자료 대조는 완료했다. 12번의 통신 카드 이동 등 남은 판정은 대조표에 명시했으며, 엔진 구현·정상/실패 사례·다인 플레이 전수 검증은 아직이다.

## 3. BGA에서 참고할 부분

BGA는 한국어 게임명, 2~5인, 브라우저 플레이, 캠페인 정보를 제공한다. Aside로 한국어 페이지도 확인했다. [한국어 게임 페이지](https://ko.boardgamearena.com/gamepanel?game=thecrew).

다만 [한국어 게임 도움말 주소](https://ko.doc.boardgamearena.com/Gamehelpthecrew)는 브라우저 확인 시 ‘문서가 현재 존재하지 않습니다’로 표시됐다. 한국어 화면이 있다는 사실을 완성된 한국어 규칙 자료가 있다는 뜻으로 해석하지 않는다.

설계에 반영할 제안은 다음과 같다. BGA에서 이 모든 기능을 실제 조작해 검증했다는 뜻은 아니다.

- 통신 예약을 명시적인 단계로 만들고 카드 제출과 충돌하지 않게 한다.
- 미션 조건을 게임 화면에서 계속 확인할 수 있게 한다.
- 자동 응답은 초기에는 사용하지 않고, 모든 플레이어의 준비 상태를 보여준다.
- 카드 선선택 자동 제출은 후속 편의 기능으로 미룬다. 모바일에서는 선택 후 제출 확인을 기본으로 한다.
- ‘온라인/잠시 자리 비움’과 ‘게임 탈퇴’를 별개 상태로 표시한다.
- 전체 카드 이력을 보여주는 연습 기능은 기본 규칙 모드와 구분한다.

실제 BGA 초대 링크의 권한 모델, 장기 미접속 자리 보존, 기기 변경 시 복귀 절차는 확인하지 않았다. 본 프로젝트에서는 별도로 설계·시험한다.

## 4. sbp 가이드가 바꾸는 구현 계획

아래는 해당 플랫폼의 계약에 관한 확인이며, 일반 Supabase 제품의 한계와는 다르다.

| 항목 | 현재 계약 | 계획에 미치는 영향 |
| --- | --- | --- |
| 관리 주소 | `https://supabase.mystery-place.com` | 앱의 Supabase URL로 사용하지 않음 |
| 앱 주소·키 | 실제 프로젝트의 `api_url`과 제공받은 공개 키 | 프로젝트명으로 URL을 추측하지 않음. 현 UI는 legacy anon 키 |
| 프로젝트 생성 | sbp 생성 작업이 컨테이너·도메인 연결 수행 | 운영 작업마다 UUID·job·idempotency key 기록 |
| SQL | 제한된 단일 문장, public 테이블/인덱스/정책 등의 허용 범위 | 함수·트리거·private schema·원격 migration runner를 지원한다고 가정하지 않음 |
| Functions | 명령 도움말은 있으나 서버 어댑터 미지원 | 현재 CLI만으로 게임 Edge Function 배포 불가 |
| Realtime 관리 | 전용 CLI 미지원 | Realtime 런타임 자체의 부재를 뜻하지 않음. 정책·설정은 운영 경로 검증 필요 |
| Auth | 신규 프로젝트 가입/익명 로그인 기본 비활성, SMTP 미설정 | 초대→게스트 진입을 위한 환경 설정 필요 |
| 설정 변경 | SITE_URL, ADDITIONAL_REDIRECT_URLS, DISABLE_SIGNUP만 지원 | 익명 로그인·SMTP·OAuth 설정을 이 명령에 추가할 수 없음 |
| 백업 | 서비스를 멈추는 cold snapshot, restore는 격리 검증 | 게임 중 무중단 백업이나 운영 복구 기능으로 간주하지 않음 |

근거: [AI 가이드](https://github.com/sabyunrepo/supaconsole-sbp-cli/blob/bdad0f088c89f5ab28b67fd769bd3512b1f1e274/docs/AI-GUIDE.ko.md), [API 계약](https://github.com/sabyunrepo/supaconsole-sbp-cli/blob/bdad0f088c89f5ab28b67fd769bd3512b1f1e274/docs/cli-implementation/API-CONTRACT.md).

**권장 선행 작업:** 플랫폼 운영 경로로 프로젝트 전용 Edge Functions 배포·환경 변수·DB 마이그레이션을 제공받거나, 해당 관리 기능을 별도 플랫폼 작업으로 추가한다. 미지원 명령을 다른 엔드포인트로 우회하는 방식은 계획하지 않는다. Vercel로 백엔드를 옮기는 것은 사용자의 현재 범위를 바꾸므로 기본안으로 채택하지 않는다.

가이드에 기록된 생성 credential/runtime 정책 만료는 2026-09-09 15:00 KST다. 현재 유효성은 별도 확인이 필요하고, 문서가 갱신되었다는 이유로 연장되었다고 간주하지 않는다.

## 5. 공식 기술 문서와 적용 범위

- Supabase 익명 로그인은 사용자 식별자를 제공하지만, 로그아웃·브라우저 데이터 삭제·다른 기기에서는 같은 계정 접근을 자동 보장하지 않는다. 복구 수단을 따로 설계한다. [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous).
- Broadcast/Presence의 private 채널은 멤버십에 따른 `realtime.messages` 정책이 필요하다. 채널을 안다고 권한이 생기지 않도록 한다. [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization).
- 셀프호스팅 Functions는 서버의 함수 파일과 런타임 설정을 관리하는 배포가 필요하다. 공식 Cloud 함수 배포 경로와 혼동하지 않는다. [Self-Hosted Functions](https://supabase.com/docs/guides/self-hosting/self-hosted-functions).
- Vite SPA는 방 주소 직접 접속·새로고침을 위해 index.html rewrite 설정을 적용한다. [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite).

Changelog에서 게이트웨이 기본값 변경, Auth URL 변경, Realtime 스키마 제한을 확인했다. 이 정보를 근거로 기존 플랫폼 이미지를 업데이트하지 않는다. 설치 버전과 계약을 먼저 대조한다. [게이트웨이 변경](https://supabase.com/changelog/48048-self-hosted-supabase-envoy-becomes-the-default-api-gateway-b), [Auth URL 변경](https://supabase.com/changelog/47093-self-hosted-supabase-api-external-url-to-include-auth-v1), [Realtime 스키마 변경](https://supabase.com/changelog/realtime-schema-locked-down-against-modification).

## 6. 한국어·시각 자료

한국어 UI와 도움말은 직접 작성하고, 카드 그래픽·아이콘도 자체 제작하는 것을 기본으로 한다. 지휘관/트릭/임무/통신/구조 신호 등은 초기 작업 용어이며 공식 한국어판과 대조해 용어집을 확정한다. 원작 로고·삽화·공식 번역·항해일지 원문을 사용할 범위는 별도로 확인한다. BGA에 게재된 자료를 본 프로젝트의 재배포 허가로 해석하지 않는다.
