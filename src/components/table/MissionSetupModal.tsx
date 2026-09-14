import { useEffect, useRef, type ReactNode } from "react";
import { MissionTaskInfo } from "./MissionTaskInfo.tsx";
import { Check, X } from "lucide-react";
import type { Command, Mission, Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";
import { PreparationPanel, preparationTitle } from "./PreparationPanel.tsx";
import { taskTokenDescription, taskTokenLabel } from "./taskToken.ts";
import { missionRules } from "../../../shared/missionRules.ts";

export function usesCombinedTaskSetup(snapshot: Snapshot) {
  return snapshot.tasks.length > 0 && missionRules(snapshot.missionId ?? 1).assignment === "draft";
}

/** Only mission instructions and setup actions belong here. Hands and the
 * public assignment overview remain on the board behind the dialog. */
export function MissionSetupModal({ snapshot, mission, open, stepKey, locked, error, hasPending, onDismiss, onSend, footer }: {
  snapshot: Snapshot; mission?: Mission; open: boolean; stepKey: string; locked: boolean;
  error?: string; hasPending?: boolean; onDismiss(): void; onSend(command?: Command): void; footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const autoReadyAttempt = useRef<string | null>(null);
  const briefing = snapshot.phase === "briefing";
  const combined = usesCombinedTaskSetup(snapshot) && (briefing || snapshot.phase === "task_selection");
  const mine = snapshot.players.find(p => p.id === snapshot.me.playerId);
  const myTurn = snapshot.turnPlayerId === snapshot.me.playerId;
  const title = combined ? "목표 카드 선택" : briefing ? "임무 브리핑" : snapshot.phase === "task_selection" ? "목표 카드 선택" : preparationTitle(snapshot);

  // The combined view replaces the separate ready click. The server still
  // waits for every crew member before enabling task assignment.
  useEffect(() => {
    const attempt = `${snapshot.roomId}:${snapshot.attemptId}`;
    if (!open || !combined || !briefing || mine?.briefingReady || locked || error || hasPending || autoReadyAttempt.current === attempt) return;
    autoReadyAttempt.current = attempt;
    onSend({ type: "briefing_ready" });
  }, [open, combined, briefing, mine?.briefingReady, locked, error, hasPending, snapshot.roomId, snapshot.attemptId, onSend]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      headingRef.current?.focus({ preventScroll: true });
      bodyRef.current?.scrollTo(0, 0);
      const recipient = dialog.querySelector<HTMLSelectElement>(".preparation-decision select:not(:disabled)");
      if (recipient) {
        recipient.closest(".preparation-decision")?.scrollIntoView({ block: "nearest" });
        recipient.focus({ preventScroll: true });
      }
    } else if (dialog.open) {
      dialog.close();
      dialog.closest(".game-table")?.querySelector<HTMLButtonElement>(".status-primary")?.focus({ preventScroll: true });
    }
  }, [open, stepKey]);
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return <dialog ref={dialogRef} className="mission-setup-modal" aria-labelledby="mission-setup-title"
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <header className="setup-modal-heading">
      <div><span className="eyebrow">MISSION {String(snapshot.missionId).padStart(2, "0")} · {snapshot.attemptNumber}번째 시도</span>
        <h2 id="mission-setup-title" ref={headingRef} tabIndex={-1}>{title}</h2></div>
      <button type="button" className="secondary setup-board-button" onClick={onDismiss}><X size={16} />테이블 보기</button>
    </header>
    <div className="setup-modal-body" ref={bodyRef}>
      <section className="setup-mission-conditions" aria-label="미션 조건">
        {!combined && <MissionTaskInfo snapshot={snapshot} />}
        <p>{mission?.summary}</p>
        {!!mission?.modifiers.length && <ul>{mission.modifiers.map(condition => <li key={condition}>{condition}</li>)}</ul>}
        {snapshot.rulesetVersion === "crew-p9-50-2" && [5, 17, 33].includes(snapshot.missionId ?? 0) && <p className="helper">이전 규칙으로 시작한 판입니다. 테이블의 기존 판 안내를 함께 확인하세요.</p>}
      </section>
      {error && <div className="setup-error" role="alert"><p>{error}</p>{hasPending ? <button type="button" className="secondary" onClick={() => onSend()}>같은 요청 재전송</button> : combined && briefing && !mine?.briefingReady && <button type="button" className="secondary" disabled={locked} onClick={() => onSend({ type: "briefing_ready" })}>준비 다시 시도</button>}</div>}
      {briefing && !combined && <section className="setup-briefing-actions" aria-label="임무 확인">
        <p>손패와 임무를 확인한 후 ‘임무 확인 완료’를 눌러 주세요.</p>
        <p className="setup-turn-notice" role="status">{mine?.briefingReady ? "내 임무 확인을 저장했습니다. 다른 대원을 기다립니다." : "내 확인이 필요합니다."} · {snapshot.players.filter(p => p.briefingReady).length}/{snapshot.players.length}명 확인</p>
        <button type="button" className="primary setup-confirm" disabled={locked || mine?.briefingReady} onClick={() => onSend({ type: "briefing_ready" })}><Check size={18} />{mine?.briefingReady ? "다른 대원을 기다리는 중" : "임무 확인 완료"}</button>
      </section>}
      {(combined || snapshot.phase === "task_selection") && <section className="mission-task-draft" aria-label="목표 선택">
        <p className="setup-turn-notice" role="status">{briefing ? `대원들이 준비되면 지휘관부터 선택합니다. · ${snapshot.players.filter(p => p.briefingReady).length}/${snapshot.players.length}명 준비` : myTurn ? "내 차례 · 맡을 목표 카드를 선택하세요" : `${snapshot.players.find(p => p.id === snapshot.turnPlayerId)?.nickname ?? "다른"} 대원이 목표를 고르는 중입니다`}</p>
        <div className="target-list">{snapshot.tasks.filter(task => !task.ownerId).map(task => {
          const disabled = locked || briefing || !myTurn;
          return <button type="button" className="draft-task" key={task.id} aria-label={cardLabel(task.cardId)}
            aria-disabled={disabled} disabled={disabled} onClick={() => onSend({ type: "choose_task", taskId: task.id })}>
            <span className="draft-task-art"><img src={cardImage(task.cardId)} alt="" draggable={false} />
              {taskTokenLabel(task) && <span className="task-order" title={taskTokenDescription(task)}>{taskTokenLabel(task)}</span>}</span>
            <span className="draft-task-name">{cardLabel(task.cardId)}</span>
          </button>;
        })}</div>
      </section>}
      {snapshot.phase === "preparation" && <PreparationPanel snapshot={snapshot} locked={locked} onSend={onSend} />}
      {footer && <div className="setup-modal-footer">{footer}</div>}
    </div>
  </dialog>;
}
