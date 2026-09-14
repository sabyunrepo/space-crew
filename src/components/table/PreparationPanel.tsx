import { useEffect, useRef, useState } from "react";
import type { Command, Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel, suitOf } from "../../../shared/cards.ts";
import { roleIncludesCommander } from "../../../shared/missionRules.ts";
import { TaskCard } from "./TaskCard.tsx";
import { taskTokenDescription } from "./taskToken.ts";

const answerLabels = { yes: "예", no: "아니오", unknown: "모르겠어요", first: "첫 4트릭", middle: "중간 트릭", last: "마지막 트릭" };
const stageTitles = {
  role: "미션 담당자 결정", captain_decision: "지휘관 결정", captain_distribution: "지휘관 목표 분배",
  token_edit: "순서 토큰 준비", task_transfer: "5인 목표 양도", distress_vote: "구조 신호 동의", distress_cards: "구조 신호 카드 교환",
};
export function preparationTitle(snapshot: Snapshot): string {
  return snapshot.preparation ? stageTitles[snapshot.preparation.stage] : "미션 준비";
}
function question(snapshot: Snapshot): string {
  switch (snapshot.preparation?.stage) {
    case "captain_decision": return "모든 대원이 목표를 맡을 수 있는지 예·아니오로 응답한 뒤, 지휘관이 자신을 제외한 대원 한 명을 지정합니다.";
    case "captain_distribution": return "현재 공개된 목표를 담당할 수 있나요? 모든 대원이 응답한 뒤 지휘관이 배정합니다.";
    case "distress_vote": return "같은 방향으로 일반 카드 한 장씩 교환하는 구조 신호에 동의하나요? 전원 동의가 필요합니다.";
    case "role":
      switch (snapshot.missionId) {
        case 5: return "손패를 확인한 뒤 현재 상태를 좋음 또는 나쁨으로만 알려주세요. 지휘관이 정한 대원은 트릭을 하나도 획득하면 안 됩니다.";
        case 11: return "지휘관은 이번 미션에서 교신할 수 없는 다른 대원 한 명을 지정하세요.";
        case 33: return "일반 카드로 정확히 한 트릭만 가져올 수 있나요?";
        case 41: return "일반 카드로 첫 트릭과 마지막 트릭만 가져올 수 있나요?";
        case 50: return "팀이 합의해 첫 네 트릭만 가져올 대원 A와 마지막 트릭만 가져올 대원 B를 정하세요. 지휘관이 합의 결과를 확정하며 나머지 대원은 중간 트릭을 담당합니다.";
        default: return "손패 내용을 공개하지 않고 미션 담당 여부를 응답하세요.";
      }
    default: return "";
  }
}

export function PreparationPanel({ snapshot, locked, onSend }: { snapshot: Snapshot; locked: boolean; onSend(command: Command): void }) {
  if (!snapshot.preparation || snapshot.phase !== "preparation") return null;
  return <PreparationControls key={`${snapshot.attemptId}:${snapshot.preparation.stage}:${snapshot.preparation.activeTaskId}`} snapshot={snapshot} locked={locked} onSend={onSend} />;
}
function PreparationControls({ snapshot, locked, onSend }: { snapshot: Snapshot; locked: boolean; onSend(command: Command): void }) {
  const prep = snapshot.preparation!;
  const mineId = snapshot.me.playerId;
  const commander = snapshot.commanderId === mineId;
  const decisionRef = useRef<HTMLDivElement>(null);
  const recipientRef = useRef<HTMLSelectElement>(null);
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [firstTask, setFirstTask] = useState("");
  const [secondTask, setSecondTask] = useState("");
  const [card, setCard] = useState("");
  const activeTask = snapshot.tasks.find(t => t.id === prep.activeTaskId);
  const answered = prep.answeredPlayerIds.includes(mineId);
  const eligible = snapshot.players.filter(p => prep.eligiblePlayerIds.includes(p.id));
  const responseStage = ["role", "captain_decision", "captain_distribution", "distress_vote"].includes(prep.stage) && !(prep.stage === "role" && snapshot.missionId === 11);
  const targets = eligible;
  const requiredResponders = snapshot.players.filter(p =>
    prep.stage === "distress_vote" ||
    ["captain_decision", "captain_distribution"].includes(prep.stage) ||
    (prep.stage === "role" && snapshot.missionId !== 11 &&
      (roleIncludesCommander(snapshot.missionId ?? 0, snapshot.rulesetVersion) || p.id !== snapshot.commanderId)),
  );
  const waitingPlayers = requiredResponders.filter(p => !prep.responses[p.id]);
  const responsesComplete = waitingPlayers.length === 0;
  const decisionStage = ["role", "captain_decision", "captain_distribution"].includes(prep.stage);
  const myDecision = commander && decisionStage && responsesComplete;
  useEffect(() => {
    if (!myDecision || locked || !decisionRef.current?.closest("dialog")?.open) return;
    decisionRef.current.scrollIntoView({ block: "nearest" });
    recipientRef.current?.focus({ preventScroll: true });
  }, [myDecision, locked]);
  const mayAnswer = requiredResponders.some(p => p.id === mineId);
  const answerOptions: (keyof typeof answerLabels)[] = prep.stage === "role" && snapshot.missionId === 50 ? ["first", "middle", "last"] : ["yes", "no"];
  const labels = prep.stage === "role" && snapshot.missionId === 5 ? { ...answerLabels, yes: "좋음", no: "나쁨" } : answerLabels;
  const ownTasks = snapshot.tasks.filter(t => t.ownerId === mineId);
  const selectedTask = snapshot.tasks.find(t => t.id === firstTask);
  const tokenTargets = snapshot.tasks.filter(t => t.id !== firstTask && (snapshot.missionId === 40 ? !t.token && !t.order : !!t.token || !!t.order));
  const nick = (id: string) => snapshot.players.find(p => p.id === id)?.nickname ?? "대원";
  return <section className="mission-preparation" aria-label="미션 준비">
    <div className="preparation-heading"><strong>{preparationTitle(snapshot)}</strong><span>{commander ? "내가 지휘관" : `지휘관: ${nick(snapshot.commanderId ?? "")}`}</span></div>
    {["distress_vote", "distress_cards"].includes(prep.stage) && <p className="helper">이동 방향: {snapshot.missionProgress?.distressDirection === "right" ? "오른쪽" : "왼쪽"} 대원에게 전달</p>}
    {question(snapshot) && <p>{question(snapshot)}</p>}
    {activeTask && <div className="preparation-active-task"><TaskCard task={activeTask} /><span>{cardLabel(activeTask.cardId)} · {taskTokenDescription(activeTask)}</span></div>}
    {responseStage && <div className="preparation-own-response">
      {mayAnswer && !answered ? <>
        <h4>1. 내 응답</h4>
        <p>{commander ? "지휘관도 자신의 손패를 보고 직접 응답해 주세요." : "내 손패를 보고 직접 응답해 주세요."}</p>
        <div className="preparation-actions">{answerOptions.map(answer => <button key={answer} className="secondary" disabled={locked} onClick={() => onSend({ type: "preparation_response", answer })}>{labels[answer]}</button>)}</div>
      </> : <p className={`preparation-next-action ${myDecision ? "ready" : ""}`} role="status">
        {answered && <>내 응답: <strong>{labels[prep.responses[mineId]]}</strong> · 저장 완료. </>}
        {myDecision ? "내 결정 차례입니다. 담당 대원을 선택하고 확정해 주세요."
          : !responsesComplete ? `${waitingPlayers.map(p => p.nickname).join(", ")} 대원의 응답을 기다립니다.`
          : decisionStage ? `${nick(snapshot.commanderId ?? "")} 지휘관의 담당자 선택을 기다립니다.` : "전원 응답을 확인하고 있습니다."}
      </p>}
    </div>}
    {myDecision && <div className="preparation-decision" ref={decisionRef}>
      <h4>{responseStage ? "2. " : ""}담당자 선택 · 내가 지휘관</h4>
      <div className="preparation-actions">
      <label>{snapshot.missionId === 50 ? "첫 4트릭 담당 A" : "담당 대원"}<select ref={recipientRef} value={primary} onChange={e => setPrimary(e.target.value)} disabled={locked}><option value="">대원 선택</option>{targets.map(p => <option key={p.id} value={p.id}>{p.nickname}</option>)}</select></label>
      {snapshot.missionId === 50 && <label>마지막 트릭 담당 B<select value={secondary} onChange={e => setSecondary(e.target.value)} disabled={locked}><option value="">대원 선택</option>{snapshot.players.filter(p => p.id !== primary).map(p => <option key={p.id} value={p.id}>{p.nickname}</option>)}</select></label>}
      <button className="primary" disabled={locked || !responsesComplete || !primary || (snapshot.missionId === 50 && (!secondary || primary === secondary))} onClick={() => onSend(prep.stage === "captain_distribution" ? { type: "assign_task", playerId: primary } : { type: "select_crew", playerId: primary, ...(snapshot.missionId === 50 ? { secondaryPlayerId: secondary } : {}) })}>{prep.stage === "captain_distribution" ? "목표 배정" : "담당자 확정"}</button>
      </div>
    </div>}
    {responseStage && <div className="preparation-responses" aria-label="대원 응답">{requiredResponders.map(p => <span key={p.id}>{p.nickname}{p.id === mineId ? " (나)" : ""}: {prep.responses[p.id] ? labels[prep.responses[p.id]] : "응답 대기"}</span>)}</div>}
    {prep.stage === "token_edit" && <>
      <p>{snapshot.missionId === 23 ? "토큰 두 개를 서로 교환할 수 있습니다." : "토큰 하나를 토큰이 없는 목표로 옮길 수 있습니다."} 변경하지 않고 확정해도 됩니다.</p>
      <div className="preparation-task-row">{snapshot.tasks.map(task => <TaskCard key={task.id} task={task} />)}</div>
      {commander ? <div className="preparation-actions">
        <label>이동할 토큰<select value={firstTask} disabled={locked} onChange={e => { setFirstTask(e.target.value); setSecondTask(""); }}><option value="">목표 선택</option>{snapshot.tasks.filter(t => t.token || t.order).map(t => <option key={t.id} value={t.id}>{cardLabel(t.cardId)} · {taskTokenDescription(t)}</option>)}</select></label>
        <label>{snapshot.missionId === 23 ? "교환할 토큰" : "토큰 없는 목표"}<select value={secondTask} disabled={locked || !firstTask} onChange={e => setSecondTask(e.target.value)}><option value="">목표 선택</option>{tokenTargets.map(t => <option key={t.id} value={t.id}>{cardLabel(t.cardId)} · {taskTokenDescription(t)}</option>)}</select></label>
        <button className="secondary" disabled={locked || !firstTask || !secondTask} onClick={() => { onSend({ type: "edit_task_tokens", firstTaskId: firstTask, secondTaskId: secondTask }); setFirstTask(""); setSecondTask(""); }}>토큰 변경</button>
        <button className="secondary" disabled={locked} onClick={() => onSend({ type: "reset_tokens" })}>원래 배치로 되돌리기</button>
        <button className="primary" disabled={locked} onClick={() => onSend({ type: "confirm_tokens" })}>현재 토큰 배치 확정</button>
      </div> : <p className="helper">지휘관이 토큰 배치를 확정하고 있습니다.</p>}
    </>}
    {prep.stage === "task_transfer" && <>
      <p>팀이 합의하면 목표 한 장을 토큰과 함께 다른 대원에게 양도할 수 있습니다. 해당 목표의 담당자가 선택하세요.</p>
      {ownTasks.length > 0 && <div className="preparation-actions">
        <label>내 목표<select value={firstTask} onChange={e => setFirstTask(e.target.value)} disabled={locked}><option value="">양도할 목표 선택</option>{ownTasks.map(t => <option key={t.id} value={t.id}>{cardLabel(t.cardId)} · {taskTokenDescription(t)}</option>)}</select></label>
        <label>받을 대원<select value={primary} onChange={e => setPrimary(e.target.value)} disabled={locked}><option value="">대원 선택</option>{snapshot.players.filter(p => p.id !== mineId).map(p => <option key={p.id} value={p.id}>{p.nickname}</option>)}</select></label>
        <button className="primary" disabled={locked || !selectedTask || selectedTask.ownerId !== mineId || !primary} onClick={() => onSend({ type: "transfer_task", taskId: firstTask, playerId: primary })}>목표 양도 확정</button>
      </div>}
      {commander && <button className="secondary" disabled={locked} onClick={() => onSend({ type: "skip_transfer" })}>양도 없이 시작</button>}
    </>}
    {prep.stage === "distress_cards" && <>
      <p>보낼 일반 카드 한 장을 선택하세요. 모든 대원이 선택하면 동시에 이동합니다. 선택한 카드는 다른 대원에게 공개되지 않습니다.</p>
      <p className="helper">선택 완료 {prep.answeredPlayerIds.length}/{snapshot.players.length}명</p>
      {answered ? <p role="status">카드 선택을 저장했습니다. 다른 대원의 선택을 기다립니다.</p> : <><div className="preparation-card-choices">{snapshot.me.hand.filter(id => suitOf(id) !== "rocket").map(id => <button type="button" key={id} disabled={locked} aria-label={cardLabel(id)} aria-pressed={card === id} onClick={() => setCard(id)}><img src={cardImage(id)} alt={cardLabel(id)} /></button>)}</div><button className="primary" disabled={locked || !card} onClick={() => onSend({ type: "select_distress_card", cardId: card })}>교환 카드 확정</button></>}
    </>}
  </section>;
}
