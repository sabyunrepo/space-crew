import type { Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel } from "../../../shared/cards.ts";
import { CompactCardFace } from "./CompactCardFace.tsx";
import { taskTokenClass, taskTokenDescription, taskTokenLabel } from "./taskToken.ts";
export function TaskCard({ task, focusable = true, priority = false }: { task: Snapshot["tasks"][number]; focusable?: boolean; priority?: boolean }) {
  const status = task.status === "success" ? "완료" : task.status === "failed" ? "실패" : priority ? "현재 우선 목표" : "대기";
  return <div tabIndex={focusable ? 0 : undefined} className={`seat-task compact-card-container ${task.status} ${priority && task.status === "pending" ? "current-goal" : ""}`} data-task-id={task.id}
    title={`${cardLabel(task.cardId)} · ${taskTokenDescription(task)} · ${status}`}
    aria-label={`${cardLabel(task.cardId)} 목표 · ${taskTokenDescription(task)} · ${status}`}>
    <img className="compact-card-art" src={cardImage(task.cardId)} alt={cardLabel(task.cardId)} draggable={false} />
    <CompactCardFace cardId={task.cardId} />
    {taskTokenLabel(task) && <span className={`task-order ${taskTokenClass(task)}`}>{taskTokenLabel(task)}</span>}
    {task.status !== "pending" && <span className="task-outcome">{task.status === "success" ? "✓" : "✕"}</span>}
  </div>;
}
