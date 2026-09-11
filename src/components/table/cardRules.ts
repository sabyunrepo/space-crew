import type { CardId, Snapshot } from "../../../shared/contracts.ts";
import { SUIT_META, suitOf } from "../../../shared/cards.ts";
import { communicationMarkers } from "../../game/engine.ts";

export type CardAvailability = {
  cardId: CardId;
  enabled: boolean;
  reason: string | null;
};

/** 이유 문구가 "내 차례가 아니라서" 막힌 상태인지 판별한다(회색 처리 없이 선택만 막는 card--waiting). */
export function isTurnBlocked(reason: string | null): boolean {
  return reason !== null && reason.endsWith("대원의 차례예요");
}

export function handAvailability(
  snapshot: Snapshot,
  mode: "play" | "communicate" | "view",
): CardAvailability[] {
  const hand = snapshot.me.hand;
  if (mode === "view")
    return hand.map((cardId) => ({ cardId, enabled: true, reason: null }));
  if (mode === "communicate")
    return hand.map((cardId) => {
      const enabled =
        suitOf(cardId) !== "rocket" &&
        communicationMarkers(hand, cardId).length > 0;
      return {
        cardId,
        enabled,
        reason: enabled ? null : "교신할 수 없는 카드예요",
      };
    });
  // mode === "play"
  const isMyTurn = snapshot.turnPlayerId === snapshot.me.playerId;
  if (!isMyTurn) {
    const turnPlayer = snapshot.players.find(
      (p) => p.id === snapshot.turnPlayerId,
    );
    const reason = turnPlayer
      ? `${turnPlayer.nickname} 대원의 차례예요`
      : "지금은 카드를 낼 수 없어요";
    return hand.map((cardId) => ({ cardId, enabled: false, reason }));
  }
  const legal = new Set(snapshot.me.legalCardIds);
  const led = snapshot.trick[0]?.cardId;
  const ledColor = led ? SUIT_META[suitOf(led)].color : null;
  return hand.map((cardId) => {
    const enabled = legal.has(cardId);
    return {
      cardId,
      enabled,
      reason: enabled
        ? null
        : ledColor
          ? `선도 색(${ledColor}) 카드가 있으면 그 색을 내야 해요`
          : "지금은 낼 수 없는 카드예요",
    };
  });
}
