import { useEffect, useRef, type ReactNode } from "react";
import type { Command, Snapshot } from "../../../shared/contracts.ts";

export function RestartVote({ snapshot, locked, onSend, footer }: { snapshot: Snapshot; locked: boolean; onSend(command: Command): void; footer?: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const vote = snapshot.restartVote;
  useEffect(() => {
    if (vote && !dialog.current?.open) dialog.current?.showModal();
    if (!vote && dialog.current?.open) dialog.current.close();
  }, [vote]);
  return <dialog ref={dialog} className="mission-history restart-vote" aria-label="게임 포기 및 재시작 동의" onCancel={e => e.preventDefault()}>
    {vote && <><h2>현재 시도를 포기하고 다시 시작할까요?</h2>
      <p>전원이 동의하면 미션 {snapshot.missionId}을 새 손패로 다시 시작합니다. 동의하는 동안 게임은 잠시 멈춥니다.</p>
      <ul>{snapshot.players.map(p => <li key={p.id}>{p.nickname}{p.id === snapshot.me.playerId ? " (나)" : ""} · {vote.approvals.includes(p.id) ? "동의 완료" : "응답 대기"}</li>)}</ul>
      <p role="status">{vote.approvals.length}/{snapshot.players.length}명 동의</p>
      <div className="preparation-actions"><button type="button" className="secondary" disabled={locked} onClick={() => onSend({ type: "vote_restart", agree: false })}>반대 · 게임 계속</button>
        <button type="button" className="primary" disabled={locked || vote.approvals.includes(snapshot.me.playerId)} onClick={() => onSend({ type: "vote_restart", agree: true })}>{vote.approvals.includes(snapshot.me.playerId) ? "동의 완료 · 대원 기다리는 중" : "동의 · 다시 시작"}</button></div>
      {footer}
    </>}
  </dialog>;
}
