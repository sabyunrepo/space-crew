import { useEffect, useRef, useState } from "react";
import type { CardId } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";
import { isTurnBlocked, type CardAvailability } from "./cardRules.ts";

/**
 * 내 손패. 카드 수에 따라 겹침 폭을 동적으로 계산해 5장이든 14장이든
 * 가로 스크롤 없이 한 줄에 담는다(overlap = max(0, (cardWidth*n - availableWidth) / (n-1))).
 * 규칙상 낼 수 없는 카드는 card--illegal(회색+선택 불가), 내 차례가 아니라 막힌
 * 카드는 card--waiting(회색 없이 선택만 불가)으로 구분한다.
 */
export function Hand({
  cards,
  selected,
  onSelect,
  onBlocked,
}: {
  cards: CardAvailability[];
  selected: CardId | null;
  onSelect(cardId: CardId): void;
  /** 낼 수 없는 카드를 탭했을 때 이유를 전달한다(모바일 안내 줄용, hover title의 보완). */
  onBlocked?(reason: string): void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState(0);
  const count = cards.length;
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const recalc = () => {
      const first = track.querySelector<HTMLElement>(".hand-card");
      if (!first || count < 2) {
        setOverlap(0);
        return;
      }
      const cardWidth = first.getBoundingClientRect().width;
      const available = track.clientWidth;
      const next = Math.max(0, (cardWidth * count - available) / (count - 1));
      setOverlap(next);
    };
    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(track);
    return () => observer.disconnect();
  }, [count]);
  return (
    <div className="hand-cards" ref={trackRef}>
      {cards.map(({ cardId, enabled, reason }, i) => {
        const isSelected = selected === cardId;
        const waiting = !enabled && isTurnBlocked(reason);
        const illegal = !enabled && !waiting;
        return (
          <button
            key={cardId}
            type="button"
            className={[
              "card",
              "hand-card",
              isSelected ? "selected" : "",
              waiting ? "card--waiting" : "",
              illegal ? "card--illegal" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              marginLeft: i === 0 ? 0 : -overlap,
              zIndex: isSelected ? count + 1 : i,
            }}
            aria-label={cardLabel(cardId)}
            aria-pressed={isSelected}
            aria-disabled={!enabled}
            title={reason ?? undefined}
            onClick={() => {
              if (enabled) onSelect(cardId);
              else if (reason) onBlocked?.(reason);
            }}
          >
            <img
              src={cardImage(cardId)}
              alt={cardLabel(cardId)}
              loading="lazy"
              draggable={false}
            />
          </button>
        );
      })}
    </div>
  );
}
