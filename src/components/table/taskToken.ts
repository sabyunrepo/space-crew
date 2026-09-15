import type { Snapshot } from "../../../shared/contracts.ts";

export function taskTokenLabel(task: Snapshot["tasks"][number]): string | null {
  if (task.token?.kind === "omega") return "Ω";
  if (task.token?.kind === "relative") return "›".repeat(task.token.value ?? 1);
  if (task.token?.kind === "absolute") return String(task.token.value);
  return task.order ? String(task.order) : null;
}
export function taskTokenClass(task: Snapshot["tasks"][number]): string {
  if (task.token?.kind) return `${task.token.kind}-order`;
  return task.order ? "absolute-order" : "";
}
export function taskTokenDescription(task: Snapshot["tasks"][number]): string {
  if (task.token?.kind === "omega") return "마지막 목표";
  if (task.token?.kind === "relative") return `상대 순서 ${task.token.value}`;
  const value = task.token?.value ?? task.order;
  return value ? `전체 목표 중 ${value}번째` : "순서 제한 없음";
}
