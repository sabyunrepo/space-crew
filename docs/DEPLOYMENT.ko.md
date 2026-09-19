# 공개 서비스 운영

## 연결 및 배포 대상

- 공개 주소: https://crew.bsh00.com
- Cloudflare Tunnel → 홈 서버의 `coolify-proxy` → Coolify `space-crew` 애플리케이션 → Node 8080.
- 애플리케이션 UUID: `wwdeemugv7lqzozohddwtvlx`, 프로젝트 `space-crew`, 환경 `production`.
- 소스: `sabyunrepo/space-crew`, 브랜치 `feat/realtime-prototype`, Dockerfile 빌드, 배포할 커밋 SHA 지정.
- 프론트는 Coolify의 빌드 시점 변수로 모드를 정한다(2026-09-20부터 `VITE_BACKEND_MODE=supabase`). Dockerfile이 `VITE_BACKEND_MODE`·`VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY`·`VITE_SUPABASE_PROJECT_ID`를 `ARG`로 받는다.
- Supabase 모드에서 컨테이너의 Node 서버는 **정적 파일과 `/healthz`만 제공한다**. 게임 요청은 브라우저에서 `https://sb-spacecrew.bsh00.com`의 `crew-api` Edge Function으로 직접 간다. 컨테이너의 `/api`·`/ws`와 `/data` 볼륨은 남아 있지만 화면이 쓰지 않는다.
- 되돌리려면 `VITE_BACKEND_MODE=server`로 바꾸고 재배포한다. 그러면 `/data`의 기존 방이 다시 보인다.

## 저장 및 업데이트

- 영속 볼륨: `wwdeemugv7lqzozohddwtvlx-space-crew-data` → 컨테이너 `/data`.
- 업데이트 시 기존 볼륨, Cloudflare DNS/Tunnel, 호스트명을 유지한다. 로컬 개발용 `data/`로 운영 데이터를 덮어쓰지 않는다.
- 2026-09-14 업데이트 전 백업: 홈 서버 `/data/coolify/backups/space-crew/20260914-preupdate/` (방 데이터 압축본 및 기존 compose). 인증 정보와 손패를 포함할 수 있으므로 서버 내부 비공개로 보관한다.
- 현재 배포 SHA: `527e32f32bbd9133dffc318c855f84f5675e5a0a`. 직전 배포 SHA: `aa430654c36a86dda2d3d66f03e6f6e042332a6a`.
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

## 2026-09-14 교신 확인·준비 화면 수정

- `f829bce5995dfbad534268764a2326cb1d0a950a`, Coolify ID `bcba23da-216c-427b-85e1-b56e3ebc7ab9`, `finished`.
- Aside 로컬 PC/390×844 프레임 검수 후 배포했다. 공개 3인 독립 참가자 교신/재시작/새로고침 검증 통과.
- 백업: `/data/coolify/backups/space-crew/20260914-communication-ui/` (데이터·compose, 비공개 권한). 이후 본인 패널 이동 요청은 별도 후속 배포로 검증한다.

## 2026-09-14 본인 패널 하단 이동

- 런타임 커밋 `b631c7bdd2ddf74b9fa44950c96f3a940bfaf56f`, Coolify ID `1a6104d1-8112-43c5-b39b-e08dba4a93ce`, `finished`/새 컨테이너 healthy.
- Aside 로컬 PC 실제 카드 선택·제출, 모바일 390×844 프레임 하단 교신→확인→전송, 동일 높이/스크롤/잘림 검수 후 배포했다. UI 28개와 Node 3인 협동 시나리오 통과.
- 공개 `/healthz` 정상, `backendReady: true`, v4 유지. 공개 JS `index-BBLNx3hi.js`와 CSS `index-GtG4OHCE.css`가 로컬 빌드 SHA-256과 일치.
- 공개 3인 독립 브라우저 테스트 통과: 각 참가자의 본인 패널은 손패 왼쪽에 1개, 위쪽 패널은 다른 대원 2개, 교신·전원 동의 재시작·거절·새로고침 동기화 확인.
- 백업 `/data/coolify/backups/space-crew/20260914-own-seat/`. 배포 전 기존 방 15개 모두 파일 내용까지 동일하게 유지됐음을 확인했다. 검증은 새 방에서 수행했다.
- 기존 Cloudflare Tunnel/DNS/영속 볼륨을 유지했다. 검증 문서와 테스트 보강 커밋은 런타임 재배포 없이 별도로 저장한다.

## 2026-09-14 하단 패널 가독성 보완

- 런타임 `ee3df6efa804c82c997b046a0a162a34a44d6e0f`, Coolify ID `8fb966e1-2064-4e84-ac58-5bef2a4eeb2a`, `finished`.
- 본인 패널의 높이 기반 무제한 축소를 제거했다. 프로필 헤더+신호/목표 한 행, PC64px/모바일48px 카드 최소 폭, 좁은 화면 손패 위 가로 배치를 적용했다. 1189×779 하단 높이207px를 유지하면서 기존31px 카드를64px로 확대했다.
- Aside 로컬 PC 양 테마·내 차례·카드 선택/제출, 모바일390×844의 표시와 진행 검수 후 배포했다. 자동 UI28개, 단위753개 통과. Node3인 테스트는1189×779/2279×1426/390×844 조합에서도 통과했다.
- HTTPS health 정상, API backendReady true/v4 유지. 공개 JS `index-DXxf4oo-.js`, CSS `index-CMQEZE5-.css`가 로컬 빌드 SHA-256과 일치.
- 백업 `/data/coolify/backups/space-crew/20260914-readable-dock/`. 기존16개 방 모두 파일 내용까지 그대로 유지됐다.
- 공개 주소에서도 동일한 PC/대형/모바일3인 조합으로 교신·목표 정보·재시작 거절/전원 동의·새로고침 복귀 테스트 통과(28.4초). 검증은 새 방에서 수행했다. 테스트/문서 보강은 별도 커밋으로 저장하며 런타임 SHA는 위 값을 유지한다.

## 2026-09-14 신호 카드 교신 토글

- 런타임 `def2b1a924adc5a24d7d86a48a611e1318cbd693`, Coolify ID `f3699948-c16e-46b0-b87a-ce093a050378`, `finished`.
- 본인 신호 카드에서 교신 시작/취소를 토글한다. 활성 시 카드 문구와 접근 가능한 이름은 `교신 취소`로 바뀌며 별도 손패 취소 버튼은 제거했다.
- Aside 로컬 PC·390×844 모바일 프레임에서 직접 시작→취소를 확인한 후 배포했다. PC/모바일 교신4개(D 포함), 단위753개, 실제 Node3인 토글/교신/재시작 검사 통과.
- 공개 health 정상, backendReady true/v4 유지. JS `index-DoPc-QJA.js`, CSS `index-CMQEZE5-.css` SHA-256이 로컬 빌드와 일치.
- 백업 `/data/coolify/backups/space-crew/20260914-signal-toggle/`. 기존17개 방 모두 파일 내용까지 유지됐다.
- 공개 주소3인 테스트도 통과(28.8초): 같은 신호 카드로 시작→취소 시 리비전 불변, 다시 시작 후 교신 전송·다른 화면 반영·전원 동의 재시작·새로고침 확인. 검증은 새 방에서 수행했다.

## 2026-09-14 카드 상태·대원 영역 업데이트

- 런타임 `1a73e59d82b067f643f1d9e1157c7b9ad6e545a1`, Coolify ID `35c95c26-83f0-4ab2-a4ff-0e770cb5f35e`, 결과 `finished`/새 컨테이너 healthy.
- 완료 목표 명암 처리, 현재 우선 목표 강조, 상대 순서 토큰 방향 수정, 선도 카드 효과, 교신 상태 구분, 카드 숫자 중복 오버레이 제거를 적용했다.
- 상대 대원의 원형 프로필과 반응형 목표 배치, 좌석과 중앙 제출 카드 사이 연결선 및 영역 테두리를 적용했다. 교신 카드와 인접 목표 카드는 모든 화면 크기에서 같은 폭과 2:3 비율을 사용한다.
- 배포 전 Aside 로컬 상태 화면에서 교신/목표 카드가 `70.47×105.70px`로 동일함을 확인했다. PC·모바일 UI12개, 단위758개, 프론트/서버 빌드가 통과했다.
- 공개 `/healthz` 정상, `backendReady: true`, 규칙 버전 v4 유지. 공개 JS `index-DMdQTfeo.js`와 CSS `index-B7b2kfSj.css`의 SHA-256이 로컬 빌드와 일치한다.
- 공개 3인 독립 브라우저 테스트 통과: 마지막 목표 자동 배정, 카드 호버, 다른 대원 차례 교신과 시작/취소 토글, 참가자 간 반영, 전원 동의 재시작 및 새로고침 복귀를 확인했다.
- 백업 `/data/coolify/backups/space-crew/20260914-card-ui/`. 백업 당시 기존 방21개 중20개는 바이트 단위로 유지됐다. `54df9dd9-d040-475a-8458-b64b682c9bcf` 방은 서비스 중단 없이 실제 플레이가 이어져 리비전10→19로 진행됐으며 정상 저장되었다. 검증은 새 방에서 수행했다.

## 2026-09-14 모바일 테이블 가독성 업데이트

- 런타임 `8d0b8a748c2ccc746ed9e66a274527697cfac494`, Coolify ID `7e4cd829-6507-45b2-9ba8-fc48da3a242e`, 결과 `finished`/새 컨테이너 healthy.
- 700px 이하 플레이 화면에서는 상단 안내를 기본 1줄로 접고 필요할 때 펼친다. 접힌 상태에서도 `다음 트릭`처럼 진행에 필요한 주 액션은 유지한다.
- 중앙 트릭 카드를 모바일 2열·최대 3행으로 배치하고 손패 최소 폭을 62px, 본인 신호/목표 카드를 54px로 확보했다. Aside 390×844 검수에서 상단은 45px, 손패 카드는 `70.20×105.29px`, 중앙 대기 카드는 기존 `31.31×46.98px`에서 `48.80×73.20px`로 커졌고 전체 화면 높이 안에 유지됐다.
- 배포 전 단위 테스트 758개, PC·모바일 UI 회귀 20개, 타입 검사, 프론트/서버 빌드와 로컬 실제 Node 다인 협동 시나리오가 통과했다.
- 공개 `/healthz` 정상, `backendReady: true`, 규칙 버전 `crew-p9-50-4`와 미션 50개를 유지한다. 공개 JS `index-BOQ69ess.js`와 CSS `index-uuzd-eul.css`의 SHA-256이 로컬 빌드와 일치한다.
- 공개 주소의 독립 브라우저 다인 테스트도 통과했다. 마지막 목표 자동 배정, 카드 정보, 다른 대원 차례 교신, 전원 동의 재시작과 새로고침 복귀를 확인했다.
- 백업 `/data/coolify/backups/space-crew/20260914-mobile-ui/`. 배포 전 기존 방 23개가 모두 바이트 단위로 유지됐다. 기존 Cloudflare Tunnel, DNS와 영속 볼륨을 그대로 사용했다.

## 2026-09-14 작은 카드 축약형 업데이트

- 런타임 `87b37d9e4440ad8b95edde51805b421de5ad54b4`, Coolify ID `becaa8d3-e3e5-4710-a37f-280358fa2c1d`, 결과 `finished`/새 컨테이너 healthy.
- 테이블 카드의 실제 폭이56px 이하이면 일러스트 대신 카드 색 배경과 큰 숫자를 표시한다. 60px 이상에서는 기존 일러스트를 유지하며 중간 경계는 컨테이너 실제 폭으로 판정한다.
- 목표 순서 토큰, 완료/실패, 현재 우선 목표, 선도 효과, 교신 토큰과 접근 가능한 전체 카드 이름은 축약형에서도 유지한다.
- Aside 390×844 로컬 5인 검수에서 상대 목표40.63px, 중앙 카드48.80px, 본인 목표54px가 축약형으로 표시됐고 손패70.20px는 일러스트를 유지했다.
- 배포 전 단위758개, PC·모바일 UI22개, 타입 검사, 프론트/서버 빌드와 로컬 실제 Node 다인 시나리오가 통과했다. 공개 다인 교신·재시작·복귀 시나리오도 통과했다.
- 공개 `/healthz` 정상, `backendReady: true`, 규칙 버전 `crew-p9-50-4`, 미션50개를 유지한다. 공개 JS `index-CSLjIcDL.js`와 CSS `index-DRFWCQDs.css`가 로컬 빌드 SHA-256과 일치한다.
- 백업 `/data/coolify/backups/space-crew/20260914-compact-cards/`. 배포 전 기존 방24개가 모두 바이트 단위로 유지됐다.

## 2026-09-15 3인 테이블 비율 업데이트

- 런타임 `4614c82f6913cf9f854b2df395da0e8ad74f2aec`, Coolify ID `67320cd6-0b13-470b-a315-e3f5cb14f37d`, 결과 `finished`/새 컨테이너 healthy.
- 3인에서 상대 패널 크기를 줄이고 중앙 트릭의 세 제출 슬롯을 한 행으로 확대했다. Aside 390×844 실제 플레이에서 상대 패널은 105.4×109.8px(화면 폭 27.0%), 중앙 제출 카드는 107.7×161.6px였으며 한 장 제출 후에도 겹침과 페이지 스크롤이 없었다.
- 배포 전 단위758개, PC·모바일 UI22개, 타입 검사, 프론트/서버 빌드와 로컬 실제 Node 다인 협동 시나리오를 통과했다. 공개 주소에서도 교신·재시작·복귀 협동 시나리오가 통과했다.
- 공개 `/healthz` 정상, `backendReady: true`, 규칙 버전 `crew-p9-50-4`, 미션50개를 유지한다. 공개 JS `index-BSKv6MRX.js`와 CSS `index-BEeGaVGn.css`의 SHA-256이 로컬 빌드와 일치한다.
- 백업 `/data/coolify/backups/space-crew/20260915-three-player-layout/`. 배포 전 기존 방27개 중26개는 바이트 단위로 유지됐다. 진행 중이던 방 `a72ddc1f-87c4-4142-84b9-08f5455f7c77`은 서비스 중단 없이 리비전191→206, playing→preparation으로 정상 진행됐다. 공개 검증에서 만든 새 방은 별도다.

## 2026-09-15 적응형 중앙 트릭·5인 순서 표시 업데이트

- 최종 런타임 `527e32f32bbd9133dffc318c855f84f5675e5a0a`, Coolify ID `632fa87b-f139-40b4-93b3-ce4046bb7f31`, 결과 `finished`/새 컨테이너 healthy. 앞선 적응형 중앙 확대 커밋 `aa430654c36a86dda2d3d66f03e6f6e042332a6a`도 동일 날 중간 배포했으며 최종 배포가 이를 대체한다.
- 3·4·5인 PC/모바일에서 중앙 카드 최대 크기 배열을 선택하고 외곽을 좌우 대원 패널에서 2px 떨어진 경계까지 확장한다. 5인은 좌측 대원 25%·중앙 50%·우측 대원 25%이며, 중앙 슬롯은 선도자부터 실제 제출 순서대로 왼쪽→오른쪽에 표시한다. 대원 패널과 슬롯 사이 곡선 연결선은 제거했다.
- 미션 조건의 참가 대원 시각 목록, 반응형 글자 확대, 상대 순서 `›` 캡슐 토큰과 절대/Ω 구분을 적용했다. 완료 목표는 어두운 오버레이와 중앙 체크로 구분한다. 56px 이하 색·숫자 축약형은 모바일에만 적용하고 PC는 원본 카드 이미지를 유지한다.
- 배포 전 Aside 1440×900 실제 5인 플레이와 1470×956 3·4·5인 화면을 확인했다. 단위758개, 관련 PC·모바일 UI18개와 준비 UI6개, 타입 검사, 프론트/서버 빌드, 로컬 Node 협동 시나리오가 통과했다.
- 공개 `/healthz` 정상, `backendReady: true`, 규칙 `crew-p9-50-4`, 미션50개를 유지한다. 공개 JS `index-D2EEDcDd.js`와 CSS `index-DapLGcS0.css`의 SHA-256이 로컬 빌드와 일치한다. 공개 독립 브라우저 협동 시나리오와 실제 5명 참가자의 캐릭터·좌석·미션 진행 시나리오가 통과했다.
- 최종 배포 백업 `/data/coolify/backups/space-crew/20260915-five-player-trick/`. 배포 전 기존 방31개가 모두 바이트 단위로 유지됐다. 기존 Cloudflare Tunnel, DNS와 영속 볼륨을 그대로 사용했다.

## 2026-09-15 선도자 우선 트릭·상단 한 줄 업데이트

- 런타임 `c393f6c3921d8722214f7219e3148d8f1d6e6713`, Coolify ID `z7zl3cuahgyn4h9jdguvwy8r`, 결과 `finished`/새 컨테이너 healthy. 축약 커밋으로 요청한 첫 배포 `ujazfxh6mwi59jc2rz1rucw0`는 원격 ref 조회 단계에서 실패했고 기존 컨테이너에는 영향이 없었다.
- 좌석 방향 CSS가 순차 배치를 덮어쓰던 우선순위를 수정해 3·4·5인 모두 선도자부터 실제 제출 순서대로 왼쪽에서 표시한다. PC에서는 상태 문구와 미션 번호·시도·트릭·진행률·조건 버튼을 한 행에 배치해 테이블 세로 공간을 늘렸다.
- 카드 확대 정보에도 상대 순서 `›`, 절대 순번 숫자, `Ω` 토큰을 38px 이상의 별도 배지로 함께 표시한다.
- 배포 전 Aside 로컬 3인 실제 화면에서 슬롯 x좌표 `330 → 597 → 865`, 상단 높이53px를 확인했다. 단위758개, 관련 PC·모바일 UI30개, 타입 검사, 프론트/서버 빌드와 실제 Node 다인 시나리오20개가 통과했다.
- 공개 1189×779 스모크 검증에서 슬롯이 `코멧 → 요시 · 나 → 루나`, x좌표 `290 → 499 → 707`, 상단 높이53px·상태/미션 중앙선 차이0px로 확인됐다. 공개 JS `index-CsQAirAR.js`와 CSS `index-CPiz4Fgo.css`의 SHA-256이 서버 모드 로컬 빌드와 일치하고 `/healthz`, `backendReady: true`, 규칙 `crew-p9-50-4`, 미션50개를 유지한다.
- 백업 `/data/coolify/backups/space-crew/20260915-trick-order-status/`. 배포 전 기존 방35개의 체크섬이 배포 후 모두 일치했고, 공개 검증용 새 방2개를 포함해 현재37개다. 기존 Cloudflare Tunnel, DNS와 영속 볼륨을 그대로 사용했다.

## 2026-09-16 상대 순서 토큰 선택 화면 보완

- 런타임 `0f54471ee08bc5e2dea62abf47ace6330cc661ac`, Coolify ID `tdan11lzsoja0fwksdqe2ne2`, 결과 `finished`.
- 목표 선택 모달의 상대 순서 배지를 카드 바깥 모서리에서 카드 안쪽으로 옮겼다. 작은 화면이나 촘촘한 목표 그리드에서 첫 `›` 토큰이 잘리거나 인접 요소에 묻을 수 있던 원인을 없앴고, 카드 접근 가능한 이름에도 `상대 순서 N`을 포함했다.
- 상대 순서 미션 6·14·22·25·30·35·39·45·49를 PC·모바일에서 전수 검사한다. 각 토큰의 `›` 텍스트, 불투명도, `display:grid`, 카드 경계 안 배치를 회귀 테스트로 고정했다.
- 배포 전 단위758개, 타입 검사, 프론트/서버 빌드, 목표 선택 UI26개와 실제 Node 다인 서버 시나리오20개가 통과했다. Aside 로컬 미션49에서 `› / ›› / ›››`가 모두 카드 내부에 표시되는 것을 확인했다.
- 백업 `/data/coolify/backups/space-crew/20260916-relative-token-fix/`에 배포 전 방 JSON40개와 SHA-256 체크섬을 저장했다. 공개 `/healthz`와 capabilities는 정상(`backendReady:true`, `crew-p9-50-4`, 미션50개)이며, 공개 CSS `index-4j7oYP-D.css`는 로컬과 SHA-256이 일치했다. 새 검증 방에서 WSS 인증 뒤 revision 수신도 확인했다.

## 2026-09-16 오류 토스트·동시 선택 보완

- 런타임 `b667e8756c13ba78a22329e303a3f07db56821a9`, Coolify 배포 ID `48cd3753-6a63-4e02-9e90-e9bd73cfe182`, 결과 `finished`/새 컨테이너 healthy. 앞선 기능 배포 `d742b2a6e04c9ce92e26945375440951b443483e`와 초기 오류 토스트 보완 `de9428474e4854de973b7596866641434faff2af`도 각각 완료했으며 이번 런타임은 시작 시 토스트 순번 안정화까지 포함한다.
- 네트워크·초대·명령 처리 오류를 고정 오류 영역 대신 최대 3개 토스트로 표시한다. 오류 토스트는 1초 후 자동으로 사라지고, 아직 안전하게 재전송할 수 있는 요청에는 같은 토스트 안에 `재전송` 동작을 제공한다. 기존 성공 상태 안내는 유지했다.
- 선택 명령이 최신 리비전과 충돌하면 최신 snapshot을 먼저 반영한다. 차례·대상 소유권·준비 단계가 여전히 유효한 `choose_task`, `select_crew`, `assign_task`만 새 command ID로 한 번 자동 재시도하며, 이미 다른 대원이 선점한 선택은 중복 실행하지 않고 최신 상태 갱신 안내를 토스트한다. 서버의 리비전 검사와 room lock은 그대로 유지한다.
- 로컬 검증: `npm run typecheck`, 단위 테스트 758개, 프로덕션 빌드, 독립 브라우저 경계 테스트(PC/모바일 오류 토스트 표시·자동 소거)와 준비 모달 UI 26개가 통과했다.
- 공개 검증: `/healthz` 정상, `backendReady:true`, 규칙 `crew-p9-50-4`, 미션 50개. 공개 CSS에 `toast-viewport`/`toast-error`가 포함되고 JS에 충돌 갱신·재전송 문구가 포함됨을 확인했다.
- 배포 전 운영 방 44개를 `/data/coolify/backups/space-crew/20260916-toast-final/rooms.tgz`와 SHA-256 목록으로 백업했다. 앞선 기능 배포 백업은 `/data/coolify/backups/space-crew/20260916-toast-conflict/`, `/data/coolify/backups/space-crew/20260916-toast-init/`에도 보관되어 있다. 첫 시도 `5d8915a4-ba66-4404-9d95-5a2e3c4e75a7`는 Coolify 로컬 배포 키가 호스트 `root` 허용 키와 달라 공개키 인증에서 중단됐으며 컨테이너·운영 데이터에는 영향을 주지 않았다. 기존 허용 키를 보존한 채 Coolify 키의 공개키를 추가한 뒤 재배포를 완료했다.
- 프로젝트 체크아웃은 `coolify:/home/ubuntu/space-crew`에 `feat/realtime-prototype` 최신 커밋으로 동기화했다. 로컬 SSH에는 `Host coolify`(211.184.227.96:10022, `~/Downloads/kt.pem`) 별칭과 known_hosts 항목을 등록했다. 기존 Cloudflare Tunnel, DNS, 영속 볼륨은 그대로 사용했다.

## 2026-09-16 목표 선택 모달·대기방 반응형 업데이트

- 런타임 `0014bba7497bd2e70e7631ae98d2f3803f2a22c0`, Coolify 배포 ID `b39d0547-6b09-4509-9a6c-efd7c2d02a57`, 결과 `finished`/새 컨테이너 healthy.
- 목표 선택 모달을 최대 `760px`/`82dvh`까지 확대하고 상단 기준으로 배치해 손패 영역과 겹치는 면적을 줄였다. 모바일은 화면 양옆 8px 여백과 `78dvh`를 사용하며 내용은 모달 내부에서만 스크롤한다.
- 접속 전 대기방을 `100dvh`에서 헤더를 제외한 높이로 맞추고, 대기방 테이블·중앙 선택 영역·대원 패널을 화면 안에 고정했다. 작은 화면에서는 대원 패널과 중앙 대기 영역만 내부 스크롤하며 전체 페이지가 불필요하게 이동하지 않는다.
- 로컬 Aside 1440×900에서 모달 `760×738px`, 대기방 문서 높이 `900px`를 확인했다. 단위 테스트 758개, 타입 검사, 프론트 빌드, 모달·플로우·준비 UI E2E 36개가 통과했다.
- 공개 `/healthz` 정상, `backendReady:true`, 규칙 `crew-p9-50-4`, 미션 50개. 공개 CSS에서 모달·대기방 반응형 규칙을 확인했다.
- 배포 전 방 44개를 `/data/coolify/backups/space-crew/20260916-modal-lobby/rooms.tgz`와 SHA-256 목록으로 백업했다. 기존 Cloudflare Tunnel, DNS와 영속 볼륨은 그대로 사용했다.

## 2026-09-16 Coolify CLI·GitHub 자동 배포 연결 검증

- Coolify CLI `1.8.0`에 `coolify` 컨텍스트(`https://coolify.bsh00.com`)를 등록하고 `context verify`, `resource list`, `app get`을 성공시켰다. CLI 토큰은 로컬 `~/.config/coolify/config.json`에 권한 제한 파일로 보관하며 원문은 저장소에 기록하지 않는다.
- `space-crew` 앱은 `feat/realtime-prototype` 브랜치, `is_auto_deploy_enabled=true`, 고정 커밋 없음으로 설정했다. 따라서 webhook이 전달되면 해당 브랜치의 push SHA를 그대로 배포한다.
- GitHub 저장소 webhook은 Push 이벤트와 `https://coolify.bsh00.com/webhooks/source/github/events/manual` 주소로 등록했다. Coolify 수동 webhook의 secret은 애플리케이션 전용 값을 사용하며 문서에는 기록하지 않는다.
- GitHub ping과 push delivery가 모두 HTTP 200으로 도착했고, 이 문서 커밋 push가 Coolify 배포 ID `fdlpnmta8lo8b1g009clh7nn`으로 자동 큐잉되어 `finished`/healthy까지 확인됐다.

## 2026-09-16 대원 퇴장·대체 입장 업데이트

- 배포 커밋 `b7986d48d2d5ee089aa45c298faed0faa35a4f5c`, Coolify 배포 ID `rmkbtysuicc4tbvijh4cocze`, 결과 `finished`/healthy.
- `POST /api/rooms/{roomId}/leave`와 진행 중 대체 입장을 추가했다. 진행 중 대원이 나가면 남은 인원이 3명 이상일 때 같은 미션의 새 시도를 원자적으로 시작하고, 3명 미만이면 대기실로 되돌린다. 새 대원은 `waitingPlayers`로 대기하며 방장이 즉시 재시작 또는 현재 미션 후 합류를 선택한다. 마지막 한 명의 퇴장은 방을 고아 상태로 만들지 않도록 거부한다.
- 로컬 Aside에서 대기실·방 나가기 UI를 조작했고, 로컬 단위 테스트 759개·타입 검사·프론트/서버 빌드를 통과했다. 공개 HTTPS API에서도 4인 방 생성→진행 시작→퇴장→대체 입장→방장 즉시 재시작을 검증했다(검증 방 `f65b7ba4-ec1c-4cdc-8467-9f496d6af76e`).
- 배포 전 운영 볼륨 백업은 `/data/coolify/backups/space-crew/20260916-crew-replacement/rooms.tgz` 및 `SHA256SUMS`에 보관했다. 기존 Cloudflare Tunnel, DNS와 영속 볼륨은 유지했다.

## 2026-09-16 게임 헤더·상태 바 계층 정리 업데이트

- 배포 커밋 `068b95d31c0c7af67af549480819adae8f5b0781`, Coolify 배포 ID `b8fo2cpsalhmzx8glsz9pm1i`, 결과 `finished`/healthy.
- 게임 화면의 글로벌 헤더는 전체 화면 폭을 사용하고 브랜드·테마·가이드·카드 도감만 남겨 높이를 줄였다. `실시간 서버` 모드 표시는 게임 상태 바의 연결 칩으로 통합해 같은 정보를 중복 표시하지 않는다.
- 상태 바는 좌측 복귀, 중앙 탐사 제목·현재 메시지·미션 요약, 우측 연결·초대·재시작·주 액션·방 나가기 순서로 정렬했다. 1280px 이하 중간 폭에서는 보조 버튼 텍스트를 아이콘으로 축약하고, 760px 이하에서는 상태와 액션을 두 줄로 배치해 테이블 영역을 보호한다.
- `StatusBar`의 방 나가기·재시작 버튼에 아이콘과 접근 가능한 텍스트 레이블을 추가하고, 연결 상태를 경계가 있는 칩으로 표시했다. 미션 조건은 기존 버튼으로 열어 상세 정보를 모달에서 확인한다.
- 배포 전 로컬 Aside에서 실제 방 생성→데모 대원 채우기→준비→임무 시작 흐름을 조작했다. 게임 헤더가 전체 폭 `1440px`, 상태 바 `1418px`, 상태 중앙 영역 `723px`, 액션 영역 `560px`로 계산되고 글로벌 모드 태그가 게임 화면에서 숨겨지는 것을 확인했다. 모바일 규칙은 760px 이하 미디어 쿼리에서 상태 바 2행·아이콘 축약·가로 액션 스크롤로 검증했다.
- `npm run typecheck`, 단위 테스트 759개, `npm run build`, `npm run build:server`, `git diff --check`가 모두 통과했다. 공개 `/healthz`와 `/api/capabilities`가 정상이며 `backendReady:true`, 규칙 `crew-p9-50-4`, 미션 50개를 유지한다. 공개 HTML의 JS/CSS 자산도 최신 빌드 해시로 제공된다.
- 배포 전 운영 방은 `/data/coolify/backups/space-crew/20260916-header-layout/rooms.tgz` 및 `SHA256SUMS`로 백업했다. 기존 Cloudflare Tunnel, DNS와 영속 볼륨은 유지했다.

## 2026-09-20 Supabase 모드 전환

- 전환 대상: 같은 앱·도메인·터널·볼륨을 유지하고 프론트 빌드 모드만 `supabase`로 바꿨다.
- 백엔드: sbp 프로젝트 `spacecrew`(`https://sb-spacecrew.bsh00.com`), 함수 `crew-api`, 표 `public.crew_*`, 익명 로그인, private Broadcast `own-user-v1`. 허용 출처 시크릿 `APP_CREW_ALLOWED_ORIGINS`에 `https://crew.bsh00.com`이 포함돼 있다.
- Coolify 빌드 시점 변수 4개를 등록했다(값은 문서에 적지 않는다).
- 전환 전 방 데이터 백업: 홈/KT Coolify 호스트 `/data/coolify/backups/space-crew/20260920-presupabase/rooms.tgz` (48개 방, sha256 기록). 사용자 결정으로 기존 방은 이어가지 않는다.
- 사전 검증: 단위 768개, Supabase 모드 다인 E2E 19개(실제 `spacecrew` 프로젝트), Node 서버 모드 회귀 19개, Aside 로컬 조작(방 생성·초대 복사·새로고침 복귀·콘솔 오류 0).
- 배포 후 확인 항목: `/healthz`, 헤더의 `SUPABASE` 표시, 방 생성과 초대 링크 다인 입장, 새로고침 복귀, 그리고 `E2E_BASE_URL=https://crew.bsh00.com`으로 돌린 다인 E2E.
