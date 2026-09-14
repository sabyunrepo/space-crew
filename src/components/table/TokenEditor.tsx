import { useState } from "react";
import type { Command, Snapshot } from "../../../shared/contracts.ts";
import { cardLabel } from "../../../shared/cards.ts";
import { missionRules } from "../../../shared/missionRules.ts";
import { TaskCard } from "./TaskCard.tsx";
import { taskTokenDescription } from "./taskToken.ts";

export function TokenEditor({ snapshot, locked, onSend }: {
  snapshot: Snapshot; locked: boolean; onSend(command: Command): void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const commander = snapshot.commanderId === snapshot.me.playerId;
  const moving = snapshot.missionId === 40;
  const originalTokens = missionRules(snapshot.missionId!).tokens;
  const complete = selected.length === 2;
  const preview = selected.length ? snapshot.tasks.map((task, index) => ({
    ...task, token: originalTokens[index] ?? null, order: originalTokens[index]?.value ?? null,
  })) : snapshot.tasks;
  if (complete) {
    const first = preview.find(t => t.id === selected[0])!;
    const second = preview.find(t => t.id === selected[1])!;
    [first.token, second.token] = [second.token, first.token];
    [first.order, second.order] = [second.order, first.order];
  }
  function choose(id: string) {
    if (selected.includes(id)) setSelected(id === selected[0] ? [] : selected.slice(0, 1));
    else setSelected(selected.length === 1 ? [...selected, id] : [id]);
  }
  return <div className="token-editor">
    <p>{moving ? "토큰이 있는 카드와 옮겨 받을 카드를 선택하세요." : "카드 두 장을 선택하면 순서 토큰이 서로 바뀝니다."}</p>
    <div className="token-card-grid" aria-label="순서 토큰 카드 선택">
      {preview.map((task, index) => {
        const picked = selected.includes(task.id);
        const eligible = !moving || picked || (selected.length === 1 ? !originalTokens[index] : !!originalTokens[index]);
        const content = <><TaskCard task={task} focusable={!commander} /><span className="token-card-name">{cardLabel(task.cardId)}</span><span className="token-card-order">{taskTokenDescription(task)}</span></>;
        return commander ? <button type="button" key={task.id} className={`token-choice ${complete && picked ? "preview-changed" : ""}`}
          aria-label={`${cardLabel(task.cardId)} · ${taskTokenDescription(task)}`} aria-pressed={picked}
          disabled={locked || !eligible} onClick={() => choose(task.id)}>{content}</button>
          : <div key={task.id} className="token-choice">{content}</div>;
      })}
    </div>
    {commander ? <>
      <p className="token-preview-status" role="status">{complete ? "변경 미리보기 · 확인하면 이 배치로 목표 선택을 시작합니다." : selected.length ? "두 번째 카드를 선택하세요." : "변경 없이 현재 배치를 확정해도 됩니다."}</p>
      <div className="preparation-actions">
        <button type="button" className="secondary" disabled={locked || !selected.length} onClick={() => setSelected([])}>선택 취소</button>
        <button type="button" className="primary" disabled={locked || selected.length === 1}
          onClick={() => onSend({ type: "confirm_tokens", ...(complete ? { firstTaskId: selected[0], secondTaskId: selected[1] } : {}) })}>현재 토큰 배치 확정</button>
      </div>
    </> : <p className="helper">지휘관이 토큰 배치를 확정하고 있습니다.</p>}
  </div>;
}
