import type { Snapshot } from "../../../shared/contracts.ts";
import { missionRules } from "../../../shared/missionRules.ts";

/** Task counts are public; identities come only from the projected snapshot. */
export function MissionTaskInfo({ snapshot }: { snapshot: Snapshot }) {
  const total = snapshot.tasks.length + (snapshot.hiddenTaskCount ?? 0);
  const assigned = snapshot.tasks.filter(task => task.ownerId).length;
  const hidden = snapshot.hiddenTaskCount ?? 0;
  const assignment = missionRules(snapshot.missionId ?? 1).assignment;
  const description = total === 0 ? "목표 카드 없이 특수 승리 조건으로 진행합니다."
    : hidden > 0 && assignment === "decision" ? "담당자를 정한 뒤 카드 내용을 공개합니다."
    : hidden > 0 && assignment === "distribution" ? `한 장씩 공개·배정합니다. 배정 ${assigned}장 · 아직 비공개 ${hidden}장`
    : "목표 카드의 색·숫자는 모두 공개됩니다.";
  return <p className="mission-task-info"><strong>목표 카드 총 {total}장</strong><span>{description}</span></p>;
}
