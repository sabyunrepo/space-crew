import { useEffect, useRef } from "react";
import { RotateCcw, Users, X } from "lucide-react";
import type { Command, Snapshot } from "../../../shared/contracts.ts";

export function WaitingJoinModal({ snapshot, isHost, locked, onSend }: {
  snapshot: Snapshot;
  isHost: boolean;
  locked: boolean;
  onSend(command: Command): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const waiting = snapshot.waitingPlayers ?? [];
  useEffect(() => {
    if (waiting.length && snapshot.waitingPolicy !== "after_mission" && !ref.current?.open) ref.current?.showModal();
    if (snapshot.waitingPolicy === "after_mission" && ref.current?.open) ref.current.close();
    if (!waiting.length && ref.current?.open) ref.current.close();
  }, [waiting.length, snapshot.waitingPolicy]);
  if (!waiting.length) return null;
  return <dialog ref={ref} className="waiting-join-modal" aria-labelledby="waiting-join-title">
    <header className="setup-modal-heading">
      <div><span className="eyebrow">NEW CREW MEMBER</span><h2 id="waiting-join-title">새 대원이 합류했습니다</h2></div>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => ref.current?.close()}><X size={18} /></button>
    </header>
    <p className="waiting-join-summary"><Users size={18} /> {waiting.map((p) => p.nickname).join(", ")} 대원이 입장을 기다리고 있습니다.</p>
    {isHost ? <>
      <p>현재 임무를 바로 초기화하거나, 이 임무를 끝낸 뒤 다음 시도부터 함께할 수 있습니다.</p>
      <div className="preparation-actions waiting-join-actions">
        <button type="button" className="secondary" disabled={locked} onClick={() => onSend({ type: "resolve_waiting", mode: "after_mission" })}>현재 임무 후 합류</button>
        <button type="button" className="primary" disabled={locked} onClick={() => onSend({ type: "resolve_waiting", mode: "restart_now" })}><RotateCcw size={17} /> 지금 다시 시작</button>
      </div>
    </> : <p role="status">방장이 합류 시점을 선택하고 있습니다. 잠시 기다려 주세요.</p>}
  </dialog>;
}
