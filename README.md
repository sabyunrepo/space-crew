# 스페이스 크루 한국어 웹

The Crew: The Quest for Planet Nine을 PC·모바일용 한국어 프론트와 셀프호스팅 Supabase 연동 계약을 준비한 프로젝트입니다.

- [구현 계획](docs/PLAN.ko.md): 구조, 초대·복귀, 서버 판정, 데이터, 화면, 개발 단계와 완료 기준
- [조사 결과](docs/RESEARCH.ko.md): 게임 규칙과 BGA 참고 자료, sbp 제약, 출처와 미검증 사항
- [50개 미션 조건](docs/MISSIONS.ko.md): 목표 수·순서 토큰·통신·특수 조건의 전수 대조표
- [최종 카드 v3 미리보기](assets/cards/deck/v3/index.html): 스폰지밥7번까지 포함한 앞면40장과 공통 뒷면1장 완성
- [최종 카드 v3 다운로드 ZIP](assets/cards/deck/cards-v3.zip) · [카드 목록](assets/cards/deck/v3/cards.csv)
- [이전 검수본·수정 전후 비교](assets/cards/deck/reviewed/index.html)
- [숫자별 장면 계획](docs/card-design/SCENE-PLAN.ko.md) · [검수 및 재생성 기록](docs/card-design/REVIEW.ko.md)

## 실행

```sh
npm ci
npm run dev
```

`http://localhost:5173` — 기본은 서버 없이 실행되는 로컬 데모입니다. Node 22.12 이상 LTS 또는 24 LTS를 권장합니다.

한국어 반응형 화면, 방 생성, 미션 1~50 시작 번호/랜덤 선택, 목표 선택, 교신, 카드 플레이, 성공/실패, 새로고침 복귀를 구현했습니다. 실제 데모 규칙은 미션 **1~4**이며 나머지는 조건 열람 및 방 설정만 가능합니다. 랜덤은 구현된 미션에서 중복 없이 선택하고 실패/복귀 시 같은 번호를 유지합니다.

다른 기기와의 실시간 플레이는 후속 서버 구현이 필요합니다. Supabase 어댑터·SQL migration·Edge Function 골격을 준비했으며, 골격의 DB 작업은 미구현 상태를 `501`로 알립니다. 원격 배포/DB 변경은 하지 않았습니다.

- [프론트 실행·Supabase 연동 인계](docs/FRONTEND-HANDOFF.ko.md)
- [API 및 트랜잭션 명세](docs/API.ko.md) · [OpenAPI 3.1](docs/openapi.json)
- [DB migration](supabase/migrations/20260909044625_crew_contract_v1.sql)
- [Edge Function 진입점](supabase/functions/crew-api/index.ts)

검증: `npm run build`, `npm test`, `npm run test:e2e` (최초 `npx playwright install chromium`).

실제 브라우저 재검증: [Aside·Playwright 다인 접속 및 데모 플레이 검증 결과](docs/QA-MULTIPLAYER.ko.md). 로컬 게임 흐름은 통과했으나 독립 사용자 멀티플레이는 서버 미연동으로 아직 불가능합니다.
