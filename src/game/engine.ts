import {
  ApiError,
  API_VERSION,
  RULESET_VERSION,
  type CardId,
  type CharacterId,
  CharacterIdSchema,
  type Command,
  type RoomSettings,
  type Snapshot,
} from "../../shared/contracts.ts";
import { deck, rankOf, sortCards, suitOf } from "../../shared/cards.ts";
import missions from "../../shared/missions.json";
import { missionRules, roleIncludesCommander, type TaskToken } from "../../shared/missionRules.ts";
interface SetupState {
  roleDone: boolean; tokensDone: boolean; assignmentDone: boolean; transferDone: boolean;
  distressDirection: "left" | "right" | null; distressResolved: boolean;
  distressCards: Record<string, CardId>; distressEverUsed: boolean;
  originalTokens: (TaskToken | null)[];
}
export type State = Omit<Snapshot, "me"> & { hands: Record<string, CardId[]>; setup?: SetupState };
/** Commands that must apply against the latest state instead of bouncing a
 * stale expectedRevision: they are actor-idempotent (re-applying the same
 * value is a no-op) so a lobby/briefing race between players shouldn't force
 * a client to retry. Every other command keeps the strict revision check.
 * Shared by every backend storage (Node RoomStore, Postgres repository). */
export const REVISION_BYPASS_COMMANDS = new Set(["set_ready", "briefing_ready"]);
const freshProgress = (): NonNullable<Snapshot["missionProgress"]> => ({
  selectedPlayerId: null, secondaryPlayerId: null, silentPlayerId: null, blackNineHolderId: null,
  oneWins: 0, ninesPlayed: 0, rocketsWon: [], blackCardsWon: 0, transferApplied: false, distressUsed: false, distressActive: false,
});
const freshSetup = (): SetupState => ({ roleDone: false, tokensDone: false, assignmentDone: false,
  transferDone: false, distressDirection: null, distressResolved: false, distressCards: {}, distressEverUsed: false, originalTokens: [] });
function normalize(state: State) {
  state.missionProgress ??= freshProgress();
  state.preparation ??= null;
  state.waitingPlayers ??= [];
  state.waitingPolicy ??= null;
  // Old saves contain only missions 1–4 and no setup state.
  state.setup ??= { ...freshSetup(), assignmentDone: state.tasks.length > 0 && state.tasks.every(t => t.ownerId !== null) };
}

function compactSeats(state: State) {
  state.players = [...state.players].sort((a, b) => a.seat - b.seat).map((p, seat) => ({ ...p, seat }));
  state.waitingPlayers = [...(state.waitingPlayers ?? [])].map((p, i) => ({ ...p, seat: state.players.length + i }));
}

function promoteWaiting(state: State) {
  if (!state.waitingPlayers?.length) return;
  state.players.push(...state.waitingPlayers);
  state.waitingPlayers = [];
  state.waitingPolicy = null;
  compactSeats(state);
  state.players.forEach((p) => { state.hands[p.id] ??= []; });
}

function resetToLobby(state: State) {
  state.phase = "lobby";
  state.missionId = null;
  state.attemptId = null;
  state.attemptNumber = 0;
  state.commanderId = null;
  state.turnPlayerId = null;
  state.tasks = [];
  state.trick = [];
  state.lastTrick = null;
  state.trickNumber = 0;
  state.resultReason = null;
  state.restartVote = null;
  state.preparation = null;
  state.missionProgress = freshProgress();
  state.setup = freshSetup();
  state.players.forEach((p) => { p.ready = p.isDemo; p.briefingReady = false; p.cardCount = 0; p.tricksWon = 0; p.communication = null; });
  state.hands = Object.fromEntries(state.players.map((p) => [p.id, []]));
}

/** Removes a member atomically. During a mission the remaining crew gets a
 * fresh attempt with the same mission when at least three members remain;
 * otherwise the room returns to the lobby until another member joins. */
export function removePlayer(input: State, playerId: string, random = Math.random): State {
  const state = structuredClone(input);
  normalize(state);
  if (state.players.length <= 1 && !(state.waitingPlayers ?? []).length && state.players.some((p) => p.id === playerId))
    fail("LAST_MEMBER", "마지막 대원은 방을 나갈 수 없습니다.");
  const waitingIndex = (state.waitingPlayers ?? []).findIndex((p) => p.id === playerId);
  if (waitingIndex >= 0) {
    state.waitingPlayers = (state.waitingPlayers ?? []).filter((_, i) => i !== waitingIndex);
    delete state.hands[playerId];
  } else {
    const leaving = state.players.find((p) => p.id === playerId);
    if (!leaving) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
    state.players = state.players.filter((p) => p.id !== playerId);
    delete state.hands[playerId];
    compactSeats(state);
    if (state.hostId === playerId) state.hostId = state.players[0].id;
    state.restartVote = null;
    if (state.phase !== "lobby") {
      const playable = state.missionId !== null && missions.some((m) => m.id === state.missionId && m.playable);
      if (state.players.length >= 3 && playable) begin(state, state.missionId!, random);
      else { promoteWaiting(state); resetToLobby(state); }
    }
  }
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  return state;
}
function seatAfter(state: State, playerId: string, offset = 1) {
  const ordered = [...state.players].sort((a, b) => a.seat - b.seat);
  return ordered[(ordered.findIndex(p => p.id === playerId) + offset + ordered.length) % ordered.length].id;
}
function mayCommunicate(state: State, playerId: string) {
  const rules = missionRules(state.missionId ?? 1);
  const player = state.players.find(p => p.id === playerId)!;
  return state.phase === "playing" && !state.restartVote && (state.rulesetVersion === "crew-p9-50-4" || state.trick.length === 0) && !player.communication &&
    state.trickNumber >= rules.communication.fromTrick && state.missionProgress?.silentPlayerId !== playerId &&
    (state.hands[playerId] ?? []).some(c => communicationMarkers(state.hands[playerId], c).length > 0);
}
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
  characterId: CharacterId = CharacterIdSchema.options[seat % CharacterIdSchema.options.length],
): Snapshot["players"][number] {
  return {
    id,
    nickname,
    characterId,
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
  characterId?: CharacterId,
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
    players: [newPlayer(id, nickname, 0, false, characterId)],
    waitingPlayers: [],
    waitingPolicy: null,
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
  normalize(state);
  const activeMember = state.players.some((p) => p.id === playerId);
  const waitingMember = (state.waitingPlayers ?? []).some((p) => p.id === playerId);
  if (!activeMember && !waitingMember) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
  const { hands, setup: _privateSetup, ...publicState } = structuredClone(state);
  const rules = missionRules(state.missionId ?? 1);
  let tasks = publicState.tasks;
  if (rules.assignment === "decision" && !state.setup?.assignmentDone)
    tasks = [];
  if (rules.assignment === "distribution" && !state.setup?.assignmentDone)
    tasks = tasks.filter(t => t.ownerId || t.id === state.preparation?.activeTaskId);
  return {
    ...publicState, tasks, hiddenTaskCount: state.tasks.length - tasks.length,
    preparation: publicState.preparation ?? null,
    missionProgress: publicState.missionProgress ?? freshProgress(),
    me: { playerId, hand: activeMember ? sortCards(hands[playerId] ?? []) : [], legalCardIds: activeMember ? legalCards(state, playerId) : [], canCommunicate: activeMember ? mayCommunicate(state, playerId) : false },
  };
}
function prepare(state: State, stage: NonNullable<Snapshot["preparation"]>["stage"], eligiblePlayerIds = state.players.map(p => p.id), activeTaskId: string | null = null) {
  state.phase = "preparation";
  state.turnPlayerId = state.commanderId;
  state.preparation = { stage, eligiblePlayerIds, activeTaskId, responses: {}, answeredPlayerIds: [] };
}
function distributionTargets(state: State) {
  const min = Math.floor(state.tasks.length / state.players.length);
  const max = Math.ceil(state.tasks.length / state.players.length);
  const remaining = state.tasks.filter(t => !t.ownerId).length - 1;
  return state.players.filter(p => {
    const counts = state.players.map(other => state.tasks.filter(t => t.ownerId === other.id).length + (other.id === p.id ? 1 : 0));
    return Math.max(...counts) <= max && counts.reduce((n, count) => n + Math.max(0, min - count), 0) <= remaining;
  }).map(p => p.id);
}
function editTaskTokens(state: State, firstTaskId: string, secondTaskId: string) {
      const first = state.tasks.findIndex(t => t.id === firstTaskId);
      const second = state.tasks.findIndex(t => t.id === secondTaskId);
      requireThat(first >= 0 && second >= 0 && first !== second, "서로 다른 목표 두 장을 선택해 주세요.");
      const originals = state.setup!.originalTokens;
      requireThat(originals[first] && (state.missionId === 23 ? originals[second] : !originals[second]), state.missionId === 23 ? "토큰 두 개를 교환해 주세요." : "토큰 한 개를 토큰이 없는 목표로 이동해 주세요.");
      state.tasks.forEach((task, i) => { task.token = originals[i]; });
      [state.tasks[first].token, state.tasks[second].token] = [state.tasks[second].token, state.tasks[first].token];
      state.tasks.forEach(task => { task.order = task.token?.kind === "absolute" ? task.token.value! : null; });
}
function startPlaying(state: State) {
  state.phase = "playing"; state.preparation = null; state.turnPlayerId = state.commanderId;
  if (state.missionId === 46) {
    const holder = state.players.find(p => state.hands[p.id].includes("black-9"))!.id;
    state.missionProgress!.blackNineHolderId = holder;
    state.missionProgress!.selectedPlayerId = seatAfter(state, holder);
  }
}
function advanceSetup(state: State) {
  const setup = state.setup!;
  const id = state.missionId!;
  const rules = missionRules(id);
  if ([5,11,33,41,50].includes(id) && !setup.roleDone) {
    prepare(state, "role", state.players.filter(p => roleIncludesCommander(id, state.rulesetVersion) || p.id !== state.commanderId).map(p => p.id)); return;
  }
  if ([23,40].includes(id) && !setup.tokensDone) { prepare(state, "token_edit"); return; }
  if (!setup.assignmentDone && state.tasks.some(t => !t.ownerId)) {
    if (rules.assignment === "decision") prepare(state, "captain_decision", state.players.filter(p => p.id !== state.commanderId).map(p => p.id));
    else if (rules.assignment === "distribution") prepare(state, "captain_distribution", distributionTargets(state), state.tasks.find(t => !t.ownerId)!.id);
    else { state.phase = "task_selection"; state.preparation = null; state.turnPlayerId = state.commanderId; }
    return;
  }
  setup.assignmentDone = true;
  if (state.players.length === 5 && missions.find(m => m.id === id)?.fivePlayerTransfer && !setup.transferDone) {
    prepare(state, "task_transfer"); return;
  }
  if (!setup.distressResolved && (setup.distressDirection || id === 46 || setup.distressEverUsed)) {
    setup.distressDirection ??= "left";
    state.missionProgress!.distressDirection = setup.distressDirection;
    prepare(state, "distress_vote"); return;
  }
  startPlaying(state);
}
function begin(state: State, missionId: number, random: () => number) {
  const mission = missions.find((m) => m.id === missionId && m.playable);
  if (!mission)
    fail(
      "MISSION_NOT_IMPLEMENTED",
      "선택한 미션은 지원하지 않습니다.",
      422,
    );
  const distressEverUsed = state.missionId === missionId && (state.setup?.distressEverUsed ?? false);
  state.setup = { ...freshSetup(), distressEverUsed };
  state.missionProgress = { ...freshProgress(), distressActive: distressEverUsed };
  state.preparation = null;
  state.restartVote = null;
  state.rulesetVersion = RULESET_VERSION;
  state.attemptNumber = state.missionId === missionId ? state.attemptNumber + 1 : 1;
  state.missionId = missionId;
  state.attemptId = crypto.randomUUID();
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
  const goalLimit = Math.ceil(mission.taskCount / 4);
  const goalCounts = new Map<string, number>();
  // User-requested balanced draw: retain randomness without four of five goals
  // sharing a suit. This does not claim the resulting deal is always solvable.
  const goals = shuffled(deck().filter(c => suitOf(c) !== "rocket"), random).filter(card => {
    const suit = suitOf(card), count = goalCounts.get(suit) ?? 0;
    if (count >= goalLimit) return false;
    goalCounts.set(suit, count + 1);
    return true;
  }).slice(0, mission.taskCount);
  state.tasks = goals
    .map((cardId, i) => ({
      id: crypto.randomUUID(),
      cardId,
      ownerId: null,
      order: missionRules(missionId).tokens[i]?.kind === "absolute" ? missionRules(missionId).tokens[i].value! : null,
      token: missionRules(missionId).tokens[i] ?? null,
      status: "pending",
    }));
  state.setup.originalTokens = state.tasks.map(t => t.token ?? null);
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
function taskToken(task: State["tasks"][number]): TaskToken | null {
  return task.token === undefined ? (task.order ? { kind: "absolute", value: task.order } : null) : task.token;
}
/** Captures within a trick are simultaneous. A valid ordering must exist within this set. */
function badTaskOrder(state: State, caught: State["tasks"]) {
  const completed = state.tasks.filter(t => t.status === "success").length;
  const end = completed + caught.length;
  for (const task of state.tasks.filter(t => t.status === "pending")) {
    const token = taskToken(task);
    if (token?.kind === "absolute") {
      const inside = token.value! > completed && token.value! <= end;
      if (caught.includes(task) !== inside) return true;
    }
    if (token?.kind === "relative" && caught.includes(task)) {
      if (state.tasks.some(prior => taskToken(prior)?.kind === "relative" && taskToken(prior)!.value! < token.value! && prior.status === "pending" && !caught.includes(prior))) return true;
    }
    if (token?.kind === "omega" && caught.includes(task) && end !== state.tasks.length) return true;
  }
  return false;
}
function resolve(state: State, random: () => number) {
  const id = state.missionId!;
  const rules = missionRules(id);
  const progress = state.missionProgress!;
  const winnerId = winner(state.trick);
  const winningCard = state.trick.find(p => p.playerId === winnerId)!.cardId;
  const rocket = suitOf(winningCard) === "rocket";
  const winningRank = rankOf(winningCard);
  state.lastTrick = { plays: [...state.trick], winnerId };
  state.players.find(p => p.id === winnerId)!.tricksWon += 1;
  const exhausted = state.players.some(p => state.hands[p.id].length === 0);
  const caught = state.tasks.filter(t => t.status === "pending" && state.trick.some(p => p.cardId === t.cardId));
  const wrongOwner = caught.some(t => t.ownerId !== winnerId);
  const wrongOrder = badTaskOrder(state, caught);
  let reason: string | null = wrongOwner ? "목표 카드를 담당 대원이 아닌 다른 대원이 획득했습니다." : wrongOrder ? "목표 카드를 정해진 순서보다 먼저 획득했습니다." : null;
  caught.forEach(t => { t.status = reason ? "failed" : "success"; });
  if (rules.special.includes(16)) progress.ninesPlayed = (progress.ninesPlayed ?? 0) + state.trick.filter(p => suitOf(p.cardId) !== "rocket" && rankOf(p.cardId) === 9).length;
  if (rules.special.includes(16) && !rocket && winningRank === 9) reason = "일반 9 카드가 트릭에서 승리했습니다.";
  if (id === 5 && winnerId === progress.selectedPlayerId) reason = "지정 대원은 트릭에서 승리하면 안 됩니다.";
  if ([33,41].includes(id) && winnerId === progress.selectedPlayerId) {
    if (rocket) reason = "지정 대원은 일반 카드로만 승리해야 합니다.";
    if (id === 33 && state.players.find(p => p.id === winnerId)!.tricksWon > 1) reason = "지정 대원은 정확히 한 트릭만 승리해야 합니다.";
    if (id === 41 && state.trickNumber !== 1 && !exhausted) reason = "지정 대원은 첫 트릭과 마지막 트릭에서만 승리해야 합니다.";
  }
  if (id === 41 && (state.trickNumber === 1 || exhausted) && winnerId !== progress.selectedPlayerId) reason = "첫 트릭과 마지막 트릭은 지정 대원이 승리해야 합니다.";
  if (rules.special.includes(29)) {
    const counts = state.players.map(p => p.tricksWon);
    if (Math.max(...counts) - Math.min(...counts) > 1) reason = "매 트릭 뒤 대원들의 승수 차이는 1 이하여야 합니다.";
  }
  if (id === 34 && (state.trickNumber === 1 || exhausted) && winnerId !== state.commanderId) reason = "지휘관이 첫 트릭과 마지막 트릭을 승리해야 합니다.";
  if (id === 50) {
    const expected = state.trickNumber <= 4 ? progress.selectedPlayerId : exhausted ? progress.secondaryPlayerId : null;
    if ((expected && winnerId !== expected) || (!expected && [progress.selectedPlayerId, progress.secondaryPlayerId].includes(winnerId))) reason = "첫 4트릭·중간 트릭·마지막 트릭의 역할을 지키지 못했습니다.";
  }
  if ([9,26].includes(id)) {
    if (!rocket && winningRank === 1) progress.oneWins++;
    const needed = id === 9 ? 1 : 2;
    const remainingOnes = Object.values(state.hands).flat().filter(c => suitOf(c) !== "rocket" && rankOf(c) === 1).length;
    if (progress.oneWins + remainingOnes < needed) reason = "일반 1 카드로 필요한 횟수만큼 승리할 수 없습니다.";
  }
  if ([13,44].includes(id)) {
    const rockets = state.trick.filter(p => suitOf(p.cardId) === "rocket");
    if (rockets.length > 1) reason = "각 로켓이 따로 승리해야 합니다. 낮은 로켓이 패배했습니다.";
    if (rocket) {
      if (id === 44 && winningRank !== progress.rocketsWon.length + 1) reason = "로켓은 1 → 2 → 3 → 4 순서로 승리해야 합니다.";
      progress.rocketsWon.push(winningRank);
    }
  }
  if (id === 46) {
    const count = state.trick.filter(p => suitOf(p.cardId) === "black").length;
    if (count && winnerId !== progress.selectedPlayerId) reason = "검은색 카드는 검정 9 보유자의 왼쪽 대원이 모두 획득해야 합니다.";
    else progress.blackCardsWon += count;
  }
  if (id === 48 && caught.some(t => taskToken(t)?.kind === "omega") && !exhausted) reason = "Ω 목표는 마지막 트릭에서 획득해야 합니다.";
  if (id === 33 && exhausted && state.players.find(p => p.id === progress.selectedPlayerId)?.tricksWon !== 1) reason = "지정 대원은 정확히 한 트릭을 승리해야 합니다.";
  const success = rules.ending === "tasks" ? state.tasks.length > 0 && state.tasks.every(t => t.status === "success") && (id !== 17 || state.rulesetVersion !== "crew-p9-50-2" || progress.ninesPlayed === 4 || exhausted)
    : rules.ending === "full_hand" ? exhausted
    : rules.ending === "one_wins" ? progress.oneWins >= (id === 9 ? 1 : 2)
    : rules.ending === "rockets" ? new Set(progress.rocketsWon).size === 4
    : progress.blackCardsWon === 9;
  if (reason) { state.phase = "failure"; state.resultReason = reason; }
  else if (success) { state.phase = "success"; state.resultReason = "미션의 모든 조건을 달성했습니다."; }
  else if (exhausted) { state.phase = "failure"; state.resultReason = "플레이할 트릭이 남아 있지 않습니다. 미션 조건을 완료하지 못했습니다."; }
  else state.phase = "trick_result";
  if (["success", "failure"].includes(state.phase) && state.waitingPolicy === "after_mission")
    promoteWaiting(state);
  state.turnPlayerId = winnerId;
  if (id === 12 && state.trickNumber === 1 && !progress.transferApplied && state.phase === "trick_result") {
    // Author-relayed ruling: the publicly communicated card is not eligible; marker remains historical.
    const outgoing = state.players.map(p => {
      const cards = state.hands[p.id].filter(c => !(p.communication && !p.communication.played && p.communication.cardId === c));
      return { playerId: p.id, cardId: cards[Math.floor(random() * cards.length)] };
    });
    outgoing.forEach(({ playerId, cardId }) => { state.hands[playerId] = state.hands[playerId].filter(c => c !== cardId); });
    outgoing.forEach(({ playerId, cardId }) => { state.hands[seatAfter(state, playerId)].push(cardId); });
    progress.transferApplied = true;
  }
}
export function applyCommand(
  input: State,
  actor: string,
  command: Command,
  random = Math.random,
): State {
  const state = structuredClone(input);
  normalize(state);
  const me = state.players.find((p) => p.id === actor);
  if (!me) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
  const host = () =>
    requireThat(state.hostId === actor, "방장만 진행할 수 있습니다.");
  const phase = (...values: State["phase"][]) =>
    requireThat(
      values.includes(state.phase),
      "현재 단계에서 할 수 없는 행동입니다.",
    );
  const nextSeat = () => seatAfter(state, actor);
  const captain = () => requireThat(state.commanderId === actor, "지휘관만 결정할 수 있습니다.");
  const prep = (...stages: NonNullable<Snapshot["preparation"]>["stage"][]) => {
    phase("preparation");
    requireThat(state.preparation && stages.includes(state.preparation.stage), "현재 준비 단계에서 할 수 없는 행동입니다.");
    return state.preparation!;
  };
  const answered = () => {
    const required = state.players.filter(p => ["captain_decision", "captain_distribution"].includes(state.preparation!.stage) || roleIncludesCommander(state.missionId!, state.rulesetVersion) || p.id !== state.commanderId);
    requireThat(required.every(p => state.preparation!.responses[p.id] !== undefined), "대원들의 응답을 기다려 주세요.");
  };
  requireThat(!state.restartVote || command.type === "vote_restart", "재시작 동의가 진행 중입니다.");
  switch (command.type) {
    case "request_restart":
      phase("briefing", "preparation", "task_selection", "playing", "trick_result");
      state.restartVote = { requestedBy: actor, approvals: [actor] };
      break;
    case "vote_restart":
      requireThat(state.restartVote, "진행 중인 재시작 요청이 없습니다.");
      if (!command.agree) state.restartVote = null;
      else {
        if (!state.restartVote!.approvals.includes(actor)) state.restartVote!.approvals.push(actor);
        if (state.players.every(p => state.restartVote!.approvals.includes(p.id))) begin(state, state.missionId!, random);
      }
      break;
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
    case "set_character":
      phase("lobby");
      me.characterId = command.characterId;
      me.ready = false;
      break;
    case "set_ready":
      phase("lobby");
      me.ready = command.ready;
      break;
    case "start_mission": {
      host();
      phase("lobby");
      requireThat(
        state.players.length >= 3 && state.players.length <= state.settings.capacity &&
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
      if (state.players.every((p) => p.briefingReady)) advanceSetup(state);
      break;
    case "request_distress": {
      host(); phase("briefing", "playing");
      requireThat(state.trickNumber === 1 && state.trick.length === 0 && state.players.every(p => !p.communication), "구조 신호는 첫 카드와 교신 전에 사용해야 합니다.");
      requireThat(!state.setup!.distressResolved && !state.setup!.distressDirection, "이번 시도의 구조 신호는 이미 결정했습니다.");
      state.setup!.distressDirection = command.direction;
      state.missionProgress!.distressDirection = command.direction;
      if (state.phase === "playing") prepare(state, "distress_vote");
      break;
    }
    case "preparation_response": {
      const current = prep("role", "captain_decision", "captain_distribution", "distress_vote");
      requireThat(current.responses[actor] === undefined, "이미 응답했습니다.");
      requireThat(["distress_vote", "captain_decision", "captain_distribution"].includes(current.stage) || (current.stage === "role" && roleIncludesCommander(state.missionId!, state.rulesetVersion)) || actor !== state.commanderId, "지휘관은 대원들의 응답 후 결정합니다.");
      requireThat(current.stage !== "role" || state.missionId !== 11, "이번 준비는 응답 없이 지명합니다.");
      const allowed = current.stage === "distress_vote" ? ["yes", "no"] : state.missionId === 50 ? ["first", "middle", "last"] : ["yes", "no"];
      requireThat(allowed.includes(command.answer), "해당 질문에 맞는 응답을 선택해 주세요.");
      current.responses[actor] = command.answer;
      current.answeredPlayerIds = Object.keys(current.responses);
      if (current.stage === "distress_vote" && state.players.every(p => current.responses[p.id])) {
        if (Object.values(current.responses).every(answer => answer === "yes")) prepare(state, "distress_cards");
        else { state.setup!.distressResolved = true; advanceSetup(state); }
      }
      break;
    }
    case "select_distress_card": {
      const current = prep("distress_cards");
      requireThat(!state.setup!.distressCards[actor], "이미 교환할 카드를 선택했습니다.");
      requireThat(state.hands[actor].includes(command.cardId) && suitOf(command.cardId) !== "rocket", "손패의 일반 카드 한 장을 선택해 주세요.");
      state.setup!.distressCards[actor] = command.cardId;
      current.answeredPlayerIds = Object.keys(state.setup!.distressCards);
      if (state.players.every(p => state.setup!.distressCards[p.id])) {
        const picks = state.setup!.distressCards;
        state.players.forEach(p => { state.hands[p.id] = state.hands[p.id].filter(c => c !== picks[p.id]); });
        state.players.forEach(p => { state.hands[seatAfter(state, p.id, state.setup!.distressDirection === "left" ? 1 : -1)].push(picks[p.id]); });
        state.setup!.distressCards = {};
        state.setup!.distressResolved = true;
        state.missionProgress!.distressUsed = true;
        state.missionProgress!.distressActive = true;
        if (!state.setup!.distressEverUsed) { state.setup!.distressEverUsed = true; state.attemptNumber++; }
        advanceSetup(state);
      }
      break;
    }
    case "select_crew": {
      const current = prep("role", "captain_decision"); captain();
      if (state.missionId !== 11) answered();
      requireThat(current.eligiblePlayerIds.includes(command.playerId), "지정할 수 없는 대원입니다.");
      if (state.missionId === 50) {
        requireThat(command.secondaryPlayerId && command.secondaryPlayerId !== command.playerId && current.eligiblePlayerIds.includes(command.secondaryPlayerId), "첫 4트릭과 마지막 트릭을 서로 다른 대원에게 맡겨 주세요.");
        state.missionProgress!.secondaryPlayerId = command.secondaryPlayerId!;
      } else requireThat(command.secondaryPlayerId === undefined, "두 번째 담당자가 없는 미션입니다.");
      if (current.stage === "captain_decision") {
        state.tasks.forEach(t => { t.ownerId = command.playerId; });
        state.setup!.assignmentDone = true;
      } else {
        if (state.missionId === 11) state.missionProgress!.silentPlayerId = command.playerId;
        else state.missionProgress!.selectedPlayerId = command.playerId;
        state.setup!.roleDone = true;
      }
      advanceSetup(state);
      break;
    }
    case "assign_task": {
      const current = prep("captain_distribution"); captain(); answered();
      requireThat(current.eligiblePlayerIds.includes(command.playerId), "모든 목표를 나눈 뒤 목표 수 차이가 1 이하가 되도록 배분해 주세요.");
      state.tasks.find(t => t.id === current.activeTaskId)!.ownerId = command.playerId;
      advanceSetup(state);
      break;
    }
    case "edit_task_tokens": {
      prep("token_edit"); captain();
      editTaskTokens(state, command.firstTaskId, command.secondTaskId);
      break;
    }
    case "reset_tokens":
      prep("token_edit"); captain();
      state.tasks.forEach((task, i) => { task.token = state.setup!.originalTokens[i]; task.order = task.token?.kind === "absolute" ? task.token.value! : null; });
      break;
    case "confirm_tokens":
      prep("token_edit"); captain();
      if (command.firstTaskId || command.secondTaskId) {
        requireThat(command.firstTaskId && command.secondTaskId, "서로 다른 목표 두 장을 선택해 주세요.");
        editTaskTokens(state, command.firstTaskId!, command.secondTaskId!);
      }
      state.setup!.tokensDone = true; advanceSetup(state); break;
    case "transfer_task": {
      prep("task_transfer");
      const task = state.tasks.find(t => t.id === command.taskId);
      requireThat(task?.ownerId === actor && command.playerId !== actor && state.players.some(p => p.id === command.playerId), "자신의 목표 한 장을 다른 대원에게 양도할 수 있습니다.");
      task!.ownerId = command.playerId; state.setup!.transferDone = true; advanceSetup(state); break;
    }
    case "skip_transfer":
      prep("task_transfer"); captain(); state.setup!.transferDone = true; advanceSetup(state); break;
    case "choose_task": {
      phase("task_selection");
      requireThat(
        state.turnPlayerId === actor,
        "목표를 선택할 차례가 아닙니다.",
      );
      const task = state.tasks.find((t) => t.id === command.taskId);
      requireThat(task && !task.ownerId, "선택할 수 없는 목표입니다.");
      task!.ownerId = actor;
      const remaining = state.tasks.filter(t => !t.ownerId);
      // The last draft card has no choice left: preserve the next seat's turn.
      if (remaining.length === 1) remaining[0].ownerId = nextSeat();
      if (state.tasks.every((t) => t.ownerId)) {
        state.setup!.assignmentDone = true;
        advanceSetup(state);
      } else state.turnPlayerId = nextSeat();
      break;
    }
    case "communicate":
      phase("playing");
      requireThat(
        mayCommunicate(state, actor),
        "지금은 교신할 수 없습니다. 미션의 교신 제한과 사용 여부를 확인해 주세요.",
      );
      requireThat(
        command.marker === "hidden"
          ? missionRules(state.missionId!).communication.hidden && communicationMarkers(state.hands[actor], command.cardId).length > 0
          : communicationMarkers(state.hands[actor], command.cardId).includes(command.marker),
        "현재 손패와 일치하는 교신 표시를 선택해 주세요.",
      );
      me.communication = {
        cardId: command.cardId,
        marker: missionRules(state.missionId!).communication.hidden ? "hidden" : command.marker,
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
      if (state.trick.length === state.players.length) resolve(state, random);
      break;
    case "advance_trick":
      phase("trick_result");
      state.trick = [];
      state.trickNumber += 1;
      state.phase = "playing";
      break;
    case "resolve_waiting":
      host();
      requireThat((state.waitingPlayers ?? []).length > 0, "대기 중인 새 대원이 없습니다.");
      if (command.mode === "after_mission") {
        if (["success", "failure"].includes(state.phase)) promoteWaiting(state);
        else {
          requireThat(["briefing", "task_selection", "preparation", "playing", "trick_result"].includes(state.phase), "현재 임무가 진행 중이 아닙니다.");
          state.waitingPolicy = "after_mission";
        }
      } else {
        promoteWaiting(state);
        if (state.missionId !== null && state.phase !== "lobby" && state.phase !== "campaign_complete") begin(state, state.missionId, random);
        else if (state.phase === "campaign_complete") resetToLobby(state);
      }
      break;
    case "retry_mission":
      host();
      phase("failure");
      promoteWaiting(state);
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
      } else { promoteWaiting(state); begin(state, id, random); }
      break;
    }
  }
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  return state;
}
