import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import type { CardId, Command } from "../../../shared/contracts.ts";
import { cardLabel } from "../../../shared/cards.ts";
import { CommunicationCard, markerLabels } from "./CommunicationCard.tsx";

export function CommunicationModal({ cardId, markers, locked, error, hasPending, onSend, onDismiss }: {
  cardId: CardId; markers: (keyof typeof markerLabels)[]; locked: boolean; error?: string; hasPending?: boolean;
  onSend(command?: Command): void; onDismiss(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [marker, setMarker] = useState(markers[0]);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    titleRef.current?.focus({ preventScroll: true });
    return () => { dialog.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialogRef} className="communication-modal" aria-labelledby="communication-title"
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <div className="modal-head"><h2 id="communication-title" ref={titleRef} tabIndex={-1}>이 카드로 교신할까요?</h2>
      <button type="button" className="secondary" onClick={onDismiss}>닫기</button></div>
    <div className="communication-preview"><CommunicationCard communication={{ cardId, marker, played: false }} /></div>
    <p className="communication-card-name">{cardLabel(cardId)}</p>
    {markers.length > 1 ? <div className="communication-marker-options" role="group" aria-label="교신 토큰 위치">{markers.map(option =>
      <button type="button" key={option} className="secondary" aria-pressed={marker === option} disabled={locked || hasPending} onClick={() => setMarker(option)}>{markerLabels[option]}</button>)}</div>
      : <p className="communication-meaning">{markerLabels[marker]}</p>}
    <p className="helper">카드와 교신 신호가 모든 대원에게 공개됩니다. 교신은 시도당 한 번 사용할 수 있습니다.</p>
    <div className="communication-modal-actions"><button type="button" className="secondary" onClick={onDismiss}>다른 카드 선택</button>
      <button type="button" className="primary" disabled={locked || hasPending} onClick={() => onSend({ type: "communicate", cardId, marker })}><Radio size={18} />교신 보내기</button></div>
  </dialog>;
}
