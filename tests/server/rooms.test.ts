import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
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

const missionFourInput = () => ({
  commandId: crypto.randomUUID(),
  nickname: "별빛",
  settings: {
    name: "테스트",
    capacity: 3 as const,
    missionMode: "sequential" as const,
    startMission: 4, // taskCount 3: reaching an intermediate trick_result is overwhelmingly likely
  },
});

/** Plays a mission 4 attempt (all real players, always the first legal card)
 * up to the first "trick_result" phase. Mission outcomes depend on the
 * engine's unseeded shuffle, so on the rare run that resolves straight to
 * success/failure without an intermediate trick, the caller retries with a
 * fresh room. Returns the tokens keyed by playerId alongside the snapshot. */
async function playToTrickResult(
  store: InstanceType<typeof RoomStore>,
): Promise<{ roomId: string; tokens: Map<string, string>; snap: Awaited<ReturnType<InstanceType<typeof RoomStore>["snapshot"]>> } | null> {
  const host = await store.createRoom(missionFourInput());
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
  const tokens = new Map([
    [host.snapshot.me.playerId, host.playerToken],
    [b.snapshot.me.playerId, b.playerToken],
    [c.snapshot.me.playerId, c.playerToken],
  ]);
  let snap = await store.command(roomId, host.playerToken, readyCommand(c.snapshot.revision));
  snap = await store.command(roomId, b.playerToken, readyCommand(snap.revision));
  snap = await store.command(roomId, c.playerToken, readyCommand(snap.revision));
  snap = await store.command(roomId, host.playerToken, {
    commandId: crypto.randomUUID(),
    expectedRevision: snap.revision,
    attemptId: null,
    command: { type: "start_mission" },
  });
  for (const player of snap.players) {
    snap = await store.command(roomId, tokens.get(player.id)!, {
      commandId: crypto.randomUUID(),
      expectedRevision: snap.revision,
      attemptId: snap.attemptId,
      command: { type: "briefing_ready" },
    });
  }
  while (snap.phase === "task_selection") {
    const token = tokens.get(snap.turnPlayerId!)!;
    const view = await store.snapshot(roomId, token);
    const task = view.tasks.find((t) => !t.ownerId)!;
    snap = await store.command(roomId, token, {
      commandId: crypto.randomUUID(),
      expectedRevision: snap.revision,
      attemptId: snap.attemptId,
      command: { type: "choose_task", taskId: task.id },
    });
  }
  let guard = 0;
  while (snap.phase === "playing" && guard++ < 60) {
    const token = tokens.get(snap.turnPlayerId!)!;
    const view = await store.snapshot(roomId, token);
    snap = await store.command(roomId, token, {
      commandId: crypto.randomUUID(),
      expectedRevision: snap.revision,
      attemptId: snap.attemptId,
      command: { type: "play_card", cardId: view.me.legalCardIds[0] },
    });
  }
  if (snap.phase !== "trick_result") return null;
  return { roomId, tokens, snap };
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

  it("rejects a stale expectedRevision with 409 and currentRevision for commands other than set_ready/briefing_ready", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      await store.command(host.snapshot.roomId, host.playerToken, readyCommand(0));
      await expect(
        store.command(host.snapshot.roomId, host.playerToken, {
          commandId: crypto.randomUUID(),
          expectedRevision: 0,
          attemptId: null,
          command: { type: "update_settings", settings: createInput().settings },
        }),
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

describe("RoomStore hardening (H1/H2/M1/M2/M3/M9)", () => {
  it("single-flights concurrent loadRoom calls for the same uncached room instead of racing two disk reads", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      const fresh = new RoomStore({ dataDir, demoDelayMs: 0 });
      const [a, b] = await Promise.all([
        (fresh as any).loadRoom(roomId),
        (fresh as any).loadRoom(roomId),
      ]);
      expect(a).toBe(b);
    });
  });

  it("does not scan or cache unrelated rooms when resolving an invite token", async () => {
    await withTempDir(async (dataDir) => {
      const s1 = new RoomStore({ dataDir, demoDelayMs: 0 });
      for (let i = 0; i < 5; i++) await s1.createRoom(createInput());
      const s2 = new RoomStore({ dataDir, demoDelayMs: 0 });
      await expect(
        s2.joinRoom({
          commandId: crypto.randomUUID(),
          nickname: "x",
          inviteToken: "A".repeat(32),
        }),
      ).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
      expect((s2 as any).rooms.size).toBe(0);
    });
  });

  it("keeps the in-memory cache consistent with disk across repeated concurrent access on freshly restarted stores (load-race regression)", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const rooms: { id: string; token: string }[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await store.createRoom(createInput());
        rooms.push({ id: r.snapshot.roomId, token: r.playerToken });
      }
      const trials = 100;
      for (let t = 0; t < trials; t++) {
        const fresh = new RoomStore({ dataDir, demoDelayMs: 0 });
        const target = rooms[t % rooms.length];
        const diskBefore = JSON.parse(
          await readFile(join(dataDir, "rooms", `${target.id}.json`), "utf8"),
        ).state.revision;
        await Promise.all([
          fresh.command(target.id, target.token, {
            commandId: crypto.randomUUID(),
            expectedRevision: diskBefore,
            attemptId: null,
            command: { type: "set_ready", ready: diskBefore % 2 === 0 },
          }),
          fresh
            .joinRoom({
              commandId: crypto.randomUUID(),
              nickname: "x",
              inviteToken: "B".repeat(32),
            })
            .catch(() => {}),
        ]);
        const cachedRevision = (fresh as any).rooms.get(target.id).state.revision;
        const diskAfter = JSON.parse(
          await readFile(join(dataDir, "rooms", `${target.id}.json`), "utf8"),
        ).state.revision;
        expect(cachedRevision).toBe(diskAfter);
        expect(diskAfter).toBe(diskBefore + 1);
      }
    });
  });

  it("removes the per-room queue entry once it drains", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      await store.command(host.snapshot.roomId, host.playerToken, readyCommand(0));
      await new Promise((r) => setTimeout(r, 0));
      expect((store as any).queues.has(host.snapshot.roomId)).toBe(false);
    });
  });

  it("returns ROOM_NOT_FOUND for an unknown room without creating a queue entry", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const bogus = crypto.randomUUID();
      await expect(store.snapshot(bogus, "x")).rejects.toMatchObject({
        code: "ROOM_NOT_FOUND",
        status: 404,
      });
      expect((store as any).queues.has(bogus)).toBe(false);
      expect((store as any).rooms.has(bogus)).toBe(false);
    });
  });

  it("expires create receipts after their TTL so a reused commandId is treated as new", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0, receiptsTtlMs: 30 });
      const commandId = crypto.randomUUID();
      const input = { ...createInput(), commandId };
      const first = await store.createRoom(input);
      await expect(
        store.createRoom({ ...input, nickname: "다른이름" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await new Promise((r) => setTimeout(r, 80));
      const second = await store.createRoom({ ...input, nickname: "다른이름" });
      expect(second.snapshot.roomId).not.toBe(first.snapshot.roomId);
    });
  });

  it("caps create receipts at maxReceipts, evicting the oldest first", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0, maxReceipts: 2 });
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const commandId of ids)
        await store.createRoom({ ...createInput(), commandId });
      await expect(
        store.createRoom({ ...createInput(), commandId: ids[0], nickname: "다른이름" }),
      ).resolves.toBeTruthy();
      await expect(
        store.createRoom({ ...createInput(), commandId: ids[2], nickname: "다른이름" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
  });

  it("evicts an idle, connection-free room from the in-memory cache but keeps it readable from disk", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({
        dataDir,
        demoDelayMs: 0,
        roomIdleEvictMs: 10,
        cacheSweepIntervalMs: 5,
      });
      const host = await store.createRoom(createInput());
      await new Promise((r) => setTimeout(r, 60));
      expect((store as any).rooms.has(host.snapshot.roomId)).toBe(false);
      const snap = await store.snapshot(host.snapshot.roomId, host.playerToken);
      expect(snap.roomId).toBe(host.snapshot.roomId);
      store.shutdown();
    });
  });

  it("keeps a room cached past the idle window while it has an active WS connection", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({
        dataDir,
        demoDelayMs: 0,
        roomIdleEvictMs: 10,
        cacheSweepIntervalMs: 5,
      });
      const host = await store.createRoom(createInput());
      store.connectionOpened(host.snapshot.roomId);
      await new Promise((r) => setTimeout(r, 60));
      expect((store as any).rooms.has(host.snapshot.roomId)).toBe(true);
      store.connectionClosed(host.snapshot.roomId);
      store.shutdown();
    });
  });

  it("rejects new room creation with SERVER_BUSY once the active room cache is full", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0, maxCachedRooms: 2 });
      await store.createRoom(createInput());
      await store.createRoom(createInput());
      await expect(store.createRoom(createInput())).rejects.toMatchObject({
        code: "SERVER_BUSY",
        status: 503,
      });
      store.shutdown();
    });
  });

  it("keeps memory state unchanged when the disk write fails, then succeeds on a same-commandId retry once writable again", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const before = await store.snapshot(host.snapshot.roomId, host.playerToken);
      const roomsPath = join(dataDir, "rooms");
      await chmod(roomsPath, 0o500);
      const commandId = crypto.randomUUID();
      const envelope: Envelope = {
        commandId,
        expectedRevision: before.revision,
        attemptId: null,
        command: { type: "set_ready", ready: true },
      };
      try {
        await expect(
          store.command(host.snapshot.roomId, host.playerToken, envelope),
        ).rejects.toBeTruthy();
      } finally {
        await chmod(roomsPath, 0o700);
      }
      const stillBefore = await store.snapshot(host.snapshot.roomId, host.playerToken);
      expect(stillBefore.revision).toBe(before.revision);
      expect(stillBefore.players[0].ready).toBe(before.players[0].ready);
      const retried = await store.command(
        host.snapshot.roomId,
        host.playerToken,
        envelope,
      );
      expect(retried.revision).toBe(before.revision + 1);
      expect(retried.players[0].ready).toBe(true);
    });
  });

  it("re-arms the AI timer for a pending demo turn after loading a room fresh from disk", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 500 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      let s = await store.fillDemoCrew(roomId, host.playerToken);
      s = await store.command(roomId, host.playerToken, readyCommand(s.revision));
      s = await store.command(roomId, host.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: s.revision,
        attemptId: null,
        command: { type: "start_mission" },
      });
      expect(s.phase).toBe("briefing");
      store.shutdown(); // simulate a process restart before the AI timer fires
      const restored = new RoomStore({ dataDir, demoDelayMs: 30 });
      const before = await restored.snapshot(roomId, host.playerToken);
      await new Promise((r) => setTimeout(r, 150));
      const after = await restored.snapshot(roomId, host.playerToken);
      expect(after.revision).toBeGreaterThan(before.revision);
      restored.shutdown();
    });
  });

  it("backs off retries when persisting a bot move fails, and recovers once the disk is writable again", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 15 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      let s = await store.fillDemoCrew(roomId, host.playerToken);
      s = await store.command(roomId, host.playerToken, readyCommand(s.revision));
      s = await store.command(roomId, host.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: s.revision,
        attemptId: null,
        command: { type: "start_mission" },
      });
      expect(s.phase).toBe("briefing");
      const roomsPath = join(dataDir, "rooms");
      await chmod(roomsPath, 0o500);
      await new Promise((r) => setTimeout(r, 120));
      await chmod(roomsPath, 0o700);
      await new Promise((r) => setTimeout(r, 400));
      const after = await store.snapshot(roomId, host.playerToken);
      expect(after.revision).toBeGreaterThan(s.revision);
      store.shutdown();
    });
  });

  it("shares one in-flight result for concurrent createRoom calls with the same commandId", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const commandId = crypto.randomUUID();
      const input = { ...createInput(), commandId };
      const [a, b] = await Promise.all([
        store.createRoom(input),
        store.createRoom(input),
      ]);
      expect(a.snapshot.roomId).toBe(b.snapshot.roomId);
      expect(a.playerToken).toBe(b.playerToken);
    });
  });

  it("shares one in-flight result for concurrent joinRoom calls with the same commandId (no duplicate seat)", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const invite = await store.invite(host.snapshot.roomId, host.playerToken);
      const commandId = crypto.randomUUID();
      const input = { commandId, nickname: "친구", inviteToken: invite };
      const [a, b] = await Promise.all([
        store.joinRoom(input),
        store.joinRoom(input),
      ]);
      expect(a.playerToken).toBe(b.playerToken);
      const snap = await store.snapshot(host.snapshot.roomId, host.playerToken);
      expect(snap.players).toHaveLength(2);
    });
  });

  it("applies set_ready even against a stale expectedRevision instead of rejecting with REVISION_CONFLICT", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0 });
      const host = await store.createRoom(createInput());
      const roomId = host.snapshot.roomId;
      await store.command(roomId, host.playerToken, readyCommand(0)); // revision -> 1, ready=true
      const result = await store.command(roomId, host.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: 0, // stale on purpose
        attemptId: null,
        command: { type: "set_ready", ready: false },
      });
      expect(result.players[0].ready).toBe(false);
    });
  });

  it("applies briefing_ready even against a stale expectedRevision instead of rejecting with REVISION_CONFLICT", async () => {
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
      const stale = snap.revision - 1;
      const applied = await store.command(roomId, b.playerToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: stale,
        attemptId: snap.attemptId,
        command: { type: "briefing_ready" },
      });
      expect(
        applied.players.find((p) => p.id === b.snapshot.me.playerId)?.briefingReady,
      ).toBe(true);
    });
  });

  it("M10: automatically advances a resolved trick after trickAdvanceDelayMs if nobody does first", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0, trickAdvanceDelayMs: 30 });
      let result: Awaited<ReturnType<typeof playToTrickResult>> = null;
      for (let attempt = 0; attempt < 5 && !result; attempt++)
        result = await playToTrickResult(store);
      expect(result).not.toBeNull();
      const { roomId, tokens, snap } = result!;
      await new Promise((r) => setTimeout(r, 150));
      const after = await store.snapshot(roomId, [...tokens.values()][0]);
      expect(after.phase).toBe("playing");
      expect(after.revision).toBe(snap.revision + 1);
      store.shutdown();
    });
  });

  it("M10: a manual advance_trick before the timer fires wins, and the timer's own attempt is a no-op", async () => {
    await withTempDir(async (dataDir) => {
      const store = new RoomStore({ dataDir, demoDelayMs: 0, trickAdvanceDelayMs: 60 });
      let result: Awaited<ReturnType<typeof playToTrickResult>> = null;
      for (let attempt = 0; attempt < 5 && !result; attempt++)
        result = await playToTrickResult(store);
      expect(result).not.toBeNull();
      const { roomId, tokens, snap } = result!;
      // Any member (not just the winner/host) may advance manually - M10.
      const anyToken = [...tokens.values()][0];
      const advanced = await store.command(roomId, anyToken, {
        commandId: crypto.randomUUID(),
        expectedRevision: snap.revision,
        attemptId: snap.attemptId,
        command: { type: "advance_trick" },
      });
      expect(advanced.phase).toBe("playing");
      // Wait past the original timer window: it must see the revision has
      // already moved on and do nothing (no error, no double-advance).
      await new Promise((r) => setTimeout(r, 120));
      const after = await store.snapshot(roomId, anyToken);
      expect(after.revision).toBe(advanced.revision);
      store.shutdown();
    });
  });
});
