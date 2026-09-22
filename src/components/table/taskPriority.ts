import type { Snapshot } from "../../../shared/contracts.ts";

type Task = Snapshot["tasks"][number];
const tokenOf = (task: Task) => task.token === undefined
  ? task.order ? { kind: "absolute" as const, value: task.order } : null
  : task.token;

/** Next priorities from public order/progress only, not a prediction of who can win.
 * Later ordered goals may still be captured together in the same trick. */
export function priorityTaskIds(snapshot: Pick<Snapshot, "phase" | "tasks" | "missionId" | "players" | "trickNumber">): Set<string> {
  if (!["playing", "trick_result"].includes(snapshot.phase) || snapshot.tasks.some(t => t.status === "failed")) return new Set();
  const pending = snapshot.tasks.filter(t => t.status === "pending" && t.ownerId);
  const nextOrder = snapshot.tasks.filter(t => t.status === "success").length + 1;
  const absoluteNext = pending.find(t => tokenOf(t)?.kind === "absolute" && tokenOf(t)?.value === nextOrder);
  if (absoluteNext) return new Set([absoluteNext.id]);
  const relativeNext = Math.min(...pending.filter(t => tokenOf(t)?.kind === "relative").map(t => tokenOf(t)!.value!));
  return new Set(pending.filter(t => {
    const token = tokenOf(t);
    if (!token) return true;
    if (token.kind === "relative") return token.value === relativeNext;
    if (token.kind === "omega") {
      if (snapshot.missionId === 48) return snapshot.trickNumber === Math.floor(40 / snapshot.players.length);
      return pending.length === 1;
    }
    return false;
  }).map(t => t.id));
}
