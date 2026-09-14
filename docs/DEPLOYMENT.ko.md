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
- 직전 배포 SHA: `90a2358ec063bf6aae77f8d3694ae7f5394e8924`.
- 새 배포 전 `npm test`, `VITE_BACKEND_MODE=server npm run build`, `npm run build:server`를 실행한다. 해당 브랜치에 소스를 반영한 뒤 Coolify의 커밋 SHA를 지정해 배포한다.
- 배포 후 `/healthz`, `/api/capabilities`, 프론트 자산, 초대 링크를 통한 다인 플레이와 WebSocket 동기화/새로고침 복귀를 확인한다.
- 롤백은 Coolify에서 직전 SHA를 지정해 배포한다. 새 버전에서 만든 방의 구버전 호환성을 검토하고, 데이터 복구는 필요한 경우에만 별도 수행한다.

## 가용성

홈 서버와 Cloudflare Tunnel이 실행 중이어야 접속 가능하다. 개발 중인 맥북의 localhost 서버와는 별개다. 배포 시 WebSocket이 다시 연결될 수 있으며, 동일 브라우저·도메인의 저장된 참가 인증으로 기존 방에 복귀한다.
