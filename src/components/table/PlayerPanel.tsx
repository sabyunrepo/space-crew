import { Check, Radio } from "lucide-react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { characterFor, characterImage } from "../../../shared/characters.ts";
import { cardLabel } from "../../../shared/cards.ts";

const markers = {
  highest: "이 색 중 가장 높음",
  lowest: "이 색 중 가장 낮음",
  only: "이 색은 이 카드뿐",
  hidden: "정보 축소 · 표시 비공개",
};

/**
 * 탑승 대원 목록. 데스크톱은 우측 세로 열, 모바일은 상단 가로 칩 스트립으로
 * CSS만으로 재배치된다(마크업은 동일).
 */
export function PlayerPanel({
  snapshot,
  mineId,
  onViewPlayer,
}: {
  snapshot: Snapshot;
  mineId: string | undefined;
  onViewPlayer?: (playerId: string) => void;
}) {
  return (
    <aside className="crew-panel" aria-label="탑승 대원">
      <div className="panel-heading">
        <h3>탑승 대원</h3>
        <span>CREW</span>
      </div>
      {Array.from({ length: snapshot.settings.capacity }, (_, i) => {
        const p = snapshot.players[i];
        return (
          <div
            key={i}
            className={`crew-member ${p?.id === snapshot.turnPlayerId ? "on-turn" : ""} ${p && onViewPlayer ? "crew-member--viewable" : ""}`}
            onClick={p && onViewPlayer ? () => onViewPlayer(p.id) : undefined}
            onKeyDown={p && onViewPlayer ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onViewPlayer(p.id); } } : undefined}
            tabIndex={p && onViewPlayer ? 0 : undefined}
            role={p && onViewPlayer ? "button" : undefined}
          >
            <div className={`avatar avatar-${i}`}>
              {p ? <img src={characterImage(p.characterId)} alt={characterFor(p.characterId).name} /> : "+"}
            </div>
            <div className="member-details">
              <strong>
                {p?.nickname || "대원을 기다려요"}
                {p?.id === mineId && <small>나</small>}
                {p?.id === snapshot.commanderId && <span title="사령관"> ★</span>}
              </strong>
              <span>
                {p
                  ? snapshot.phase === "lobby"
                    ? p.ready
                      ? "탑승 준비 완료"
                      : "준비 중"
                    : snapshot.phase === "briefing"
                      ? `${p.cardCount}장 · ${p.briefingReady ? "브리핑 확인 완료" : "브리핑 확인 중"}`
                      : `${p.cardCount}장 · ${p.tricksWon}트릭 획득`
                  : "빈 좌석"}
              </span>
              {p?.communication && (
                <div className="communication">
                  <Radio size={12} />
                  {cardLabel(p.communication.cardId)}
                  <small>
                    {markers[p.communication.marker]}
                    {p.communication.played ? " · 사용함" : ""}
                  </small>
                </div>
              )}
            </div>
            {p?.isDemo && <span className="bot-tag">DEMO</span>}
            {p?.ready && snapshot.phase === "lobby" && <Check size={16} />}
          </div>
        );
      })}
    </aside>
  );
}
