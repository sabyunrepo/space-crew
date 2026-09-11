import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Orbit,
  Radio,
  Rocket,
  Users,
  X,
} from "lucide-react";
import type {
  CardId,
  Command,
  Connection,
  GameService,
  Mission,
  Snapshot,
} from "../../../shared/contracts.ts";
import { cardLabel } from "../../../shared/cards.ts";
import { communicationMarkers } from "../../game/engine.ts";
import { StatusBar } from "./StatusBar.tsx";
import { PlayerPanel } from "./PlayerPanel.tsx";
import { MissionPanel } from "./MissionPanel.tsx";
import { TrickArea } from "./TrickArea.tsx";
import { Hand } from "./Hand.tsx";
import { handAvailability } from "./cardRules.ts";

const markerLabels = {
  highest: "이 색 중 가장 높음",
  lowest: "이 색 중 가장 낮음",
  only: "이 색은 이 카드뿐",
};

function statusMessage(
  snapshot: Snapshot,
  mineId: string | undefined,
  serviceMode: GameService["mode"],
): string {
  const nickOf = (id: string | null) =>
    snapshot.players.find((p) => p.id === id)?.nickname ?? "";
  switch (snapshot.phase) {
    case "lobby": {
      const ready = snapshot.players.filter((p) => p.ready).length;
      return `모든 대원이 준비되면 시작합니다 · ${ready}/${snapshot.settings.capacity}명 준비`;
    }
    case "briefing":
      return `미션 ${String(snapshot.missionId).padStart(2, "0")} 개요를 확인하세요`;
    case "task_selection":
      return snapshot.turnPlayerId === mineId
        ? "당신이 맡을 목표를 선택하세요"
        : `${nickOf(snapshot.turnPlayerId)} 대원이 목표를 고르는 중입니다`;
    case "playing":
      return snapshot.turnPlayerId === mineId
        ? "당신의 차례입니다 · 카드를 내세요"
        : `${nickOf(snapshot.turnPlayerId)} 대원의 차례입니다`;
    case "trick_result": {
      const base = snapshot.lastTrick
        ? `${nickOf(snapshot.lastTrick.winnerId)} 대원이 이번 트릭을 가져갔습니다`
        : "트릭을 정리하는 중입니다";
      // 서버 모드는 트릭 결과를 잠시 보여준 뒤 자동으로 다음 트릭을
      // 진행한다(server/rooms.ts) — 아무도 누르지 않아도 넘어간다는 것을
      // 안내한다.
      return serviceMode === "server"
        ? `${base} · 잠시 후 자동으로 다음 트릭`
        : base;
    }
    case "success":
      return "임무 성공! 모든 목표를 완수했습니다";
    case "failure":
      return snapshot.resultReason
        ? `임무 실패 · ${snapshot.resultReason}`
        : "임무 실패";
    case "campaign_complete":
      return snapshot.resultReason || "플레이 가능한 임무를 모두 마쳤습니다";
  }
}

export function GameTable({
  snapshot,
  mine,
  isHost,
  currentMission,
  catalogue,
  locked,
  connection,
  serviceMode,
  selected,
  setSelected,
  onBack,
  onCopyInvite,
  onSend,
  onFillDemoCrew,
  onDemoStep,
}: {
  snapshot: Snapshot;
  mine: Snapshot["players"][number] | undefined;
  isHost: boolean;
  currentMission: Mission | undefined;
  catalogue: Mission[];
  locked: boolean;
  connection: Connection;
  serviceMode: GameService["mode"];
  selected: CardId | null;
  setSelected(id: CardId | null): void;
  onBack(): void;
  onCopyInvite(): void;
  onSend(command?: Command): void;
  onFillDemoCrew?(): void;
  onDemoStep?(): void;
}) {
  const [communicateMode, setCommunicateMode] = useState(false);
  const [hint, setHint] = useState("");
  const hintTimer = useRef<number>(undefined);
  useEffect(() => {
    if (snapshot.phase !== "playing") setCommunicateMode(false);
  }, [snapshot.phase]);
  const showHint = (reason: string) => {
    setHint(reason);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 4000);
  };
  const handMode =
    snapshot.phase !== "playing"
      ? "view"
      : communicateMode
        ? "communicate"
        : "play";
  const availability = handAvailability(snapshot, handMode);
  const selectedEntry = availability.find((a) => a.cardId === selected);
  useEffect(() => {
    if (selected && selectedEntry && !selectedEntry.enabled)
      setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntry?.enabled, selected]);
  const markers = selected ? communicationMarkers(snapshot.me.hand, selected) : [];

  const lobby = snapshot.phase === "lobby";
  const nextPlayable = catalogue.find(
    (m) => m.id === snapshot.missionId! + 1,
  )?.playable;
  let action:
    | { label: string; icon?: ReactNode; onClick(): void; disabled?: boolean }
    | null = null;
  if (snapshot.phase === "briefing")
    action = mine?.briefingReady
      ? {
          label: "다른 대원을 기다리는 중",
          disabled: true,
          onClick: () => {},
        }
      : {
          label: "임무 확인 완료",
          icon: <Check size={16} />,
          disabled: locked,
          onClick: () => onSend({ type: "briefing_ready" }),
        };
  else if (
    snapshot.phase === "trick_result" &&
    (isHost || serviceMode === "server")
  )
    action = {
      label: "다음 트릭",
      icon: <ArrowRight size={16} />,
      disabled: locked,
      onClick: () => onSend({ type: "advance_trick" }),
    };
  else if (
    (snapshot.phase === "success" || snapshot.phase === "failure") &&
    isHost
  )
    action = {
      label: snapshot.phase === "success" ? "다음 임무" : "같은 미션 다시 도전",
      icon: <ArrowRight size={16} />,
      disabled:
        locked ||
        (snapshot.phase === "success" &&
          snapshot.settings.missionMode === "sequential" &&
          !nextPlayable),
      onClick: () =>
        onSend({
          type: snapshot.phase === "success" ? "next_mission" : "retry_mission",
        }),
    };

  const demoStepVisible =
    onDemoStep &&
    ((snapshot.phase === "briefing" &&
      snapshot.players.some((p) => p.isDemo && !p.briefingReady)) ||
      (["playing", "task_selection"].includes(snapshot.phase) &&
        snapshot.players.some(
          (p) => p.isDemo && p.id === snapshot.turnPlayerId,
        )));
  // task_selection 단계에서는 미션 패널이 항상 펼쳐져 그 안(오버레이)에서 보여줘야
  // TrickArea 자리의 다른 버튼을 가리지 않는다.
  const demoStepButton = demoStepVisible && (
    <button
      className="demo-step secondary"
      disabled={locked}
      onClick={onDemoStep}
    >
      데모 대원 진행 <ChevronRight size={16} />
    </button>
  );

  return (
    <div className={`game-table ${lobby ? "game-table--lobby" : ""}`}>
      <StatusBar
        title={snapshot.settings.name}
        message={statusMessage(snapshot, mine?.id, serviceMode)}
        onBack={onBack}
        action={action}
        connection={connection}
        serviceMode={serviceMode}
        isHost={isHost}
        onInvite={onCopyInvite}
      />
      <div className="game-table-body">
        {!lobby && (
          <MissionPanel
            snapshot={snapshot}
            currentMission={currentMission}
            mineId={mine?.id}
            locked={locked}
            onChooseTask={(taskId) => onSend({ type: "choose_task", taskId })}
            footer={
              snapshot.phase === "task_selection" && demoStepButton
                ? demoStepButton
                : undefined
            }
          />
        )}
        <div className="game-table-center">
          {lobby ? (
            <div className="lobby-stage">
              <div className="lobby-orbit">
                <Rocket size={46} />
              </div>
              <p className="eyebrow">WAITING FOR THE CREW</p>
              <h2>
                모든 대원이 모이면,
                <br />
                여정이 시작돼요.
              </h2>
              <p>
                임무{" "}
                {snapshot.settings.missionMode === "random"
                  ? "랜덤 선택"
                  : `${String(snapshot.settings.startMission).padStart(2, "0")} · ${currentMission?.title}`}
              </p>
              <div className="lobby-actions">
                <button
                  className={mine?.ready ? "secondary" : "primary"}
                  disabled={locked}
                  onClick={() =>
                    onSend({ type: "set_ready", ready: !mine?.ready })
                  }
                >
                  <Check size={17} />
                  {mine?.ready ? "준비 취소" : "탑승 준비 완료"}
                </button>
                {isHost &&
                  onFillDemoCrew &&
                  snapshot.players.length < snapshot.settings.capacity && (
                    <button
                      className="secondary"
                      disabled={locked}
                      onClick={onFillDemoCrew}
                    >
                      <Users size={17} />
                      데모 대원 채우기
                    </button>
                  )}
              </div>
              {isHost && (
                <button
                  className="primary full start-button"
                  disabled={
                    locked ||
                    (!currentMission?.playable &&
                      snapshot.settings.missionMode !== "random") ||
                    snapshot.players.length !== snapshot.settings.capacity ||
                    snapshot.players.some((p) => !p.ready)
                  }
                  onClick={() => onSend({ type: "start_mission" })}
                >
                  임무 시작 <ArrowRight size={18} />
                </button>
              )}
              {!currentMission?.playable &&
                snapshot.settings.missionMode === "sequential" && (
                  <p className="helper warning">
                    미션 {currentMission?.id}의 특수 규칙은 구현 예정입니다.
                    현재 미션 1~4를 플레이할 수 있습니다.
                  </p>
                )}
              {isHost && (
                <label className="lobby-mission">
                  시작 미션 변경
                  <select
                    disabled={locked}
                    value={snapshot.settings.startMission}
                    onChange={(e) =>
                      onSend({
                        type: "update_settings",
                        settings: {
                          ...snapshot.settings,
                          startMission: Number(e.target.value),
                          missionMode: "sequential",
                        },
                      })
                    }
                  >
                    {catalogue.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} · {m.title}
                        {m.playable ? "" : " (구현 예정)"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="helper">
                데모 대원은 규칙 확인용입니다. 협력 전략을 판단하는 AI는
                아닙니다.
              </p>
            </div>
          ) : snapshot.phase === "briefing" ? (
            <div className="briefing">
              <Orbit size={35} />
              <h3>손패를 확인하고, 임무를 읽어 주세요.</h3>
              <p>
                로켓 4를 가진{" "}
                {
                  snapshot.players.find((p) => p.id === snapshot.commanderId)
                    ?.nickname
                }{" "}
                대원이 사령관입니다.
                <br />
                모두 확인하면 사령관부터 목표를 선택합니다.
              </p>
            </div>
          ) : (
            <TrickArea snapshot={snapshot} mineId={mine?.id} />
          )}
          {snapshot.phase !== "task_selection" && demoStepButton}
        </div>
        <PlayerPanel snapshot={snapshot} mineId={mine?.id} />
      </div>
      {!lobby && (
      <div className="hand-dock">
        {hint && (
          <p className="hand-hint" role="status">
            {hint}
          </p>
        )}
        <div className="hand-dock-head">
          <h3>
            내 손패 <span>{snapshot.me.hand.length}장</span>
          </h3>
          {communicateMode ? (
            <button
              type="button"
              className="secondary hand-comm-cancel"
              onClick={() => {
                setCommunicateMode(false);
                setSelected(null);
              }}
            >
              <X size={14} />
              교신 취소
            </button>
          ) : (
            snapshot.phase === "playing" &&
            snapshot.me.canCommunicate && (
              <button
                type="button"
                className="secondary hand-comm-toggle"
                disabled={locked}
                onClick={() => {
                  setSelected(null);
                  setCommunicateMode(true);
                }}
              >
                <Radio size={14} />
                교신하기
              </button>
            )
          )}
        </div>
        <Hand
          cards={availability}
          selected={selected}
          onSelect={(cardId) => setSelected(selected === cardId ? null : cardId)}
          onBlocked={showHint}
        />
        {communicateMode ? (
          selected && markers.length > 0 ? (
            <div className="communication-options">
              <Radio size={17} />
              <span>이 카드로 교신할게요</span>
              {markers.map((marker) => (
                <button
                  className="secondary"
                  disabled={locked}
                  key={marker}
                  onClick={() => {
                    onSend({ type: "communicate", cardId: selected, marker });
                    setCommunicateMode(false);
                  }}
                >
                  {markerLabels[marker]}
                </button>
              ))}
            </div>
          ) : (
            <p className="hand-controls-hint">교신할 카드를 선택하세요.</p>
          )
        ) : (
          <div className="hand-controls">
            <span>
              {selected
                ? cardLabel(selected)
                : "카드를 선택해 자세히 확인하세요."}
            </span>
            <button
              className="primary"
              disabled={
                locked ||
                !selected ||
                !snapshot.me.legalCardIds.includes(selected)
              }
              onClick={() =>
                selected && onSend({ type: "play_card", cardId: selected })
              }
            >
              선택한 카드 내기 <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
