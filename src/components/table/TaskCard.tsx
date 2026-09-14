import type { Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel, rankOf, suitOf } from "../../../shared/cards.ts";
import { taskTokenDescription, taskTokenLabel } from "./taskToken.ts";
export function TaskCard({ task }: { task: Snapshot["tasks"][number] }) {
  const status = task.status === "success" ? "완료" : task.status === "failed" ? "실패" : "대기";
  return <div className={`seat-task ${task.status}`} data-task-id={task.id}
    title={`${cardLabel(task.cardId)} · ${taskTokenDescription(task)} · ${status}`}
    aria-label={`${cardLabel(task.cardId)} 목표 · ${taskTokenDescription(task)} · ${status}`}>
    <img src={cardImage(task.cardId)} alt={cardLabel(task.cardId)} draggable={false} />
    <b className={`card-value suit-${suitOf(task.cardId)}`}>{rankOf(task.cardId)}</b>
    {taskTokenLabel(task) && <span className="task-order">{taskTokenLabel(task)}</span>}
    {task.status !== "pending" && <span className="task-outcome">{task.status === "success" ? "✓" : "✕"}</span>}
  </div>;
}
