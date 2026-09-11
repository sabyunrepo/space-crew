import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/rooms.ts";
import type { Envelope } from "../../shared/contracts.ts";

const createInput = () => ({
  commandId: crypto.randomUUID(),
  nickname: "별빛",
  settings: {
    name: "테스트",
    capacity: 3 as const,
    missionMode: "sequential" as const,
    startMission: 1,
  },
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "crew-rooms-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readyCommand = (revision: number): Envelope => ({
  commandId: crypto.randomUUID(),
  expectedRevision: revision,
  attemptId: null,
  command: { type: "set_ready", ready: true },
});

describe("RoomStore", () => {
  it("creates a room and authenticates by playerToken; unknown token is rejected", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const created = await store.createRoom(createInput());
      expect(created.playerToken.length).toBeGreaterThanOrEqual(32);
      const snap = await store.snapshot(
        created.snapshot.roomId,
        created.playerToken,
      );
      expect(snap.roomId).toBe(created.snapshot.roomId);
      expect(snap.me.playerId).toBe(created.snapshot.me.playerId);
      await expect(
        store.snapshot(created.snapshot.roomId, "not-a-real-token"),
      ).rejects.toMatchObject({ code: "NOT_MEMBER", status: 403 });
    });
  });

  it("invites, joins 3 players, starts the mission, and never leaks other hands or tokens", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      const invite = await store.invite(roomId, host.playerToken);
      const b = await store.joinRoom({
        commandId: crypto.randomUUID(),
        nickname: "코멧",
        inviteToken: invite,
      });
      const c = await store.joinRoom({
        commandId: crypto.randomUUID(),
        nickname: "노바",
        inviteToken: invite,
      });
      let snap = await store.command(
        roomId,
        host.playerToken,
        readyCommand(c.snapshot.revision),
      );
      snap = await store.command(roomId, b.playerToken, readyCommand(snap.revision));
      snap = await store.command(roomId, c.playerToken, readyCommand(snap.revision));
      snap = await store.command(roomId, host.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: snap.revision,
        attemptId: null,
        command: { type: "start_mission" },
      });
      expect(snap.phase).toBe("briefing");
      const [snapA, snapB, snapC] = await Promise.all([
        store.snapshot(roomId, host.playerToken),
        store.snapshot(roomId, b.playerToken),
        store.snapshot(roomId, c.playerToken),
      ]);
      for (const s of [snapA, snapB, snapC]) {
        expect(s).not.toHaveProperty("hands");
        expect(s).not.toHaveProperty("tokens");
        const text = JSON.stringify(s);
        expect(text).not.toMatch(/tokenHash|"tokens"/);
      }
      const allHands = [snapA.me.hand, snapB.me.hand, snapC.me.hand];
      const seen = new Set<string>();
      for (const hand of allHands)
        for (const cardId of hand) {
          expect(seen.has(cardId)).toBe(false);
          seen.add(cardId);
        }
    });
  });

  it("deduplicates a resent commandId and rejects a changed body", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const command = readyCommand(0);
      const first = await store.command(
        host.snapshot.roomId,
        host.playerToken,
        command,
      );
      const second = await store.command(
        host.snapshot.roomId,
        host.playerToken,
        command,
      );
      expect(second.revision).toBe(first.revision);
      await expect(
        store.command(host.snapshot.roomId, host.playerToken, {
          ...command,
          command: { type: "set_ready", ready: false },
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
  });

  it("rejects a stale expectedRevision with 409 and currentRevision", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      await store.command(host.snapshot.roomId, host.playerToken, readyCommand(0));
      await expect(
        store.command(host.snapshot.roomId, host.playerToken, readyCommand(0)),
      ).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
        status: 409,
        currentRevision: 1,
      });
    });
  });

  it("rejects play out of turn and cards outside legalCardIds", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      const invite = await store.invite(roomId, host.playerToken);
      const b = await store.joinRoom({
        commandId: crypto.randomUUID(),
        nickname: "코멧",
        inviteToken: invite,
      });
      const c = await store.joinRoom({
        commandId: crypto.randomUUID(),
        nickname: "노바",
        inviteToken: invite,
      });
      let snap = await store.command(
        roomId,
        host.playerToken,
        readyCommand(c.snapshot.revision),
      );
      snap = await store.command(roomId, b.playerToken, readyCommand(snap.revision));
      snap = await store.command(roomId, c.playerToken, readyCommand(snap.revision));
      snap = await store.command(roomId, host.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: snap.revision,
        attemptId: null,
        command: { type: "start_mission" },
      });
      const tokensByPlayerId = new Map([
        [host.snapshot.me.playerId, host.playerToken],
        [b.snapshot.me.playerId, b.playerToken],
        [c.snapshot.me.playerId, c.playerToken],
      ]);
      for (const player of snap.players) {
        const token = tokensByPlayerId.get(player.id)!;
        snap = await store.command(roomId, token, {
          commandId: crypto.randomUUID(),
          expectedRevision: snap.revision,
          attemptId: snap.attemptId,
          command: { type: "briefing_ready" },
        });
      }
      while (snap.phase === "task_selection") {
        const token = tokensByPlayerId.get(snap.turnPlayerId!)!;
        const view = await store.snapshot(roomId, token);
        const task = view.tasks.find((t) => !t.ownerId)!;
        snap = await store.command(roomId, token, {
          commandId: crypto.randomUUID(),
          expectedRevision: snap.revision,
          attemptId: snap.attemptId,
          command: { type: "choose_task", taskId: task.id },
        });
      }
      expect(snap.phase).toBe("playing");
      const notTurn = snap.players.find((p) => p.id !== snap.turnPlayerId)!;
      const notTurnToken = tokensByPlayerId.get(notTurn.id)!;
      const notTurnView = await store.snapshot(roomId, notTurnToken);
      await expect(
        store.command(roomId, notTurnToken, {
          commandId: crypto.randomUUID(),
          expectedRevision: snap.revision,
          attemptId: snap.attemptId,
          command: {
            type: "play_card",
            cardId: notTurnView.me.hand[0],
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_ACTION" });
      const turnToken = tokensByPlayerId.get(snap.turnPlayerId!)!;
      const turnView = await store.snapshot(roomId, turnToken);
      const illegal = turnView.me.hand.find(
        (c) => !turnView.me.legalCardIds.includes(c),
      );
      if (illegal) {
        await expect(
          store.command(roomId, turnToken, {
            commandId: crypto.randomUUID(),
            expectedRevision: snap.revision,
            attemptId: snap.attemptId,
            command: { type: "play_card", cardId: illegal },
          }),
        ).rejects.toMatchObject({ code: "INVALID_ACTION" });
      }
      const legalCard = turnView.me.legalCardIds[0];
      const played = await store.command(roomId, turnToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: snap.revision,
        attemptId: snap.attemptId,
        command: { type: "play_card", cardId: legalCard },
      });
      expect(played.trick.some((p) => p.cardId === legalCard)).toBe(true);
    });
  });

  it("restores a persisted room from a fresh RoomStore instance", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const after = await store.command(
        host.snapshot.roomId,
        host.playerToken,
        readyCommand(0),
      );
      const restored = new RoomStore({ dataDir, demoDelayMs: 0 });
      const snap = await restored.snapshot(
        host.snapshot.roomId,
        host.playerToken,
      );
      expect(snap).toEqual(after);
    });
  });

  it("fills empty seats with demo crew and auto-advances their turns", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      const filled = await store.fillDemoCrew(roomId, host.playerToken);
      expect(filled.players).toHaveLength(3);
      expect(filled.players.filter((p) => p.isDemo)).toHaveLength(2);
      const ready = await store.command(
        roomId,
        host.playerToken,
        readyCommand(filled.revision),
      );
      const started = await store.command(roomId, host.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: ready.revision,
        attemptId: null,
        command: { type: "start_mission" },
      });
      expect(started.phase).toBe("briefing");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = await store.snapshot(roomId, host.playerToken);
      expect(after.revision).toBeGreaterThan(started.revision);
      store.shutdown();
    });
  });
});
