# Space Crew API v1

기계 판독 계약: [openapi.json](./openapi.json). 타입 및 검증 원본: [shared/contracts.ts](../shared/contracts.ts). 모든 경로는 프로젝트의 `/functions/v1/crew-api` 아래다.

현재 HTTP 골격만 준비되어 있다. `GET /capabilities`는 `backendReady: false`; 나머지 유효한 요청은 저장소 연결 전까지 `501 BACKEND_NOT_IMPLEMENTED`를 반환한다. 프론트 로컬 모드와 실제 서버의 구현 상태를 구분한다.

## 인증과 기본 형식

모든 API는 Supabase 익명/일반 로그인 후 받은 사용자 JWT를 `Authorization: Bearer <access_token>`에 보내고 공개 프로젝트 키를 `apikey` 헤더에 보낸다. 쓰기는 `Content-Type: application/json`. 응답은 `Cache-Control: no-store`. 게임의 actor는 JWT의 auth 사용자에서 `crew_private.players`로 매핑한다.

| HTTP | 경로 | 요청 | 응답 |
| --- | --- | --- | --- |
| GET | `/capabilities` | 없음 | API 버전, 서버 준비 여부, rulesetVersion, 50개 미션과 각 playable |
| POST | `/rooms` | commandId, nickname, settings | 201: 개인 snapshot, inviteToken |
| POST | `/rooms/join` | commandId, nickname, inviteToken | 기존 자리 복귀 또는 신규 자리 snapshot; inviteToken은 null 가능 |
| GET | `/rooms/{roomId}` | 없음 | 요청자 손패만 포함한 최신 snapshot |
| POST | `/rooms/{roomId}/commands` | 아래 명령 envelope | 행동 반영 snapshot |
| POST | `/rooms/{roomId}/invites` | commandId | 201: 새 inviteToken; 방장만 가능 |

초대 링크는 `/join#<token>`. fragment를 요청 본문으로 보내고 성공 후 URL에서 제거한다. 신규 초대 토큰은 최소 256비트 암호학적 난수로 만들고 DB `invites`에는 SHA-256 해시만 저장한다. 재전송용 응답에 토큰이 필요한 경우 private receipts의 접근/보존을 제한한다. 만료·회전은 신규 입장만 막으며 기존 멤버 snapshot 복귀는 토큰 없이 인증으로 처리한다.

## 방 설정

```json
{
  "commandId": "10000000-0000-4000-8000-000000000001",
  "nickname": "별빛",
  "settings": {
    "name": "우리의 첫 번째 탐사",
    "capacity": 3,
    "missionMode": "sequential",
    "startMission": 1
  }
}
```

capacity는 3/4/5. startMission은 1~50. random 모드에서는 startMission을 저장하되 추첨에 사용하지 않는다. random 후보는 서버가 실제 구현한 미션 중 해당 방에서 아직 추첨하지 않은 미션이다. start/retry 중 실패하거나 트랜잭션이 롤백되면 추첨 기록을 확정하지 않는다. 성공 후 next_mission에서만 다음 번호를 선택하며 실패/재접속에는 같은 번호를 유지한다.

## 명령

```json
{
  "commandId": "20000000-0000-4000-8000-000000000001",
  "expectedRevision": 12,
  "attemptId": "30000000-0000-4000-8000-000000000001",
  "command": { "type": "play_card", "cardId": "yellow-7" }
}
```

대기실의 attemptId는 null. mission 재시도는 새 attemptId를 발급한다. 모든 명령은 `commandId`를 새로 생성하며 네트워크 응답 불명 시 **본문 전체와 ID를 유지**해 재전송한다. 이미 확정된 명령의 재전송은 효과를 중복 적용하지 않는다. 재전송 응답은 최초 개인 응답 또는 더 최신의 개인 snapshot일 수 있으며 프론트는 더 낮은 revision으로 되돌아가지 않는다.

| command.type | 추가 필드 | 단계/권한 |
| --- | --- | --- |
| update_settings | settings | lobby / 방장, 인원 수보다 capacity 작게 변경 불가, 준비 상태 초기화 |
| set_ready | ready: boolean | lobby / 본인 |
| start_mission | 없음 | lobby / 방장, 좌석 충족 및 전원 준비, 지원 미션 |
| briefing_ready | 없음 | briefing / 본인 |
| choose_task | taskId: UUID | task_selection / 현재 차례, 미선택 목표 |
| communicate | cardId, marker: highest/lowest/only | playing / 트릭 시작 전, 임무당 1회, 일반 카드, 현재 손패 검증 |
| play_card | cardId | playing / 차례·소유·선도색 확인 |
| advance_trick | 없음 | trick_result / 방장 |
| retry_mission | 없음 | failure / 방장, 같은 미션 새 시도 |
| next_mission | 없음 | success / 방장, 순차 다음 번호 또는 미추첨 랜덤 |

미션 5~50 특수 명령(목표 양도/대원 지명/카드 교환 등)은 후속 명세 확장이 필요하다. 기존 명령으로 처리했다고 간주하지 않는다. 규칙 버전과 capabilities를 함께 갱신하고 진행 중 attempt에 갑자기 새 규칙을 적용하지 않는다.

## Snapshot의 공개 경계

snapshot은 roomId/revision/settings/phase/missionId/attemptId/시도 수/이미 추첨한 임무/플레이어 닉네임·좌석·남은 장수/공개 목표/교신/현재 트릭/직전 트릭/결과를 포함한다.

`me`에는 **현재 인증된 사용자의** playerId, hand, legalCardIds, canCommunicate만 담는다. 다른 사람의 손패, 분배 순서, 난수 seed, invite hash, 전체 이벤트 이력은 포함하지 않는다. 플레이한 카드의 공개 사실과 다른 사람의 남은 장수는 허용된다. `lastTrick`은 직전 트릭 하나만 제공한다.

로컬 데모의 localStorage에는 테스트용 전체 상태가 있다. 이 저장 방식을 실제 서버의 보안 구조로 사용하지 않는다. 운영 상태는 `crew_private.game_states`의 JSON 하나가 기준이며, 손패를 별도 중복 테이블에도 써서 두 기준을 만들지 않는다. 정규화한 rooms/members/attempt headers와 revision은 동일 트랜잭션에서 동기화한다.

## 서버 트랜잭션 구현 계약

`CrewRepository`의 각 변경 메서드는 아래 전체를 하나의 Postgres 트랜잭션으로 수행해야 한다. 여러 독립적인 Data API 호출을 이어 붙여 구현하지 않는다.

1. 검증한 auth UID를 players에 바인딩한다. 신규 players 생성도 unique(auth_user_id)와 UPSERT로 경쟁을 처리한다.
2. actor+commandId 기반 advisory transaction lock을 얻는다. 같은 ID의 동시 최초 요청을 직렬화한다. create/join/invite도 같은 규약을 사용한다. 잠금 순서는 항상 command lock → room row lock이다.
3. `command_receipts`를 확인한다. 동일 canonical 요청 해시면 이전 확정 효과를 재사용한다. 다른 본문이면 `409 IDEMPOTENCY_CONFLICT`. **중복 확인은 revision/attempt 검사보다 먼저** 수행한다.
4. room을 `SELECT … FOR UPDATE`로 잠근다. 멤버십·방장 권한·capacity·좌석·현재 단계·expectedRevision·attemptId를 검사한다. 미참여자의 조회도 거부한다.
5. authoritative state를 읽고 서버 엔진으로 행동을 판정한다. 분배/추첨은 서버에서 하고 결과를 저장한다. 브라우저가 보낸 손패/승자/난수를 신뢰하지 않는다.
6. game_states, rooms.revision 및 phase, members 준비, mission_attempts 결과, events, receipts를 함께 쓴다. 한 명령은 revision을 정확히 1 증가시킨다. 이벤트는 감사용이며 API로 전체 공개하지 않는다.
7. 멤버 입장 시 `room_subscriptions(room_id,user_id)`를 함께 만든다. `room_versions.revision`을 같은 revision으로 갱신한다. 주기적 presence heartbeat는 게임 revision으로 취급하지 않는다.
8. 요청자용 snapshot을 생성한 뒤 commit한다. 오류는 전체 rollback한다. 응답이 유실돼도 같은 commandId로 복구된다.

제공된 SQL은 테이블/권한 틀이다. 트랜잭션 함수, 상태 전이 트리거, 초대 만료/회전 정책, seat < capacity 교차 테이블 검사, canonical 요청 해시/서버 RNG/감사 보존/속도 제한은 저장소 구현에서 완료해야 한다. DB에 직접 insert만 하면 게임 규칙이 자동 보장되는 구조가 아니다.

## 동시성·오류·복귀

오류: `{ "error": { "code": "REVISION_CONFLICT", "message": "…", "requestId": "…", "currentRevision": 13 } }`.

- 400: 잘못된 입력, 카드/행동 필드 형식
- 401: 세션 누락/만료/유효하지 않은 JWT
- 403: 다른 방 접근, 방장 권한 없음, CORS Origin 거부
- 404: 방/초대 없음 (비멤버에게 방 정보 노출 최소화)
- 409: revision/attempt/idempotency 충돌 또는 현재 단계에서 불가능한 행동
- 413/415: 큰 본문/잘못된 Content-Type
- 422: 구현하지 않은 미션
- 429: 과도한 생성/초대/명령 (후속 저장소/게이트웨이 구현)
- 500/501: 내부 오류/저장소 미구현

409는 snapshot을 재조회하고 사용자가 최신 상태에서 다시 선택한다. 네트워크 오류/응답 불명/5xx에는 명령 본문을 보존해 재전송할 수 있다. DB 커밋 뒤 네트워크가 끊겼다는 이유로 새 commandId를 자동 발급하지 않는다.

Realtime 구독: `postgres_changes`, event `UPDATE`, schema `public`, table `room_versions`, filter `room_id=eq.<roomId>`. payload는 room_id/revision뿐이다. 알림 수신·재구독 완료·포커스 복귀 시 snapshot을 다시 읽는다. 누락에 대비해 화면이 보일 때 15초 폴링한다. 중복/역순 알림은 revision으로 무시한다. 전체 손패를 Realtime broadcast 또는 공개 채널에 보내지 않는다.

같은 브라우저의 Supabase 세션 갱신으로 기존 member를 찾는다. 새 닉네임이나 동일 닉네임은 자리를 되찾을 권한이 아니다. 저장소 삭제·기기 변경용 복구 코드는 별도 설계/구현 대상으로 남겨 둔다.
