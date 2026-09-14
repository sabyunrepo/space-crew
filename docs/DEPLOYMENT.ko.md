# 공개 서비스 운영

## 연결 및 배포 대상

- 공개 주소: https://crew.bsh00.com
- Cloudflare Tunnel → 홈 서버의 `coolify-proxy` → Coolify `space-crew` 애플리케이션 → Node 8080.
- 애플리케이션 UUID: `wwdeemugv7lqzozohddwtvlx`, 프로젝트 `space-crew`, 환경 `production`.
- 소스: `sabyunrepo/space-crew`, 브랜치 `feat/realtime-prototype`, Dockerfile 빌드, 배포할 커밋 SHA 지정.
- 프론트는 `VITE_BACKEND_MODE=server`로 빌드한다. REST `/api`와 WebSocket `/ws`는 같은 호스트를 사용한다.
- 이 배포는 Node 저장소를 사용한다. Supabase DB/Edge Function 완성을 의미하지 않는다.

## 저장 및 업데이트

- 영속 볼륨: `wwdeemugv7lqzozohddwtvlx-space-crew-data` → 컨테이너 `/data`.
- 업데이트 시 기존 볼륨, Cloudflare DNS/Tunnel, 호스트명을 유지한다. 로컬 개발용 `data/`로 운영 데이터를 덮어쓰지 않는다.
- 2026-09-14 업데이트 전 백업: 홈 서버 `/data/coolify/backups/space-crew/20260914-preupdate/` (방 데이터 압축본 및 기존 compose). 인증 정보와 손패를 포함할 수 있으므로 서버 내부 비공개로 보관한다.
- 현재 배포 SHA: `53fbc1e0edfa641561ad61883b63d25c52a3dbd9`. 직전 배포 SHA: `ab724fe8b08c2c34471406babaf0bf719d70bc78`.
- 새 배포 전 `npm test`, `VITE_BACKEND_MODE=server npm run build`, `npm run build:server`를 실행한다. 해당 브랜치에 소스를 반영한 뒤 Coolify의 커밋 SHA를 지정해 배포한다.
- 배포 후 `/healthz`, `/api/capabilities`, 프론트 자산, 초대 링크를 통한 다인 플레이와 WebSocket 동기화/새로고침 복귀를 확인한다.
- 롤백은 Coolify에서 직전 SHA를 지정해 배포한다. 새 버전에서 만든 방의 구버전 호환성을 검토하고, 데이터 복구는 필요한 경우에만 별도 수행한다.

## 가용성

홈 서버와 Cloudflare Tunnel이 실행 중이어야 접속 가능하다. 개발 중인 맥북의 localhost 서버와는 별개다. 배포 시 WebSocket이 다시 연결될 수 있으며, 동일 브라우저·도메인의 저장된 참가 인증으로 기존 방에 복귀한다.

## 2026-09-14 업데이트 결과

- 배포 커밋: `ab724fe8b08c2c34471406babaf0bf719d70bc78` (애플리케이션 소스 고정).
- Coolify 배포 ID: `edb777d1-deac-4f5d-b16e-c057e668af65`, 결과 `finished`, 컨테이너 `healthy`.
- 공개 API: `backendReady: true`, `rulesetVersion: crew-p9-50-3`, 미션 50개.
- 배포 전 자동 테스트 742개, 프론트/서버 빌드 통과. 기존 방 3개의 참가자 9명 snapshot을 새 계약으로 읽는 호환성 확인.
- 공개 HTTPS 주소에 Playwright의 독립 브라우저 컨텍스트를 연결해 3·4·5인 테스트 3개 통과(2.5분). PC 1440×900 및 모바일 390×844, 초대 링크 입장, 캐릭터/좌석, 목표 선택, 카드 제출, 종료 결과, 새로고침 복귀를 검증했다. 3인 테스트는 다른 대원 화면의 WebSocket 반영과 손패 비공개를, 4·5인 테스트는 종료 모달과 재도전/다음 임무 흐름까지 검증했다.
- 라이트/다크 전환·새로고침 후 설정 유지 확인, 브라우저 JS 오류 없음. 테마 초기화 스크립트·콜드·요시·스폰지밥 7번 자산의 공개 응답을 로컬 빌드 SHA-256과 비교해 일치 확인.
- 기존 운영 방 파일 3개가 백업과 동일하게 유지됨을 확인. 공개 검증은 새 방에서만 수행했다.
- DNS, 기존 터널, 영속 볼륨은 유지했다. 전환 중 일시적인 502 응답이 관측되었고 완료 후 HTTPS/API 및 다인 테스트는 정상 응답했다.
- Aside 브라우저 에이전트는 연결된 프로필이 없어 실행하지 못했으며, 배포 확인은 기존 SSH/Coolify 런타임과 Playwright로 수행했다.

## 이후 배포의 필수 순서 (사용자 요청)

1. 로컬 빌드·필요한 자동 테스트를 수행한다.
2. **Aside로 로컬 화면을 실제 조작**하여 변경한 흐름과 PC·모바일 표시를 확인한다.
3. 발견한 문제를 수정하고 로컬에서 재검증한다.
4. 검증 완료 후 기존 데이터 백업, 지정 커밋 배포, 공개 주소 확인을 진행한다.

Aside 연결이 안 되면 먼저 복구하고, 해결되지 않는 경우 상황을 알린다. Playwright만으로 Aside 단계를 대체해 배포하지 않는다. 이 요청 전에 시작한 `53fbc1e` 배포는 기존 진행 작업으로 완료한다.

## 2026-09-14 협동 조작·가독성 업데이트 v4

- 배포 커밋 `53fbc1e0edfa641561ad61883b63d25c52a3dbd9`, 배포 ID `b6ef6beb-cdf6-4f5a-a3a7-dfac65da3e0d`, 결과 `finished`.
- API `crew-p9-50-4`, 공개 JS/CSS SHA-256이 로컬 빌드와 일치. localhost:8080도 같은 서버 빌드로 재시작했다.
- 목표 카드 확대, 상단 안내 축소/조건 상세 창, 토큰 카드 선택·교환 미리보기와 원자적 확정, 마지막 목표 자동 배정, 카드 호버 정보, 다른 대원 차례 중 교신, 전원 동의 재시작, 목표 색상 분산을 적용했다.
- 자동 테스트 753개, PC·모바일 UI 22개, 로컬 실제 Node 23·40번 및 협동 조작 E2E 3개 통과.
- 공개 주소에서 40번 3인 준비·플레이와 협동 조작(마지막 목표, 호버, 트릭 중 교신, 재시작 거절/전원 동의/새로고침)을 통과했다. 전환 직후 최초 23번 방 생성에서 502가 1회 관측되어 중단됐고, 배포 완료 후 23번 4인 테스트를 재실행해 통과했다.
- 운영 백업 `/data/coolify/backups/space-crew/20260914-v4/`; 업데이트 전 방 8개 모두 파일 내용까지 동일하게 유지됨을 확인했다. 검증은 새 방에서 수행했다.
- 교신 타이밍과 목표 분산은 사용자 지정 변형이다. 기존 판의 목표는 바꾸지 않으며 새 시도부터 적용한다. 이후 배포는 위 Aside 로컬 검증 정책을 반드시 따른다.
