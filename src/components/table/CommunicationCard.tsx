import { Radio } from "lucide-react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";

export const markerLabels = { highest: "이 색 중 가장 높음", only: "이 색은 이 카드뿐", lowest: "이 색 중 가장 낮음", hidden: "정보 축소 · 최고·최저·유일 여부 비공개" };
export function CommunicationCard({ communication, blockedReason, selecting = false }: {
  blockedReason?: string; selecting?: boolean;
  communication: Snapshot["players"][number]["communication"];
}) {
  const active = communication && !communication.played;
  const label = active ? `${cardLabel(communication.cardId)} · ${markerLabels[communication.marker]}`
    : communication ? "교신 사용 완료 · 공개한 카드를 냈습니다" : blockedReason ?? (selecting ? "교신 카드 선택 중 · 다시 누르면 취소" : "교신 가능 · 아직 신호를 보내지 않았습니다");
  return <div className={`communication-card ${active ? "broadcast" : communication ? "used" : blockedReason ? "blocked available" : "available"}`}
    role="img" aria-label={label} title={label}>
    {active ? <img src={cardImage(communication.cardId)} alt="" draggable={false} />
      : <div className="signal-back"><Radio aria-hidden="true" /><span>{communication ? "사용 완료" : blockedReason ?? (selecting ? "교신 취소" : "교신 가능")}</span></div>}
    <span className={`signal-token ${active ? `token-${communication.marker}` : communication ? "token-used" : "token-ready"}`} aria-hidden="true">{active && communication.marker === "hidden" ? "D" : <Radio />}</span>
  </div>;
}
