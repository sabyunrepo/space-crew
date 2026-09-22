import { describe, expect, it } from "vitest";
import {
  applyCommand,
  communicationMarkers,
  createState,
  legalCards,
  newPlayer,
  project,
  winner,
  type State,
} from "../src/game/engine.ts";
import { deck } from "../shared/cards.ts";
import { SnapshotSchema, type Command } from "../shared/contracts.ts";
const host = "10000000-0000-4000-8000-000000000001";
const second = "10000000-0000-4000-8000-000000000002";
const third = "10000000-0000-4000-8000-000000000003";
function room(): State {
  const state = createState(host, "별빛", {
    name: "테스트",
    capacity: 3,
    startMission: 1,
    missionMode: "sequential",
  });
  state.players.push(newPlayer(second, "루나", 1), newPlayer(third, "코멧", 2));
  state.players.forEach((p) => (p.ready = true));
  return state;
}
const start = (state = room()) =>
  applyCommand(state, host, { type: "start_mission" }, () => 0.43);
function playing(): State {
  let state = start();
  for (const p of state.players)
    state = applyCommand(state, p.id, { type: "briefing_ready" });
  while (state.phase === "task_selection")
    state = applyCommand(state, state.turnPlayerId!, {
      type: "choose_task",
      taskId: state.tasks.find((t) => !t.ownerId)!.id,
    });
  return state;
}
describe("authoritative demo rules", () => {
  it("deals all 40 cards once, chooses rocket-4 commander, and projects only the caller hand", () => {
    const state = start();
    const hands = Object.values(state.hands).flat();
    expect(hands).toHaveLength(40);
    expect(new Set(hands).size).toBe(40);
    expect(state.players.map((p) => p.cardCount)).toEqual([14, 13, 13]);
    expect(state.hands[state.commanderId!]).toContain("rocket-4");
    const view = project(state, host);
    expect(SnapshotSchema.safeParse(view).success).toBe(true);
    expect(view).not.toHaveProperty("hands");
    expect(view.me.hand).toHaveLength(14);
    expect(view.players[1]).not.toHaveProperty("hand");
    expect(() => project(state, crypto.randomUUID())).toThrow(
      "대원이 아닙니다",
    );
  });
  it("supports late missions and rejects unfinished preparation without mutating input", () => {
    const state = room();
    state.settings.startMission = 50;
    expect(start(state).missionId).toBe(50);
    expect(state.phase).toBe("lobby");
    state.settings.startMission = 1;
    state.players[1].ready = false;
    expect(() => start(state)).toThrow("준비");
  });
  it("keeps a player in the current mission but moves them to spectator at the next mission", () => {
    const state = createState(host, "별빛", { name: "관전", capacity: 4, startMission: 1, missionMode: "sequential" });
    const fourth = "10000000-0000-4000-8000-000000000004";
    state.players.push(newPlayer(second, "루나", 1), newPlayer(third, "코멧", 2), newPlayer(fourth, "노바", 3));
    state.phase = "playing";
    state.missionId = 1;
    state.attemptId = crypto.randomUUID();
    state.attemptNumber = 1;
    state.drawnMissionIds = [1];
    const marked = applyCommand(state, second, { type: "become_spectator" });
    expect(marked.players).toHaveLength(4);
    expect(marked.players.find((p) => p.id === second)?.spectateNextMission).toBe(true);
    marked.phase = "success";
    const next = applyCommand(marked, host, { type: "next_mission" });
    expect(next.missionId).toBe(2);
    expect(next.players.some((p) => p.id === second)).toBe(false);
    expect(next.spectators?.some((p) => p.id === second)).toBe(true);
    expect(next.players).toHaveLength(3);
  });
  it("follows the led suit, treats rockets as a suit, and rejects out-of-turn moves", () => {
    const state = playing();
    state.turnPlayerId = host;
    state.trick = [{ playerId: second, cardId: "blue-8" }];
    state.hands[host] = ["blue-1", "yellow-9", "rocket-4"];
    expect(legalCards(state, host)).toEqual(["blue-1"]);
    expect(() =>
      applyCommand(state, host, { type: "play_card", cardId: "rocket-4" }),
    ).toThrow();
    expect(() =>
      applyCommand(state, third, { type: "play_card", cardId: "blue-1" }),
    ).toThrow();
    state.trick[0].cardId = "rocket-1";
    expect(legalCards(state, host)).toEqual(["rocket-4"]);
    state.hands[host] = ["yellow-9"];
    expect(legalCards(state, host)).toEqual(["yellow-9"]);
    expect(
      winner([
        { playerId: host, cardId: "blue-9" },
        { playerId: second, cardId: "yellow-9" },
        { playerId: third, cardId: "rocket-1" },
      ]),
    ).toBe(third);
  });
  it("checks highest/lowest/only, blocks rockets and a second communication", () => {
    expect(
      communicationMarkers(
        ["blue-1", "blue-5", "blue-9", "green-2", "rocket-4"],
        "blue-5",
      ),
    ).toEqual([]);
    expect(communicationMarkers(["blue-1", "blue-9"], "blue-9")).toEqual([
      "highest",
    ]);
    expect(communicationMarkers(["green-2"], "green-2")).toEqual(["only"]);
    expect(communicationMarkers(["rocket-4"], "rocket-4")).toEqual([]);
    const state = playing();
    state.hands[host] = ["blue-1", "blue-9"];
    const next = applyCommand(state, host, {
      type: "communicate",
      cardId: "blue-9",
      marker: "highest",
    });
    expect(next.hands[host]).toEqual(state.hands[host]);
    expect(() =>
      applyCommand(next, host, {
        type: "communicate",
        cardId: "blue-1",
        marker: "lowest",
      }),
    ).toThrow();
  });
  it("fails a wrong recipient and succeeds with consecutive ordered goals in one trick", () => {
    let state = playing();
    state.turnPlayerId = third;
    state.trick = [
      { playerId: host, cardId: "blue-1" },
      { playerId: second, cardId: "blue-2" },
    ];
    state.hands[third] = ["blue-9", "green-1"];
    state.tasks = [
      {
        id: crypto.randomUUID(),
        cardId: "blue-1",
        ownerId: host,
        order: null,
        status: "pending",
      },
    ];
    expect(
      applyCommand(state, third, { type: "play_card", cardId: "blue-9" }).phase,
    ).toBe("failure");
    state.tasks = [1, 2].map((n) => ({
      id: crypto.randomUUID(),
      cardId: `blue-${n}`,
      ownerId: third,
      order: n,
      status: "pending",
    }));
    expect(
      applyCommand(state, third, { type: "play_card", cardId: "blue-9" }).phase,
    ).toBe("success");
    state.tasks[0].cardId = "green-3";
    expect(
      applyCommand(state, third, { type: "play_card", cardId: "blue-9" })
        .resultReason,
    ).toContain("순서");
  });
  it("preserves random mission on retry, selects unseen missions only after success", () => {
    const input = room();
    input.settings.missionMode = "random";
    let state = start(input);
    const first = state.missionId;
    const attempt = state.attemptId;
    state.phase = "failure";
    state = applyCommand(state, host, { type: "retry_mission" }, () => 0.99);
    expect(state.missionId).toBe(first);
    expect(state.attemptId).not.toBe(attempt);
    expect(state.drawnMissionIds).toHaveLength(1);
    for (let i = 0; i < 49; i++) {
      state.phase = "success";
      state = applyCommand(state, host, { type: "next_mission" });
    }
    expect(new Set(state.drawnMissionIds).size).toBe(50);
    state.phase = "success";
    expect(applyCommand(state, host, { type: "next_mission" }).phase).toBe(
      "campaign_complete",
    );
  });
  it("allows any room member (not just the host) to advance_trick", () => {
    let state = playing();
    while (state.phase !== "trick_result") {
      state = applyCommand(state, state.turnPlayerId!, {
        type: "play_card",
        cardId: legalCards(state, state.turnPlayerId!)[0],
      });
    }
    const nonHost = state.players.find((p) => p.id !== host)!.id;
    const advanced = applyCommand(state, nonHost, { type: "advance_trick" });
    expect(advanced.phase).toBe("playing");
  });
  it("moves sequential mode to campaign_complete after mission 50", () => {
    const input = room();
    input.settings.startMission = 50;
    let state = start(input);
    expect(state.missionId).toBe(50);
    state.phase = "success";
    const next = applyCommand(state, host, { type: "next_mission" });
    expect(next.phase).toBe("campaign_complete");
    expect(next.resultReason).toContain("모두 마쳤습니다");
  });
  it("plays a full legal attempt to a terminal result without consuming the 3-player extra card", () => {
    let state = playing();
    let count = 0;
    while (["playing", "trick_result"].includes(state.phase) && count++ < 70) {
      const actor = state.phase === "trick_result" ? host : state.turnPlayerId!;
      const command: Command =
        state.phase === "trick_result"
          ? { type: "advance_trick" }
          : { type: "play_card", cardId: legalCards(state, actor)[0] };
      state = applyCommand(state, actor, command);
      expect(SnapshotSchema.safeParse(project(state, host)).success).toBe(true);
    }
    expect(["success", "failure"]).toContain(state.phase);
    expect(state.trickNumber).toBeLessThanOrEqual(13);
    expect(deck()).toHaveLength(40);
  });
});
