import { Orbit } from "lucide-react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel, suitOf, SUIT_META } from "../../../shared/cards.ts";

const resultTitle = {
  success: "임무 성공!",
  failure: "다시, 함께 도전해요.",
  campaign_complete: "탐사 완료!",
};

/**
 * 화면 중앙 트릭 영역. 좌석별로 낸 카드를 보여주고(나는 항상 마지막=하단),
 * 트릭 승자·성공·실패 배너도 같은 자리에서 이어서 보여준다. 다음 동작 버튼은
 * StatusBar의 주요 액션 자리에서 렌더링한다(중복 버튼 방지).
 */
export function TrickArea({
  snapshot,
  mineId,
}: {
  snapshot: Snapshot;
  mineId: string | undefined;
}) {
  if (snapshot.phase === "task_selection")
    // 기존 e2e 테스트는 ".table-surface"를 "트릭 단계 진입" 신호로 사용하므로
    // 임무 선택 대기 표시는 별도 클래스를 쓴다(재사용하지 않음).
    return (
      <div className="trick-waiting">
        <div className="table-orbit" />
        <Orbit size={30} />
        <p className="table-label">
          {snapshot.turnPlayerId === mineId
            ? "내 목표를 골라 주세요"
            : "임무 목표를 나누는 중입니다"}
        </p>
      </div>
    );
  const led = snapshot.trick[0]?.cardId;
  const seats = [...snapshot.players].sort((a, b) =>
    a.id === mineId ? 1 : b.id === mineId ? -1 : 0,
  );
  const result =
    snapshot.phase === "success" ||
    snapshot.phase === "failure" ||
    snapshot.phase === "campaign_complete"
      ? snapshot.phase
      : null;
  return (
    <div className="table-surface">
      <div className="table-orbit" />
      <p className="table-label">
        {snapshot.phase === "playing"
          ? led
            ? `${SUIT_META[suitOf(led)].color} 선도 · 같은 색이 있다면 따라 내세요`
            : "새로운 트릭 · 선도 대원의 카드를 기다려요"
          : snapshot.lastTrick
            ? `${snapshot.players.find((p) => p.id === snapshot.lastTrick!.winnerId)?.nickname} 대원 트릭 획득`
            : "탐사를 마쳤습니다"}
      </p>
      <div className="played-cards">
        {seats.map((p) => {
          const play = snapshot.trick.find((t) => t.playerId === p.id);
          return (
            <div className="played-slot" key={p.id}>
              <span
                className={p.id === snapshot.turnPlayerId ? "turn-label" : ""}
              >
                {p.nickname}
                {p.id === mineId ? " (나)" : ""}
              </span>
              {play ? (
                <div className="card">
                  <img
                    src={cardImage(play.cardId)}
                    alt={cardLabel(play.cardId)}
                    loading="lazy"
                    draggable={false}
                  />
                </div>
              ) : (
                <div
                  className={`card-placeholder ${p.id === snapshot.turnPlayerId ? "active" : ""}`}
                >
                  <Orbit size={22} />
                  <span>
                    {p.id === snapshot.turnPlayerId ? "플레이 차례" : "대기"}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {result && (
        <div className={`result-box ${result}`}>
          <h2>{resultTitle[result]}</h2>
          <p>{snapshot.resultReason}</p>
        </div>
      )}
    </div>
  );
}
