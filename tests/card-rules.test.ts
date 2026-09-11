import { describe, expect, test } from "vitest";
import type { CardId, Snapshot } from "../shared/contracts.ts";
import { handAvailability } from "../src/components/table/cardRules.ts";

function fixture(overrides: Partial<Snapshot> = {}): Snapshot {
  const me = { id: "me", nickname: "별빛", seat: 0 };
  const rival = { id: "rival", nickname: "루나", seat: 1 };
  const base: Snapshot = {
    apiVersion: "1",
    roomId: "00000000-0000-0000-0000-000000000000",
    revision: 1,
    settings: {
      name: "테스트",
      capacity: 3,
      missionMode: "sequential",
      startMission: 1,
    },
    phase: "playing",
    missionId: 1,
    drawnMissionIds: [1],
    attemptId: "00000000-0000-0000-0000-000000000001",
    attemptNumber: 1,
    hostId: "me",
    commanderId: "me",
    turnPlayerId: "me",
    players: [
      {
        id: me.id,
        nickname: me.nickname,
        seat: 0,
        ready: true,
        briefingReady: true,
        cardCount: 3,
        tricksWon: 0,
        isDemo: false,
        communication: null,
      },
      {
        id: rival.id,
        nickname: rival.nickname,
        seat: 1,
        ready: true,
        briefingReady: true,
        cardCount: 3,
        tricksWon: 0,
        isDemo: false,
        communication: null,
      },
    ],
    me: {
      playerId: "me",
      hand: ["blue-3", "green-5", "rocket-1"] as CardId[],
      legalCardIds: ["blue-3"] as CardId[],
      canCommunicate: false,
    },
    tasks: [],
    trick: [{ playerId: "rival", cardId: "blue-7" as CardId }],
    lastTrick: null,
    trickNumber: 1,
    resultReason: null,
    updatedAt: new Date().toISOString(),
    rulesetVersion: "test",
  };
  return { ...base, ...overrides };
}

describe("handAvailability", () => {
  test("play + leading blue: only the matching blue card is enabled", () => {
    const snapshot = fixture();
    const result = handAvailability(snapshot, "play");
    expect(result).toEqual([
      { cardId: "blue-3", enabled: true, reason: null },
      {
        cardId: "green-5",
        enabled: false,
        reason: "선도 색(파랑) 카드가 있으면 그 색을 내야 해요",
      },
      {
        cardId: "rocket-1",
        enabled: false,
        reason: "선도 색(파랑) 카드가 있으면 그 색을 내야 해요",
      },
    ]);
  });

  test("play + no leading card: everything is enabled", () => {
    const snapshot = fixture({
      trick: [],
      me: {
        playerId: "me",
        hand: ["blue-3", "green-5", "rocket-1"] as CardId[],
        legalCardIds: ["blue-3", "green-5", "rocket-1"] as CardId[],
        canCommunicate: true,
      },
    });
    const result = handAvailability(snapshot, "play");
    expect(result.every((c) => c.enabled)).toBe(true);
    expect(result.every((c) => c.reason === null)).toBe(true);
  });

  test("play + not my turn: every card is disabled with the turn player's nickname", () => {
    const snapshot = fixture({ turnPlayerId: "rival" });
    const result = handAvailability(snapshot, "play");
    expect(result.every((c) => c.enabled === false)).toBe(true);
    expect(result.every((c) => c.reason === "루나 대원의 차례예요")).toBe(
      true,
    );
  });

  test("communicate mode: rocket cards are disabled", () => {
    const snapshot = fixture({
      me: {
        playerId: "me",
        hand: ["blue-3", "rocket-1"] as CardId[],
        legalCardIds: ["blue-3", "rocket-1"] as CardId[],
        canCommunicate: true,
      },
    });
    const result = handAvailability(snapshot, "communicate");
    const rocket = result.find((c) => c.cardId === "rocket-1")!;
    expect(rocket.enabled).toBe(false);
    expect(rocket.reason).toBe("로켓 카드는 교신할 수 없어요");
  });

  test("communicate mode: a middle-rank card (neither highest, lowest, nor only) is disabled — same judgement as the engine's communicationMarkers", () => {
    const snapshot = fixture({
      me: {
        playerId: "me",
        hand: ["blue-3", "blue-5", "blue-7"] as CardId[],
        legalCardIds: ["blue-3", "blue-5", "blue-7"] as CardId[],
        canCommunicate: true,
      },
    });
    const result = handAvailability(snapshot, "communicate");
    expect(result.find((c) => c.cardId === "blue-3")!.enabled).toBe(true);
    expect(result.find((c) => c.cardId === "blue-7")!.enabled).toBe(true);
    const middle = result.find((c) => c.cardId === "blue-5")!;
    expect(middle.enabled).toBe(false);
    expect(middle.reason).toBe(
      "이 색에서 가장 높거나 낮거나 유일한 카드만 교신할 수 있어요",
    );
  });

  test("communicate mode: with four cards of one color, both middle ranks are disabled and only the extremes are enabled", () => {
    const snapshot = fixture({
      me: {
        playerId: "me",
        hand: ["green-2", "green-4", "green-6", "green-8"] as CardId[],
        legalCardIds: ["green-2", "green-4", "green-6", "green-8"] as CardId[],
        canCommunicate: true,
      },
    });
    const result = handAvailability(snapshot, "communicate");
    expect(result.find((c) => c.cardId === "green-2")!.enabled).toBe(true);
    expect(result.find((c) => c.cardId === "green-8")!.enabled).toBe(true);
    for (const cardId of ["green-4", "green-6"] as CardId[]) {
      const middle = result.find((c) => c.cardId === cardId)!;
      expect(middle.enabled).toBe(false);
      expect(middle.reason).toBe(
        "이 색에서 가장 높거나 낮거나 유일한 카드만 교신할 수 있어요",
      );
    }
  });

  test("view mode: everything enabled regardless of turn or legality", () => {
    const snapshot = fixture({ turnPlayerId: "rival" });
    const result = handAvailability(snapshot, "view");
    expect(result.every((c) => c.enabled)).toBe(true);
    expect(result.every((c) => c.reason === null)).toBe(true);
  });
});
