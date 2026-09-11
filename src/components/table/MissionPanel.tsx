import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Mission, Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";

/**
 * 미션 정보 띠. 기본은 미션명 + 목표 요약 1줄만 보이고, "자세히"를 누르면
 * 목표 카드 목록이 같은 자리에서 오버레이로 펼쳐진다(TrickArea를 밀어내지 않음).
 * 임무 선택 단계(task_selection)에서는 선택할 것이 있으므로 항상 펼쳐진다.
 */
export function MissionPanel({
  snapshot,
  currentMission,
  mineId,
  locked,
  onChooseTask,
  footer,
}: {
  snapshot: Snapshot;
  currentMission: Mission | undefined;
  mineId: string | undefined;
  locked: boolean;
  onChooseTask(taskId: string): void;
  /** 임무 선택 단계처럼 패널이 항상 펼쳐져 있을 때, 그 안에 함께 보여줄 보조 버튼(데모 진행 등). */
  footer?: ReactNode;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const open = snapshot.phase === "task_selection" || manualOpen;
  const done = snapshot.tasks.filter((t) => t.status === "success").length;
  return (
    <div className={`mission-panel ${open ? "open" : ""}`}>
      <button
        type="button"
        className="mission-panel-strip"
        aria-expanded={open}
        onClick={() => setManualOpen((v) => !v)}
      >
        <span className="eyebrow">
          MISSION {String(snapshot.missionId).padStart(2, "0")}
        </span>
        <strong>{currentMission?.title}</strong>
        <span className="attempt">
          {snapshot.attemptNumber}번째 시도 · 트릭 {snapshot.trickNumber}
        </span>
        <span className="mission-progress">
          목표 {done}/{snapshot.tasks.length}
        </span>
        <ChevronDown size={16} className="mission-panel-caret" />
        <span className="mission-panel-label">
          {open ? "접기" : "자세히"}
        </span>
      </button>
      {open && (
        <div className="mission-panel-body">
          <p className="mission-panel-summary">{currentMission?.summary}</p>
          {currentMission?.modifiers.map((m) => <small key={m}>{m}</small>)}
          {snapshot.phase === "task_selection" && (
            <p className="mission-panel-hint">
              {snapshot.turnPlayerId === mineId
                ? "내 목표를 선택하세요"
                : `${snapshot.players.find((p) => p.id === snapshot.turnPlayerId)?.nickname} 대원이 목표를 고르는 중입니다`}
            </p>
          )}
          <div className="target-area">
            <div className="target-list">
              {snapshot.tasks.map((task) => (
                <div className={`target ${task.status}`} key={task.id}>
                  <button
                    type="button"
                    className="card small"
                    aria-label={cardLabel(task.cardId)}
                    aria-disabled={
                      !(
                        snapshot.phase === "task_selection" &&
                        !task.ownerId &&
                        snapshot.turnPlayerId === mineId &&
                        !locked
                      )
                    }
                    onClick={() => {
                      if (
                        snapshot.phase === "task_selection" &&
                        !task.ownerId &&
                        snapshot.turnPlayerId === mineId &&
                        !locked
                      )
                        onChooseTask(task.id);
                    }}
                  >
                    <img
                      src={cardImage(task.cardId)}
                      alt={cardLabel(task.cardId)}
                      loading="lazy"
                      draggable={false}
                    />
                  </button>
                  <div>
                    <strong>{cardLabel(task.cardId)}</strong>
                    <span>
                      {task.ownerId
                        ? snapshot.players.find((p) => p.id === task.ownerId)
                            ?.nickname
                        : "담당 대원 선택"}
                    </span>
                    <small>
                      {task.order ? `${task.order}번째로 획득 · ` : ""}
                      {task.status === "success"
                        ? "목표 완료 ✓"
                        : task.status === "failed"
                          ? "목표 실패"
                          : "대기 중"}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {snapshot.lastTrick && (
            <details className="last-trick">
              <summary>
                지난 트릭 확인 ·{" "}
                {
                  snapshot.players.find(
                    (p) => p.id === snapshot.lastTrick!.winnerId,
                  )?.nickname
                }{" "}
                획득
              </summary>
              <div>
                {snapshot.lastTrick.plays.map((p) => (
                  <span key={p.playerId}>
                    {snapshot.players.find((m) => m.id === p.playerId)?.nickname}
                    : {cardLabel(p.cardId)}
                  </span>
                ))}
              </div>
            </details>
          )}
          {footer}
        </div>
      )}
    </div>
  );
}
