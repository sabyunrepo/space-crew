import { Crown } from "lucide-react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { characterFor, characterImage } from "../../../shared/characters.ts";
import { CommunicationCard } from "./CommunicationCard.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { priorityTaskIds } from "./taskPriority.ts";
import { missionRules } from "../../../shared/missionRules.ts";

export function PlayerSeat({ snapshot, player: p, position, mineId, onCommunicate, communicationActive, locked, compactIdentity = false }: {
  snapshot: Snapshot; player: Snapshot["players"][number]; position: string; mineId?: string;
  onCommunicate?(): void; communicationActive?: boolean; locked?: boolean; compactIdentity?: boolean;
}) {
  const play = snapshot.trick.find((t) => t.playerId === p.id);
  const fromTrick = missionRules(snapshot.missionId ?? 1).communication.fromTrick;
  const blockedReason = snapshot.missionProgress?.silentPlayerId === p.id ? "교신 금지" : snapshot.trickNumber < fromTrick ? `${fromTrick}트릭부터 교신` : snapshot.restartVote ? "재시작 투표 중"
    : snapshot.phase !== "playing" ? ["lobby", "briefing", "preparation", "task_selection"].includes(snapshot.phase) ? "미션 준비 중" : snapshot.phase === "trick_result" ? "다음 트릭 대기" : "미션 종료"
    : snapshot.rulesetVersion !== "crew-p9-50-4" && snapshot.trick.length > 0 ? "다음 트릭부터 교신"
    : p.id === mineId && !p.communication && !snapshot.me.canCommunicate ? "교신할 카드 없음" : undefined;
  const priorities = priorityTaskIds(snapshot);
  const tasks = snapshot.tasks.filter((t) => t.ownerId === p.id);
  const turn = ["playing", "task_selection"].includes(snapshot.phase) && p.id === snapshot.turnPlayerId;
  const ownTurn = turn && p.id === mineId;
  const winner = snapshot.phase !== "playing" && snapshot.lastTrick?.winnerId === p.id;
  return <section className={`player-seat ${compactIdentity ? "compact-seat" : ""} seat-${position} ${turn ? "on-turn" : ""} ${ownTurn ? "is-my-turn" : ""} ${winner ? "trick-winner" : ""}`}
    data-player-id={p.id} data-seat-index={p.seat} data-position={position} aria-current={turn ? "true" : undefined} aria-label={`${p.nickname} 대원 자리`}>
    {turn && <div className="seat-turn-indicator" role="status"><span className="seat-turn-badge"><span className="seat-turn-dot" aria-hidden="true" />{snapshot.phase === "task_selection" ? ownTurn ? "내 목표 선택" : "목표 선택 중" : ownTurn ? "내 차례" : "차례"}</span></div>}
    <header className="seat-heading">
      {compactIdentity && <div className="character-card own-avatar" data-character-id={characterFor(p.characterId).id}><img src={characterImage(p.characterId)} alt={characterFor(p.characterId).name} draggable={false} /></div>}
      <strong>{p.id === snapshot.commanderId && <Crown size={12} aria-label="사령관" />}{p.nickname}{p.id === mineId && <small>나</small>}</strong>
      <span>{p.cardCount}장 · {p.tricksWon}승</span>
    </header>
    {snapshot.phase === "briefing" && <span className="seat-briefing">{p.briefingReady ? "브리핑 확인 완료" : "브리핑 확인 중"}</span>}
    <div className="seat-main-row">
      {!compactIdentity && <div className="seat-column"><span className="seat-column-label">캐릭터</span>
        <div className="character-card" data-character-id={characterFor(p.characterId).id}>
          <img src={characterImage(p.characterId)} alt={characterFor(p.characterId).name} draggable={false} />
          <span>{characterFor(p.characterId).name}</span>
        </div>
      </div>}
      <div className="seat-column communication"><span className="seat-column-label">신호</span>{p.id === mineId && snapshot.me.canCommunicate && onCommunicate ? <button type="button" className="seat-communication-button" aria-label={communicationActive ? "교신 취소" : "교신하기"} aria-pressed={communicationActive} disabled={locked || !!snapshot.restartVote} onClick={onCommunicate}><CommunicationCard communication={p.communication} blockedReason={blockedReason} selecting={communicationActive} /></button> : <CommunicationCard communication={p.communication} blockedReason={blockedReason} />}</div>
    </div>
    {snapshot.phase === "playing" && <p className={`seat-submission ${play ? "submitted" : ""}`}>{play ? "카드 제출 완료 · 중앙에서 확인" : turn ? "카드를 선택해 주세요" : "카드 제출 대기"}</p>}
    <div className="seat-missions" aria-label={`${p.nickname} 미션 카드`}>
      <span className="seat-missions-label">목표 {tasks.length}</span>
      <div className="seat-task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} priority={priorities.has(task.id)} />)}
        {!tasks.length && <span className="no-tasks">{snapshot.phase === "task_selection" ? "목표 배정 중" : compactIdentity ? "배정된 목표 없음" : "팀의 목표를 도와주세요"}</span>}
      </div>
    </div>
  </section>;
}
