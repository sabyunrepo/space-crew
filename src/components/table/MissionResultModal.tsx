import { useEffect, useRef } from "react";
import { ArrowRight, RotateCcw, X } from "lucide-react";
import type { Command, Snapshot } from "../../../shared/contracts.ts";

const titles = { failure: "다시, 함께 도전해요.", success: "임무 성공!", campaign_complete: "탐사 완료!" };

export function MissionResultModal({ snapshot, open, isHost, locked, canContinue, error, hasPending, onDismiss, onSend }: {
  snapshot: Snapshot; open: boolean; isHost: boolean; locked: boolean; canContinue: boolean;
  error?: string; hasPending?: boolean; onDismiss(): void; onSend(command?: Command): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const outcome = snapshot.phase === "failure" ? "failure" : snapshot.phase === "success" ? "success" : "campaign_complete";
  const failure = outcome === "failure";
  const finished = outcome === "campaign_complete";
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      headingRef.current?.focus({ preventScroll: true });
    } else if (dialog.open) {
      dialog.close();
      dialog.closest(".game-table")?.querySelector<HTMLButtonElement>(".status-primary")?.focus({ preventScroll: true });
    }
  }, [open, snapshot.attemptId, outcome]);
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return <dialog ref={dialogRef} className={`mission-result-modal ${outcome}`} aria-labelledby="mission-result-title" aria-describedby="mission-result-reason"
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <header className="setup-modal-heading">
      <span className="eyebrow">MISSION {String(snapshot.missionId).padStart(2, "0")} · {snapshot.attemptNumber}번째 시도 · {failure ? "임무 실패" : finished ? "탐사 완료" : "임무 성공"}</span>
      <button type="button" className="secondary setup-board-button" onClick={onDismiss}><X size={16} />테이블 보기</button>
    </header>
    <div className={`result-box ${outcome}`}>
      <h2 id="mission-result-title" ref={headingRef} tabIndex={-1}>{titles[outcome]}</h2>
      <p id="mission-result-reason">{snapshot.resultReason || (failure ? "이번 임무의 조건을 달성하지 못했습니다." : "모든 대원이 함께 임무를 마쳤습니다.")}</p>
    </div>
    <div className="result-modal-actions">
      {!finished && (isHost ? <>
        <p>{failure ? "같은 미션을 새 손패로 다시 시작합니다." : canContinue ? "다음 임무로 탐사를 이어갑니다." : "다음으로 진행할 임무가 없습니다."}</p>
        <button type="button" className="primary result-continue" disabled={locked || (!failure && !canContinue)}
          onClick={() => onSend({ type: failure ? "retry_mission" : "next_mission" })}>
          {failure ? <RotateCcw size={20} /> : <ArrowRight size={20} />}{failure ? "같은 미션 다시 도전" : "다음 임무"}
        </button>
      </> : <p role="status">{failure ? "방장이 재도전을 시작하기를 기다리고 있습니다." : "방장이 다음 임무를 시작하기를 기다리고 있습니다."}</p>)}
    </div>
  </dialog>;
}
