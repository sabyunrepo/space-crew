import { describe, expect, it } from "vitest";
import { applyCommand, createState, legalCards, newPlayer, project, type State } from "../src/game/engine.ts";
import { SnapshotSchema, type CardId, type Command } from "../shared/contracts.ts";
import { missionRules, roleIncludesCommander } from "../shared/missionRules.ts";
import missions from "../shared/missions.json";

const ids = Array.from({ length: 5 }, (_, i) => `10000000-0000-4000-8000-00000000000${i + 1}`);
function seeded(seed = 903) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function start(id: number, count: 3 | 4 | 5 = 3, random = seeded()): State {
  const state = createState(ids[0], "대원0", { name: "전수 검증", capacity: count, startMission: id, missionMode: "sequential" });
  for (let i = 1; i < count; i++) state.players.push(newPlayer(ids[i], `대원${i}`, i));
  state.players.forEach(p => { p.ready = true; });
  return applyCommand(state, ids[0], { type: "start_mission" }, random);
}
function ready(input: State): State {
  let state = input;
  for (const player of state.players) state = applyCommand(state, player.id, { type: "briefing_ready" });
  return state;
}
function setupStep(state: State): State {
  if (state.phase === "task_selection") return applyCommand(state, state.turnPlayerId!, { type: "choose_task", taskId: state.tasks.find(t => !t.ownerId)!.id });
  const prep = state.preparation!;
  const captain = state.commanderId!;
  if (prep.stage === "token_edit") return applyCommand(state, captain, { type: "confirm_tokens" });
  if (prep.stage === "task_transfer") return applyCommand(state, captain, { type: "skip_transfer" });
  if (prep.stage === "distress_cards") {
    const player = state.players.find(p => !prep.answeredPlayerIds.includes(p.id))!;
    return applyCommand(state, player.id, { type: "select_distress_card", cardId: state.hands[player.id].find(c => !c.startsWith("rocket"))! });
  }
  const respondents = state.players.filter(p => ["distress_vote", "captain_decision", "captain_distribution"].includes(prep.stage) || roleIncludesCommander(state.missionId!, state.rulesetVersion) || p.id !== captain);
  const pending = respondents.find(p => prep.responses[p.id] === undefined);
  if (pending && !(prep.stage === "role" && state.missionId === 11)) return applyCommand(state, pending.id, { type: "preparation_response", answer: prep.stage === "distress_vote" ? "no" : state.missionId === 50 ? "middle" : "yes" });
  return applyCommand(state, captain, prep.stage === "captain_distribution" ? { type: "assign_task", playerId: prep.eligiblePlayerIds[0] } : { type: "select_crew", playerId: prep.eligiblePlayerIds[0], ...(state.missionId === 50 ? { secondaryPlayerId: prep.eligiblePlayerIds[1] } : {}) });
}
function playing(id: number, count: 3 | 4 | 5 = 3): State {
  let state = ready(start(id, count)); let guard = 0;
  while (state.phase !== "playing" && guard++ < 100) state = setupStep(state);
  expect(state.phase).toBe("playing"); return state;
}
/** A complete, legal last trick fixture after the mission-specific earlier obligations were met. */
function terminalFixture(id: number, count: 3 | 4 | 5, succeed: boolean): State {
  const state = playing(id, count);
  const progress = state.missionProgress!;
  const targetWinner = id === 34 ? state.commanderId! : id === 50 ? progress.secondaryPlayerId! : [5,33,41,46].includes(id) ? progress.selectedPlayerId! : ids[0];
  let winId = targetWinner;
  if (!succeed && [34,41,46,50].includes(id)) winId = state.players.find(p => p.id !== targetWinner)!.id;
  if (succeed && id === 5) winId = state.players.find(p => p.id !== targetWinner)!.id;
  let winCard: CardId = "blue-8";
  if (succeed && [9,26].includes(id)) winCard = "blue-1";
  if (succeed && [13,44].includes(id)) { winCard = "rocket-4"; progress.rocketsWon = [1,2,3]; }
  if (succeed && id === 26) progress.oneWins = 1;
  if (!succeed && [16,17].includes(id)) winCard = "blue-9";
  if (!succeed && [13,33,44].includes(id)) winCard = "rocket-4";
  state.players.forEach(p => { p.tricksWon = id === 33 ? 0 : 2; state.hands[p.id] = []; p.communication = null; });
  if (!succeed && id === 29) state.players.find(p => p.id === winId)!.tricksWon = 5;
  if (id === 46) progress.blackCardsWon = 8;
  if (id === 17 && succeed) progress.ninesPlayed = 4;
  const actors = state.players.filter(p => p.id !== winId).map(p => p.id);
  const plays = [{ playerId: winId, cardId: winCard }, ...actors.map((playerId, i) => ({ playerId, cardId: (i === 0 && id === 46 ? "black-1" : `green-${i + 2}`) as CardId }))];
  if (state.tasks.length) {
    let last = state.tasks.find(t => t.token?.kind === "omega");
    last ??= [...state.tasks].reverse().find(t => t.token?.kind === "absolute");
    // A partial absolute sequence ends earlier than the final task; choose a tokenless task then.
    if (last?.token?.kind === "absolute" && last.token.value !== state.tasks.length) last = undefined;
    last ??= [...state.tasks].reverse().find(t => !t.token || t.token.kind === "relative");
    last ??= state.tasks.at(-1)!;
    state.tasks.forEach(t => { t.status = t === last ? "pending" : "success"; });
    last.cardId = "green-2";
    plays[1].cardId = "green-2";
    last.ownerId = succeed ? winId : actors[0];
  }
  state.trickNumber = Math.floor(40 / count);
  state.trick = plays.slice(0, -1);
  state.turnPlayerId = plays.at(-1)!.playerId;
  state.hands[state.turnPlayerId] = [plays.at(-1)!.cardId];
  // Three-player base game has one unused extra card, never another trick.
  if (count === 3) state.hands[winId] = ["yellow-8"];
  return state;
}
function finish(state: State) { return applyCommand(state, state.turnPlayerId!, { type: "play_card", cardId: state.hands[state.turnPlayerId!][0] }); }

describe.each([3,4,5] as const)("all 50 missions with %i players", count => {
  it.each(missions)("mission $id reaches its successful terminal condition", mission => {
    expect(mission.playable).toBe(true);
    const next = finish(terminalFixture(mission.id, count, true));
    expect(next.phase, `mission ${mission.id}: ${next.resultReason}`).toBe("success");
    expect(next.trickNumber).toBe(Math.floor(40 / count));
  });
  it.each(missions)("mission $id rejects a violated goal or special condition", mission => {
    const next = finish(terminalFixture(mission.id, count, false));
    expect(next.phase, `mission ${mission.id}: ${next.resultReason}`).toBe("failure");
  });
  it.each(missions)("mission $id restores every setup step and finishes a legal attempt", mission => {
    let state = ready(start(mission.id, count)); let guard = 0;
    while (["preparation", "task_selection"].includes(state.phase) && guard++ < 100) {
      state = JSON.parse(JSON.stringify(state)) as State;
      state.players.forEach(p => {
        const view = project(state, p.id);
        expect(SnapshotSchema.safeParse(view).success).toBe(true);
        expect(view).not.toHaveProperty("setup"); expect(view).not.toHaveProperty("hands");
      });
      state = setupStep(state);
    }
    while (["playing", "trick_result"].includes(state.phase) && guard++ < 200) {
      state = state.phase === "trick_result" ? applyCommand(state, ids[0], { type: "advance_trick" })
        : applyCommand(state, state.turnPlayerId!, { type: "play_card", cardId: legalCards(state, state.turnPlayerId!)[0] }, seeded());
    }
    expect(["success", "failure"]).toContain(state.phase);
    expect(state.trickNumber).toBeLessThanOrEqual(Math.floor(40 / count));
  });
});

describe("mission-specific boundaries and saved preparation", () => {
  it("matches every published token array, communication rule and assignment family", () => {
    const expected = ["","","a1 a2","","","r1 r2","w","a1 a2 a3","","","a1","w","","r1 r2 r3","a1 a2 a3 a4","","","","a1","","a1 a2","r1 r2 r3 r4","a1 a2 a3 a4 a5","","r1 r2","","","a1 w","","r1 r2 r3","a1 a2 a3","","","","r1 r2 r3","a1 a2","","","r1 r2 r3","a1 a2 a3","","","","","r1 r2 r3","","","w","r1 r2 r3",""];
    missions.forEach((mission, i) => {
      const rules = missionRules(mission.id);
      expect(rules.tokens.map(t => t.kind === "omega" ? "w" : `${t.kind[0]}${t.value}`).join(" ")).toBe(expected[i]);
      expect(rules.communication.hidden).toBe([6,14,21,25,29,39].includes(mission.id));
    });
  });
  it.each([6,14,21,25,29,39])("mission %i stores reduced communication as hidden, not only", id => {
    const state = playing(id);
    state.hands[ids[0]] = ["blue-1", "blue-9", "blue-5"];
    expect(() => applyCommand(state, ids[0], { type: "communicate", cardId: "blue-5", marker: "hidden" })).toThrow();
    const communicated = applyCommand(state, ids[0], { type: "communicate", cardId: "blue-9", marker: "highest" });
    for (const p of state.players) expect(project(communicated, p.id).players[0].communication?.marker).toBe("hidden");
  });
  it.each([[18,2],[30,2],[19,3],[28,3],[38,3]])("mission %i enforces first communication trick %i", (id, from) => {
    let state = playing(id); state.hands[ids[0]] = ["blue-1"];
    for (let trick = 1; trick < from; trick++) {
      state.trickNumber = trick;
      expect(project(state, ids[0]).me.canCommunicate).toBe(false);
      expect(() => applyCommand(state, ids[0], { type: "communicate", cardId: "blue-1", marker: "only" })).toThrow();
    }
    state.trickNumber = from;
    state = applyCommand(state, ids[0], { type: "communicate", cardId: "blue-1", marker: "only" });
    expect(state.players[0].communication?.cardId).toBe("blue-1");
  });
  it("mission 11 silences only its selected noncommander", () => {
    const state = playing(11); const silent = state.missionProgress!.silentPlayerId!;
    expect(silent).not.toBe(state.commanderId);
    state.players.forEach(p => { state.hands[p.id] = ["blue-1"]; });
    for (const p of state.players) {
      expect(project(state, p.id).me.canCommunicate).toBe(p.id !== silent);
      if (p.id === silent) expect(() => applyCommand(state, p.id, { type: "communicate", cardId: "blue-1", marker: "only" })).toThrow();
    }
  });
  it.each([20,27,37])("mission %i hides all targets through captain decision and forbids selfselection", id => {
    let state = start(id, 5);
    state.players.forEach(p => expect(project(state, p.id).tasks).toHaveLength(0));
    state = ready(state);
    expect(state.preparation?.stage).toBe("captain_decision");
    expect(state.preparation!.eligiblePlayerIds).not.toContain(state.commanderId);
    expect(() => applyCommand(state, state.commanderId!, { type: "select_crew", playerId: ids.find(x => x !== state.commanderId)! })).toThrow("응답");
    while (state.preparation?.stage === "captain_decision") state = setupStep(state);
    expect(new Set(state.tasks.map(t => t.ownerId)).size).toBe(1);
    state.players.forEach(p => expect(project(state, p.id).tasks).toHaveLength(state.tasks.length));
  });
  it.each([24,32,36,43])("mission %i reveals one assignment at a time, preserves responses and balances final task counts", id => {
    let state = ready(start(id, 5));
    expect(project(state, ids[0]).tasks).toHaveLength(1);
    while (state.preparation?.stage === "captain_distribution") {
      const assigned = state.tasks.filter(t => t.ownerId).length;
      const view = project(state, ids[0]);
      expect(view.tasks).toHaveLength(assigned + 1);
      expect(view.hiddenTaskCount).toBe(state.tasks.length - assigned - 1);
      const oldResponses = JSON.stringify(state.preparation.responses);
      state = JSON.parse(JSON.stringify(state)) as State;
      expect(JSON.stringify(project(state, ids[0]).preparation!.responses)).toBe(oldResponses);
      state = setupStep(state);
    }
    const counts = state.players.map(p => state.tasks.filter(t => t.ownerId === p.id).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
  it.each([23,40])("mission %i token edits reset to originals, validate targets and confirm exactly once", id => {
    let state = ready(start(id));
    const original = state.tasks.map(t => t.token);
    const first = state.tasks[0].id, second = state.tasks[id === 23 ? 1 : 3].id;
    expect(() => applyCommand(state, state.commanderId!, { type: "edit_task_tokens", firstTaskId: first, secondTaskId: first })).toThrow();
    state = applyCommand(state, state.commanderId!, { type: "edit_task_tokens", firstTaskId: first, secondTaskId: second });
    expect(state.tasks[id === 23 ? 1 : 3].token).toEqual(original[0]);
    state = applyCommand(state, state.commanderId!, { type: "reset_tokens" });
    expect(state.tasks.map(t => t.token)).toEqual(original);
    state = applyCommand(state, state.commanderId!, { type: "confirm_tokens" });
    expect(state.phase).toBe("task_selection");
    expect(() => applyCommand(state, state.commanderId!, { type: "confirm_tokens" })).toThrow();
  });
  it("mission 40 rejects swapping two occupied token positions", () => {
    const state = ready(start(40));
    expect(() => applyCommand(state, state.commanderId!, { type: "edit_task_tokens", firstTaskId: state.tasks[0].id, secondTaskId: state.tasks[1].id })).toThrow();
  });
  it.each(missions.filter(m => m.fivePlayerTransfer))("mission $id five-player one-task transfer keeps token, forbids another donor and repeated action", mission => {
    let state = ready(start(mission.id, 5));
    while (state.preparation?.stage !== "task_transfer") state = setupStep(state);
    const task = state.tasks[0]; const receiver = state.players.find(p => p.id !== task.ownerId)!.id;
    expect(() => applyCommand(state, receiver, { type: "transfer_task", taskId: task.id, playerId: task.ownerId! })).toThrow();
    const token = task.token;
    state = applyCommand(state, task.ownerId!, { type: "transfer_task", taskId: task.id, playerId: receiver });
    expect(state.tasks[0].ownerId).toBe(receiver); expect(state.tasks[0].token).toEqual(token);
    expect(() => applyCommand(state, receiver, { type: "transfer_task", taskId: task.id, playerId: task.ownerId! })).toThrow();
  });
  it("mission 46 reveals the black-9 holder only after distress and uses logical left seat", () => {
    let state = ready(start(46));
    expect(state.preparation?.stage).toBe("distress_vote");
    expect(project(state, ids[0]).missionProgress!.blackNineHolderId).toBeNull();
    for (const p of state.players) state = applyCommand(state, p.id, { type: "preparation_response", answer: "yes" });
    const oldHolder = state.players.find(p => state.hands[p.id].includes("black-9"))!.id;
    for (const p of state.players) state = applyCommand(state, p.id, { type: "select_distress_card", cardId: p.id === oldHolder ? "black-9" : state.hands[p.id].find(c => !c.startsWith("rocket"))! });
    const holder = state.players.find(p => state.hands[p.id].includes("black-9"))!.id;
    expect(holder).not.toBe(oldHolder);
    expect(state.missionProgress!.blackNineHolderId).toBe(holder);
    expect(state.missionProgress!.selectedPlayerId).toBe(state.players[(state.players.findIndex(p => p.id === holder) + 1) % 3].id);
  });
  it("distress exchanges simultaneously, hides picks, rejects rockets/repeats and penalizes once across retry", () => {
    let state = playing(10, 4);
    state = applyCommand(state, state.hostId, { type: "request_distress", direction: "right" });
    for (const p of state.players) state = applyCommand(state, p.id, { type: "preparation_response", answer: "yes" });
    const captain = state.commanderId!;
    expect(() => applyCommand(state, captain, { type: "select_distress_card", cardId: "rocket-4" })).toThrow();
    const picked = state.hands[ids[0]].find(c => !c.startsWith("rocket"))!;
    state = applyCommand(state, ids[0], { type: "select_distress_card", cardId: picked });
    expect(JSON.stringify(project(state, ids[1]))).not.toContain('distressCards');
    expect(() => applyCommand(state, ids[0], { type: "select_distress_card", cardId: picked })).toThrow();
    for (const p of state.players.slice(1)) state = applyCommand(state, p.id, { type: "select_distress_card", cardId: state.hands[p.id].find(c => !c.startsWith("rocket"))! });
    expect(state.hands[ids[3]]).toContain(picked);
    expect(new Set(Object.values(state.hands).flat()).size).toBe(40);
    expect(state.attemptNumber).toBe(2);
    state.phase = "failure";
    state = applyCommand(state, ids[0], { type: "retry_mission" });
    expect(state.attemptNumber).toBe(3);
    state = applyCommand(state, ids[0], { type: "request_distress", direction: "left" });
    state = ready(state);
    while (state.preparation?.stage !== "distress_vote") state = setupStep(state);
    for (const p of state.players) state = applyCommand(state, p.id, { type: "preparation_response", answer: "yes" });
    while (state.preparation?.stage === "distress_cards") state = setupStep(state);
    expect(state.attemptNumber).toBe(3);
  });
  it("a rejected distress vote resumes setup, and communication locks later distress", () => {
    let state = playing(10);
    state.hands[ids[0]] = ["blue-1"];
    const communicated = applyCommand(state, ids[0], { type: "communicate", cardId: "blue-1", marker: "only" });
    expect(() => applyCommand(communicated, ids[0], { type: "request_distress", direction: "left" })).toThrow();
    state = applyCommand(state, ids[0], { type: "request_distress", direction: "left" });
    for (const p of state.players) state = applyCommand(state, p.id, { type: "preparation_response", answer: p.id === ids[0] ? "no" : "yes" });
    expect(state.phase).toBe("playing"); expect(state.missionProgress!.distressUsed).toBe(false);
  });
});

describe("simultaneous goals and special trick edge cases", () => {
  function trickFixture(id: number, cards: CardId[], winnerId = ids[0]) {
    const state = playing(id);
    state.players.forEach(p => { state.hands[p.id] = ["yellow-7", "yellow-8"]; p.communication = null; });
    state.trick = cards.slice(0, -1).map((cardId, i) => ({ playerId: ids[i], cardId }));
    state.turnPlayerId = ids[cards.length - 1];
    state.hands[state.turnPlayerId] = [cards.at(-1)!, "green-8"];
    state.tasks.forEach(t => { t.ownerId = winnerId; });
    return state;
  }
  it("an unnumbered target before absolute 1 fails, but one simultaneous set can contain consecutive numbers", () => {
    let state = trickFixture(11, ["blue-9", "blue-1", "blue-2"]);
    state.tasks[0].cardId = "green-1";
    state.tasks[1].cardId = "blue-1";
    state.tasks[2].cardId = "yellow-1"; state.tasks[3].cardId = "black-1";
    expect(finish(state).phase).toBe("failure");
    state = trickFixture(3, ["blue-9", "blue-2", "blue-1"]);
    state.tasks[0].cardId = "blue-1"; state.tasks[1].cardId = "blue-2";
    expect(finish(state).phase).toBe("success");
    state.trick = [...state.trick].reverse();
    expect(finish(state).phase).toBe("success");
  });
  it("relative targets allow intervening unnumbered goals but reject skipping a preceding arrow", () => {
    let state = trickFixture(6, ["blue-9", "blue-1", "blue-2"]);
    state.tasks[0].cardId = "green-1"; state.tasks[1].cardId = "blue-1"; state.tasks[2].cardId = "black-1";
    expect(finish(state).phase).toBe("failure");
    state.tasks[0].status = "success"; state.tasks[2].status = "success";
    expect(finish(state).phase).toBe("success");
    state = trickFixture(6, ["blue-9", "blue-1", "blue-2"]);
    state.tasks[0].cardId = "blue-1"; state.tasks[1].cardId = "blue-2"; state.tasks[2].status = "success";
    expect(finish(state).phase).toBe("success");
  });
  it("omega may share the last target trick, but mission48 additionally requires the real last trick", () => {
    const state = trickFixture(7, ["blue-9", "blue-1", "blue-2"]);
    state.tasks[0].cardId = "blue-1"; state.tasks[1].cardId = "blue-2"; state.tasks[2].cardId = "green-1";
    expect(finish(state).phase).toBe("failure");
    state.tasks[2].status = "success";
    expect(finish(state).phase).toBe("success");
    const last = trickFixture(48, ["blue-9", "blue-1", "blue-2"]);
    last.tasks[0].cardId = "blue-1"; last.tasks[1].status = "success"; last.tasks[2].status = "success";
    expect(finish(last).resultReason).toContain("마지막 트릭");
  });
  it.each([9,26])("mission%i requires a regular1 WINNING card; merely catching it does not count", id => {
    const state = trickFixture(id, ["blue-9", "blue-1", "blue-2"]);
    state.hands[ids[0]].push("black-1", "yellow-1", "green-1");
    const next = finish(state);
    expect(next.missionProgress!.oneWins).toBe(0); expect(next.phase).toBe("trick_result");
    const rocket = trickFixture(id, ["rocket-1", "blue-1", "blue-2"]);
    rocket.hands[ids[0]].push("black-1", "yellow-1", "green-1");
    expect(finish(rocket).missionProgress!.oneWins).toBe(0);
  });
  it.each([13,44])("mission%i fails immediately when a lower rocket loses in a multi-rocket trick", id => {
    const state = trickFixture(id, ["rocket-4", "rocket-1", "blue-2"]);
    expect(finish(state).phase).toBe("failure");
  });
  it("mission44 rejects out-of-order separate rocket victory", () => {
    const state = trickFixture(44, ["rocket-2", "blue-1", "blue-2"]);
    expect(finish(state).resultReason).toContain("1 → 2");
  });
  it("mission17 ends after both tasks; only an already-running v2 attempt preserves its old nine gate", () => {
    const state = trickFixture(17, ["blue-8", "blue-1", "blue-2"]);
    state.tasks[0].cardId = "blue-1"; state.tasks[1].cardId = "blue-2";
    expect(finish(state).phase).toBe("success");
    state.rulesetVersion = "crew-p9-50-2";
    expect(finish(state).phase).toBe("trick_result");
    state.missionProgress!.ninesPlayed = 4;
    expect(finish(state).phase).toBe("success");
    const last = terminalFixture(17, 3, true);
    last.missionProgress!.ninesPlayed = 3; last.hands[ids[0]] = ["yellow-9"];
    expect(finish(last).phase).toBe("success");
  });
  it("mission17 fails for a winning9 even if its final goals are captured in that trick", () => {
    const state = trickFixture(17, ["blue-9", "blue-1", "blue-2"]);
    state.tasks[0].cardId = "blue-1"; state.tasks[1].cardId = "blue-2";
    expect(finish(state).phase).toBe("failure");
  });
  it("mission12 excludes active communicated cards from simultaneous right-neighbor draw, retains marker, and never moves twice", () => {
    const state = trickFixture(12, ["blue-9", "blue-1", "blue-2"]);
    state.tasks.forEach((t, i) => { t.cardId = `black-${i + 1}`; });
    state.hands[ids[0]] = ["green-9", "green-1"];
    state.players[0].communication = { cardId: "green-9", marker: "highest", played: false };
    state.hands[ids[1]] = ["yellow-1", "yellow-9"];
    state.hands[ids[2]] = ["blue-2", "black-9", "green-2"];
    const next = applyCommand(state, ids[2], { type: "play_card", cardId: "blue-2" }, () => 0);
    expect(next.hands[ids[0]]).toEqual(["green-9", "black-9"]);
    expect(next.hands[ids[1]]).toEqual(["yellow-9", "green-1"]);
    expect(next.hands[ids[2]]).toEqual(["green-2", "yellow-1"]);
    expect(next.players[0].communication).toEqual(state.players[0].communication);
    expect(next.missionProgress!.transferApplied).toBe(true);
    const restored = JSON.parse(JSON.stringify(next)) as State;
    const advanced = applyCommand(restored, ids[0], { type: "advance_trick" });
    expect(advanced.hands).toEqual(next.hands);
  });
  it("mission12 received card does not change an only marker that is now historical", () => {
    const state = trickFixture(12, ["blue-9", "blue-1", "blue-2"]);
    state.tasks.forEach((t, i) => { t.cardId = `black-${i + 1}`; });
    state.players[0].communication = { cardId: "green-9", marker: "only", played: false };
    state.hands[ids[0]] = ["green-9", "yellow-3"];
    state.hands[ids[1]] = ["yellow-1", "yellow-9"];
    state.hands[ids[2]] = ["blue-2", "green-2", "black-9"];
    const next = applyCommand(state, ids[2], { type: "play_card", cardId: "blue-2" }, () => 0);
    expect(next.hands[ids[0]]).toEqual(["green-9", "green-2"]);
    expect(project(next, ids[1]).players[0].communication!.marker).toBe("only");
  });
  it.each([5,33,41])("mission%i includes the commander in responses and self-selection", id => {
    let state = ready(start(id));
    expect(state.preparation!.eligiblePlayerIds).toContain(state.commanderId);
    expect(() => applyCommand(state, state.commanderId!, { type: "select_crew", playerId: state.commanderId! })).toThrow();
    for (const player of state.players) state = applyCommand(state, player.id, { type: "preparation_response", answer: "yes" });
    state = applyCommand(state, state.commanderId!, { type: "select_crew", playerId: state.commanderId! });
    expect(state.missionProgress!.selectedPlayerId).toBe(state.commanderId);
    expect(state.phase).toBe("playing");
  });
  it.each([5,33])("mission%i preserves v2 role restrictions until retry", id => {
    let state = start(id); state.rulesetVersion = "crew-p9-50-2";
    state = ready(state);
    expect(state.preparation!.eligiblePlayerIds).not.toContain(state.commanderId);
    expect(() => applyCommand(state, state.commanderId!, { type: "preparation_response", answer: "yes" })).toThrow();
    state.phase = "failure";
    state = ready(applyCommand(state, state.hostId, { type: "retry_mission" }));
    expect(state.rulesetVersion).toBe("crew-p9-50-4");
    expect(state.preparation!.eligiblePlayerIds).toContain(state.commanderId);
  });
  it("new mission resets attempt counter and preserves drawn history", () => {
    let state = start(9); state.phase = "failure";
    state = applyCommand(state, ids[0], { type: "retry_mission" }); expect(state.attemptNumber).toBe(2);
    state.phase = "success";
    state = applyCommand(state, ids[0], { type: "next_mission" });
    expect(state.missionId).toBe(10); expect(state.attemptNumber).toBe(1); expect(state.drawnMissionIds).toEqual([9,10]);
  });
});

it("briefing distress reservation waits for captain distribution and five-player transfer", () => {
  let state = start(36, 5);
  const hands = structuredClone(state.hands);
  state = applyCommand(state, state.hostId, { type: "request_distress", direction: "right" });
  state = ready(state);
  expect(state.preparation?.stage).toBe("captain_distribution");
  let guard = 0;
  while (state.preparation?.stage !== "task_transfer" && guard++ < 100) state = setupStep(state);
  expect(state.preparation?.stage).toBe("task_transfer");
  expect(state.hands).toEqual(hands);
  expect(state.missionProgress?.distressUsed).toBe(false);
  state = setupStep(state);
  expect(state.preparation?.stage).toBe("distress_vote");
  for (const p of state.players) state = applyCommand(state, p.id, { type: "preparation_response", answer: "yes" });
  while (state.preparation?.stage === "distress_cards") state = setupStep(state);
  expect(state.phase).toBe("playing");
  expect(state.missionProgress?.distressActive).toBe(true);
  state.phase = "failure";
  state = ready(applyCommand(state, state.hostId, { type: "retry_mission" }));
  guard = 0;
  while (state.preparation?.stage !== "distress_vote" && guard++ < 100) state = setupStep(state);
  expect(state.missionProgress?.distressActive).toBe(true);
  for (const p of state.players) state = applyCommand(state, p.id, { type: "preparation_response", answer: "no" });
  expect(state.phase).toBe("playing");
  expect(state.missionProgress?.distressActive).toBe(true);
  expect(state.missionProgress?.distressUsed).toBe(false);
  expect(state.attemptNumber).toBe(3);
});


describe("draft last card and atomic token confirmation", () => {
  it.each([3,4,5] as const)("auto-assigns the last card to the next seat with %i players", count => {
    for (const mission of [2,4,18,25,47]) {
      let state = ready(start(mission, count));
      while (state.tasks.filter(t => !t.ownerId).length > 2) state = setupStep(state);
      const remaining = state.tasks.filter(t => !t.ownerId);
      const actor = state.turnPlayerId!;
      const next = state.players[(state.players.findIndex(p => p.id === actor) + 1) % count].id;
      const before = structuredClone(state);
      const done = applyCommand(state, actor, { type: "choose_task", taskId: remaining[0].id });
      expect(state).toEqual(before);
      expect(done.tasks.find(t => t.id === remaining[0].id)?.ownerId).toBe(actor);
      expect(done.tasks.find(t => t.id === remaining[1].id)?.ownerId).toBe(next);
      expect(done.tasks.every(t => t.ownerId)).toBe(true);
      expect(done.phase).toBe(count === 5 && missions.find(m => m.id === mission)!.fivePlayerTransfer ? "preparation" : "playing");
      if (done.phase === "preparation") expect(done.preparation?.stage).toBe("task_transfer");
    }
  });
  it.each([23,40])("confirms mission %i preview and token placement atomically", mission => {
    const state = ready(start(mission));
    const first = state.tasks[0], second = state.tasks[mission === 23 ? 1 : 3];
    const command = { type: "confirm_tokens" as const, firstTaskId: first.id, secondTaskId: second.id };
    const before = structuredClone(state);
    const done = applyCommand(state, state.commanderId!, command);
    expect(state).toEqual(before);
    expect(done.phase).toBe("task_selection");
    expect(done.tasks[0].token).toEqual(second.token);
    expect(done.tasks[mission === 23 ? 1 : 3].token).toEqual(first.token);
    expect(() => applyCommand(state, state.players.find(p => p.id !== state.commanderId)!.id, command)).toThrow();
    expect(() => applyCommand(state, state.commanderId!, { ...command, secondTaskId: first.id })).toThrow();
    expect(() => applyCommand(state, state.commanderId!, { type: "confirm_tokens", firstTaskId: first.id })).toThrow();
  });
});


describe("requested cooperative play options", () => {
  it("allows off-turn communication mid-trick in v4 while preserving legacy timing", () => {
    const state = playing(4);
    const actor = state.players.find(p => p.id !== state.turnPlayerId)!.id;
    state.trick = [{ playerId: state.turnPlayerId!, cardId: "blue-3" }];
    state.hands[actor] = ["green-2", "green-8"];
    expect(project(state, actor).me.canCommunicate).toBe(true);
    const done = applyCommand(state, actor, { type: "communicate", cardId: "green-8", marker: "highest" });
    expect(done.trick).toEqual(state.trick);
    expect(done.turnPlayerId).toBe(state.turnPlayerId);
    expect(done.hands).toEqual(state.hands);
    expect(() => applyCommand(done, actor, { type: "communicate", cardId: "green-2", marker: "lowest" })).toThrow();
    state.rulesetVersion = "crew-p9-50-3";
    expect(project(state, actor).me.canCommunicate).toBe(false);
  });
  it.each([3,4,5] as const)("requires every one of %i players to approve a restart", count => {
    const state = playing(22, count);
    let next = applyCommand(state, ids[1], { type: "request_restart" });
    expect(next.restartVote?.approvals).toEqual([ids[1]]);
    expect(() => applyCommand(next, next.turnPlayerId!, { type: "play_card", cardId: next.hands[next.turnPlayerId!][0] })).toThrow();
    expect(() => applyCommand(next, ids[0], { type: "request_restart" })).toThrow();
    const declined = applyCommand(next, ids[2], { type: "vote_restart", agree: false });
    expect(declined.restartVote).toBeNull();
    expect(declined.hands).toEqual(state.hands);
    expect(declined.attemptId).toBe(state.attemptId);
    for (const id of ids.slice(0,count).filter(id => id !== ids[1])) {
      expect(next.attemptId).toBe(state.attemptId);
      next = applyCommand(next, id, { type: "vote_restart", agree: true });
    }
    expect(next.restartVote).toBeNull();
    expect(next.phase).toBe("briefing");
    expect(next.missionId).toBe(22);
    expect(next.attemptNumber).toBe(state.attemptNumber + 1);
    expect(next.attemptId).not.toBe(state.attemptId);
    expect(next.players.map(p => [p.id,p.characterId])).toEqual(state.players.map(p => [p.id,p.characterId]));
    expect(state.restartVote).toBeNull();
  });
  it("limits suit concentration across all task counts without changing count or tokens", () => {
    const draws = new Set<string>();
    for (const mission of missions) for (let seed = 1; seed <= 12; seed++) {
      const state = start(mission.id, 3, seeded(seed));
      expect(state.tasks).toHaveLength(mission.taskCount);
      expect(new Set(state.tasks.map(t => t.cardId)).size).toBe(mission.taskCount);
      const counts = new Map<string,number>();
      state.tasks.forEach((t,i) => {
        const suit = t.cardId.split("-")[0];
        expect(suit).not.toBe("rocket"); counts.set(suit,(counts.get(suit) ?? 0)+1);
        expect(t.token).toEqual(missionRules(mission.id).tokens[i] ?? null);
      });
      expect(Math.max(0,...counts.values())).toBeLessThanOrEqual(Math.ceil(mission.taskCount / 4));
      if (mission.id === 22) draws.add(state.tasks.map(t => t.cardId).join(","));
    }
    expect(draws.size).toBeGreaterThan(10);
  });
});
