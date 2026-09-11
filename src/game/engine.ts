import {
  ApiError,
  API_VERSION,
  RULESET_VERSION,
  type CardId,
  type Command,
  type RoomSettings,
  type Snapshot,
} from "../../shared/contracts.ts";
import { deck, rankOf, sortCards, suitOf } from "../../shared/cards.ts";
import missions from "../../shared/missions.json";
export type State = Omit<Snapshot, "me"> & { hands: Record<string, CardId[]> };
export function fail(code: string, message: string, status = 409): never {
  throw new ApiError(code, message, status);
}
const requireThat = (condition: unknown, message: string) => {
  if (!condition) fail("INVALID_ACTION", message);
};
export const shuffled = <T>(items: T[], random = Math.random): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
export function newPlayer(
  id: string,
  nickname: string,
  seat: number,
  isDemo = false,
): Snapshot["players"][number] {
  return {
    id,
    nickname,
    seat,
    isDemo,
    ready: isDemo,
    briefingReady: false,
    cardCount: 0,
    tricksWon: 0,
    communication: null,
  };
}
export function createState(
  id: string,
  nickname: string,
  settings: RoomSettings,
): State {
  return {
    apiVersion: API_VERSION,
    rulesetVersion: RULESET_VERSION,
    roomId: crypto.randomUUID(),
    revision: 0,
    settings,
    phase: "lobby",
    missionId: null,
    drawnMissionIds: [],
    attemptId: null,
    attemptNumber: 0,
    hostId: id,
    commanderId: null,
    turnPlayerId: null,
    players: [newPlayer(id, nickname, 0)],
    hands: { [id]: [] },
    tasks: [],
    trick: [],
    lastTrick: null,
    trickNumber: 0,
    resultReason: null,
    updatedAt: new Date().toISOString(),
  };
}
export function legalCards(state: State, playerId: string): CardId[] {
  if (state.phase !== "playing" || state.turnPlayerId !== playerId) return [];
  const hand = state.hands[playerId] ?? [];
  const led = state.trick[0]?.cardId;
  const matching = led
    ? hand.filter((card) => suitOf(card) === suitOf(led))
    : [];
  return matching.length ? matching : hand;
}
export function communicationMarkers(
  hand: CardId[],
  card: CardId,
): ("highest" | "lowest" | "only")[] {
  if (!hand.includes(card) || suitOf(card) === "rocket") return [];
  const family = hand.filter((c) => suitOf(c) === suitOf(card));
  if (family.length === 1) return ["only"];
  const ranks = family.map(rankOf);
  return [
    ...(rankOf(card) === Math.max(...ranks) ? ["highest" as const] : []),
    ...(rankOf(card) === Math.min(...ranks) ? ["lowest" as const] : []),
  ];
}
export function project(state: State, playerId: string): Snapshot {
  if (!state.players.some((p) => p.id === playerId))
    fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
  const { hands, ...publicState } = structuredClone(state);
  const player = state.players.find((p) => p.id === playerId)!;
  return {
    ...publicState,
    me: {
      playerId,
      hand: sortCards(hands[playerId] ?? []),
      legalCardIds: legalCards(state, playerId),
      canCommunicate:
        state.phase === "playing" &&
        state.trick.length === 0 &&
        !player.communication &&
        (hands[playerId] ?? []).some((c) => suitOf(c) !== "rocket"),
    },
  };
}
function begin(state: State, missionId: number, random: () => number) {
  const mission = missions.find((m) => m.id === missionId && m.playable);
  if (!mission)
    fail(
      "MISSION_NOT_IMPLEMENTED",
      "이 데모에서는 미션 1~4를 플레이할 수 있습니다. 선택한 미션은 백엔드 규칙 구현 후 열립니다.",
      422,
    );
  state.missionId = missionId;
  state.attemptId = crypto.randomUUID();
  state.attemptNumber += 1;
  if (!state.drawnMissionIds.includes(missionId))
    state.drawnMissionIds.push(missionId);
  state.phase = "briefing";
  state.tasks = [];
  state.trick = [];
  state.lastTrick = null;
  state.resultReason = null;
  state.trickNumber = 1;
  state.players.forEach((p) => {
    state.hands[p.id] = [];
    p.briefingReady = false;
    p.communication = null;
    p.tricksWon = 0;
  });
  shuffled(deck(), random).forEach((card, i) =>
    state.hands[state.players[i % state.players.length].id].push(card),
  );
  state.players.forEach((p) => (p.cardCount = state.hands[p.id].length));
  state.commanderId = state.players.find((p) =>
    state.hands[p.id].includes("rocket-4"),
  )!.id;
  state.turnPlayerId = state.commanderId;
  state.tasks = shuffled(
    deck().filter((c) => suitOf(c) !== "rocket"),
    random,
  )
    .slice(0, mission.taskCount)
    .map((cardId, i) => ({
      id: crypto.randomUUID(),
      cardId,
      ownerId: null,
      order: missionId === 3 ? i + 1 : null,
      status: "pending",
    }));
}
export function winner(plays: Snapshot["trick"]): string {
  const led = suitOf(plays[0].cardId);
  const eligible = plays.filter((p) => suitOf(p.cardId) === "rocket").length
    ? plays.filter((p) => suitOf(p.cardId) === "rocket")
    : plays.filter((p) => suitOf(p.cardId) === led);
  return eligible.reduce((best, p) =>
    rankOf(p.cardId) > rankOf(best.cardId) ? p : best,
  ).playerId;
}
function resolve(state: State) {
  const winnerId = winner(state.trick);
  state.lastTrick = { plays: [...state.trick], winnerId };
  state.players.find((p) => p.id === winnerId)!.tricksWon += 1;
  const caught = state.tasks.filter(
    (t) =>
      t.status === "pending" && state.trick.some((p) => p.cardId === t.cardId),
  );
  const earlierMissing = caught.some(
    (t) =>
      t.order &&
      state.tasks.some(
        (prior) =>
          prior.order &&
          prior.order < t.order! &&
          prior.status === "pending" &&
          !caught.includes(prior),
      ),
  );
  const wrongOwner = caught.some((t) => t.ownerId !== winnerId);
  caught.forEach(
    (t) => (t.status = wrongOwner || earlierMissing ? "failed" : "success"),
  );
  if (wrongOwner || earlierMissing) {
    state.phase = "failure";
    state.resultReason = wrongOwner
      ? "목표 카드를 담당 대원이 아닌 다른 대원이 획득했습니다."
      : "목표 카드를 정해진 순서보다 먼저 획득했습니다.";
  } else if (state.tasks.every((t) => t.status === "success")) {
    state.phase = "success";
    state.resultReason = "모든 목표 카드를 팀이 무사히 획득했습니다.";
  } else if (state.players.some((p) => state.hands[p.id].length === 0)) {
    state.phase = "failure";
    state.resultReason =
      "플레이할 트릭이 남아 있지 않습니다. 아직 완료하지 못한 목표가 있습니다.";
  } else state.phase = "trick_result";
  state.turnPlayerId = winnerId;
}
export function applyCommand(
  input: State,
  actor: string,
  command: Command,
  random = Math.random,
): State {
  const state = structuredClone(input);
  const me = state.players.find((p) => p.id === actor);
  if (!me) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
  const host = () =>
    requireThat(state.hostId === actor, "방장만 진행할 수 있습니다.");
  const phase = (...values: State["phase"][]) =>
    requireThat(
      values.includes(state.phase),
      "현재 단계에서 할 수 없는 행동입니다.",
    );
  const nextSeat = () =>
    state.players[
      (state.players.findIndex((p) => p.id === actor) + 1) %
        state.players.length
    ].id;
  switch (command.type) {
    case "update_settings":
      host();
      phase("lobby");
      requireThat(
        command.settings.capacity >= state.players.length,
        "현재 대원 수보다 작게 설정할 수 없습니다.",
      );
      state.settings = command.settings;
      state.players.forEach((p) => (p.ready = p.isDemo));
      break;
    case "set_ready":
      phase("lobby");
      me.ready = command.ready;
      break;
    case "start_mission": {
      host();
      phase("lobby");
      requireThat(
        state.players.length === state.settings.capacity &&
          state.players.every((p) => p.ready),
        "모든 좌석을 채우고 준비를 완료해 주세요.",
      );
      const id =
        state.settings.missionMode === "random"
          ? shuffled(
              missions.filter((m) => m.playable).map((m) => m.id),
              random,
            )[0]
          : state.settings.startMission;
      begin(state, id, random);
      break;
    }
    case "briefing_ready":
      phase("briefing");
      me.briefingReady = true;
      if (state.players.every((p) => p.briefingReady))
        state.phase = "task_selection";
      break;
    case "choose_task": {
      phase("task_selection");
      requireThat(
        state.turnPlayerId === actor,
        "목표를 선택할 차례가 아닙니다.",
      );
      const task = state.tasks.find((t) => t.id === command.taskId);
      requireThat(task && !task.ownerId, "선택할 수 없는 목표입니다.");
      task!.ownerId = actor;
      if (state.tasks.every((t) => t.ownerId)) {
        state.phase = "playing";
        state.turnPlayerId = state.commanderId;
      } else state.turnPlayerId = nextSeat();
      break;
    }
    case "communicate":
      phase("playing");
      requireThat(
        state.trick.length === 0 && !me.communication,
        "교신은 트릭 시작 전 임무당 한 번 가능합니다.",
      );
      requireThat(
        communicationMarkers(state.hands[actor], command.cardId).includes(
          command.marker,
        ),
        "현재 손패와 일치하는 교신 표시를 선택해 주세요.",
      );
      me.communication = {
        cardId: command.cardId,
        marker: command.marker,
        played: false,
      };
      break;
    case "play_card":
      phase("playing");
      requireThat(
        legalCards(state, actor).includes(command.cardId),
        "자기 차례에 선도 색을 따르는 카드를 내야 합니다.",
      );
      state.hands[actor] = state.hands[actor].filter(
        (c) => c !== command.cardId,
      );
      me.cardCount = state.hands[actor].length;
      if (me.communication?.cardId === command.cardId)
        me.communication.played = true;
      state.trick.push({ playerId: actor, cardId: command.cardId });
      state.turnPlayerId = nextSeat();
      if (state.trick.length === state.players.length) resolve(state);
      break;
    case "advance_trick":
      phase("trick_result");
      state.trick = [];
      state.trickNumber += 1;
      state.phase = "playing";
      break;
    case "retry_mission":
      host();
      phase("failure");
      begin(state, state.missionId!, random);
      break;
    case "next_mission": {
      host();
      phase("success");
      let id: number | undefined;
      if (state.settings.missionMode === "random") {
        const remaining = missions
          .filter((m) => m.playable && !state.drawnMissionIds.includes(m.id))
          .map((m) => m.id);
        id = shuffled(remaining, random)[0];
      } else {
        const next = state.missionId! + 1;
        id = missions.find((m) => m.id === next && m.playable)
          ? next
          : undefined;
      }
      if (!id || id > 50) {
        state.phase = "campaign_complete";
        state.resultReason = "플레이 가능한 임무를 모두 마쳤습니다.";
      } else begin(state, id, random);
      break;
    }
  }
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  return state;
}
