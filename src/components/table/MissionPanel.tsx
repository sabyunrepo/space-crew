import { MissionTaskInfo } from "./MissionTaskInfo.tsx";
import { missionRules } from "../../../shared/missionRules.ts";
import { useRef } from "react";
import type { Mission, Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";

/** Compact status summary; full conditions and public roles live in the details dialog. */
export function MissionPanel({ snapshot, currentMission }: {
  snapshot: Snapshot; currentMission?: Mission;
}) {
  const detailsRef = useRef<HTMLDialogElement>(null);
  const rules = missionRules(snapshot.missionId ?? 1);
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
  return <section className="mission-panel mission-always-visible status-mission" aria-label="현재 미션">
    <div className="mission-panel-strip">
      <span className="eyebrow">MISSION {String(snapshot.missionId).padStart(2, "0")}</span>
      <span className="attempt">{snapshot.attemptNumber}번째 시도 · 트릭 {snapshot.trickNumber}</span>
      <span className="mission-progress">{specialProgress ?? `목표 ${done}/${snapshot.tasks.length + (snapshot.hiddenTaskCount ?? 0)}`}</span>
      <button type="button" className="mission-history-button" onClick={() => detailsRef.current?.showModal()}>미션 조건</button>
      {snapshot.lastTrick && <button type="button" className="mission-history-button" onClick={() => historyRef.current?.showModal()}>지난 트릭</button>}
    </div>
    <dialog ref={detailsRef} className="mission-history mission-details" aria-label="미션 조건 상세">
      <div className="modal-head"><h2>{currentMission?.title} · 미션 조건</h2><button type="button" onClick={() => detailsRef.current?.close()}>닫기</button></div>
    <p className="mission-panel-summary">{snapshot.tasks.length || snapshot.hiddenTaskCount ? "각 담당자가 자신의 목표 카드를 획득하세요." : currentMission?.summary}
      {rules.tokens.length > 0 && <span> · {rules.tokens.some(t => t.kind === "absolute") ? "숫자 순서" : rules.tokens.some(t => t.kind === "relative") ? "상대 순서" : "Ω 마지막 목표"} 준수</span>}
      {rules.communication.hidden && <span> · 교신 위치 비공개</span>}
      {rules.communication.fromTrick > 1 && <span> · {rules.communication.fromTrick}트릭부터 교신</span>}
      {snapshot.missionId === 12 && <span> · 첫 트릭 후 무작위 카드 이동</span>}
      {snapshot.missionId === 48 && <span> · Ω는 마지막 트릭</span>}
    </p>
    {snapshot.rulesetVersion === "crew-p9-50-2" && [5, 17, 33].includes(snapshot.missionId ?? 0) && <p className="mission-panel-hint">이번 판은 이전 규칙으로 계속합니다. {snapshot.missionId === 17 ? "목표 완료 후 일반 9가 모두 나오거나 마지막 트릭이 끝날 때까지 진행합니다." : "이번 판에서는 지휘관 자신을 담당자로 선택할 수 없습니다."} 재도전부터 수정된 원작 기준을 적용합니다.</p>}
    {role && <p className="mission-panel-hint">{role}</p>}
    {progress?.silentPlayerId && <p className="mission-panel-hint">교신 금지 대원: {nick(progress.silentPlayerId)}</p>}
    {progress?.blackNineHolderId && <p className="mission-panel-hint">검은 9 보유자: {nick(progress.blackNineHolderId)} · 왼쪽 대원이 검은 카드 9장을 모두 획득</p>}
    {progress?.distressActive && <small className="mission-modifier">구조 신호 활성 · 이번 시도 교환 {progress.distressUsed ? "완료" : "미사용"}</small>}
      <MissionTaskInfo snapshot={snapshot} />
      <p>{currentMission?.summary}</p>
      {snapshot.rulesetVersion === "crew-p9-50-4" && <p className="helper">이 웹 버전: 목표 색상 분산 추첨 · 진행 중 내 차례 밖에서도 교신 가능 (미션별 제한 유지)</p>}
      <ul>{currentMission?.modifiers.map(m => <li key={m}>{m}</li>)}</ul>
    </dialog>
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
