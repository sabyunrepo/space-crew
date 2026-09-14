import type { CardId } from "../../../shared/contracts.ts";
import { rankOf, suitOf } from "../../../shared/cards.ts";

/** Replaces unreadable artwork with the card's two essential cues at tiny sizes. */
export function CompactCardFace({ cardId }: { cardId: CardId }) {
  return (
    <span className={`compact-card-face suit-${suitOf(cardId)}`} aria-hidden="true">
      {rankOf(cardId)}
    </span>
  );
}
