import { MissionTaskInfo } from "./MissionTaskInfo.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { useRef } from "react";
import type { Mission, Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";

/** Mission conditions remain in document flow; assigned goals live at their owner's seat. */
export function MissionPanel({ snapshot, currentMission }: {
  snapshot: Snapshot; currentMission?: Mission;
}) {
  const historyRef = useRef<HTMLDialogElement>(null);
  const done = snapshot.tasks.filter((t) => t.status === "success").length;
  const specialProgress = (() => {
    const progress = snapshot.missionProgress;
    if (!progress) return null;
    if ([9, 26].includes(snapshot.missionId ?? 0))
      return `일반 1 승리 ${progress.oneWins}/${snapshot.missionId === 26 ? 2 : 1}`;
    if ([13, 44].includes(snapshot.missionId ?? 0))
      return `로켓 승리 ${progress.rocketsWon.length}/4`;
    if (snapshot.missionId === 17 && snapshot.rulesetVersion !== "crew-p9-50-2")
      return `목표 ${done}/${snapshot.tasks.length} · 일반 9 승리 금지`;
    if ([16, 17].includes(snapshot.missionId ?? 0))
      return `${snapshot.missionId === 17 ? `목표 ${done}/${snapshot.tasks.length} · ` : ""}일반 9 플레이 ${progress.ninesPlayed ?? 0}/4장`;
    if (snapshot.missionId === 46) return `검은 카드 획득 ${progress.blackCardsWon}/9`;
    if (snapshot.missionId === 50) return "구간별 트릭 담당 규칙 진행";
    return snapshot.tasks.length || snapshot.hiddenTaskCount ? null : "특수 승리 조건 진행";
  })();
  const progress = snapshot.missionProgress;
  const nick = (id: string | null | undefined) => snapshot.players.find(p => p.id === id)?.nickname;
  const role = progress?.selectedPlayerId ? snapshot.missionId === 50
    ? `첫 4트릭: ${nick(progress.selectedPlayerId)} · 마지막 트릭: ${nick(progress.secondaryPlayerId)} · 나머지 대원: 중간 트릭`
    : `담당 대원: ${nick(progress.selectedPlayerId)} · 현재 ${snapshot.players.find(p => p.id === progress.selectedPlayerId)?.tricksWon ?? 0}트릭 획득` : null;
  return <section className="mission-panel mission-always-visible" aria-label="현재 미션">
    <div className="mission-panel-strip">
      <span className="eyebrow">MISSION {String(snapshot.missionId).padStart(2, "0")}</span>
      <strong>{currentMission?.title}</strong>
      <span className="attempt">{snapshot.attemptNumber}번째 시도 · 트릭 {snapshot.trickNumber}</span>
      <span className="mission-progress">{specialProgress ?? `목표 ${done}/${snapshot.tasks.length + (snapshot.hiddenTaskCount ?? 0)}`}</span>
      {snapshot.lastTrick && <button type="button" className="mission-history-button" onClick={() => historyRef.current?.showModal()}>지난 트릭</button>}
    </div>
    <MissionTaskInfo snapshot={snapshot} />
    <p className="mission-panel-summary">{currentMission?.summary}</p>
    {snapshot.rulesetVersion === "crew-p9-50-2" && [5, 17, 33].includes(snapshot.missionId ?? 0) && <p className="mission-panel-hint">이번 판은 이전 규칙으로 계속합니다. {snapshot.missionId === 17 ? "목표 완료 후 일반 9가 모두 나오거나 마지막 트릭이 끝날 때까지 진행합니다." : "이번 판에서는 지휘관 자신을 담당자로 선택할 수 없습니다."} 재도전부터 수정된 원작 기준을 적용합니다.</p>}
    {role && <p className="mission-panel-hint">{role}</p>}
    {progress?.silentPlayerId && <p className="mission-panel-hint">교신 금지 대원: {nick(progress.silentPlayerId)}</p>}
    {progress?.blackNineHolderId && <p className="mission-panel-hint">검은 9 보유자: {nick(progress.blackNineHolderId)} · 왼쪽 대원이 검은 카드 9장을 모두 획득</p>}
    {progress?.distressActive && <small className="mission-modifier">구조 신호 활성 · 이번 시도 교환 {progress.distressUsed ? "완료" : "미사용"}</small>}
    {currentMission?.modifiers.map((m) => <small className="mission-modifier" key={m}>{m}</small>)}
    {["briefing", "task_selection", "preparation"].includes(snapshot.phase) && snapshot.tasks.some(task => !task.ownerId) && <div className="mission-public-tasks" aria-label="공개된 미배정 목표">
      <span>공개된 미배정 목표</span>{snapshot.tasks.filter(task => !task.ownerId).map(task => <TaskCard key={task.id} task={task} />)}
    </div>}
    {snapshot.lastTrick && <dialog ref={historyRef} className="mission-history" aria-label="지난 트릭 확인">
      <div className="modal-head"><h2>지난 트릭 · {snapshot.players.find(p => p.id === snapshot.lastTrick!.winnerId)?.nickname} 획득</h2>
        <button type="button" onClick={() => historyRef.current?.close()}>닫기</button></div>
      <div className="history-cards">{snapshot.lastTrick.plays.map(play => <figure key={play.playerId}>
        <img src={cardImage(play.cardId)} alt={cardLabel(play.cardId)} />
        <figcaption>{snapshot.players.find(p => p.id === play.playerId)?.nickname}</figcaption>
      </figure>)}</div>
    </dialog>}
  </section>;
}
