import { createHash, randomBytes } from "node:crypto";
import {
  ApiError,
  type CreateRoom,
  type Envelope,
  type JoinRoom,
  type Snapshot,
} from "../shared/contracts.ts";
import {
  applyCommand,
  createState,
  fail,
  newPlayer,
  project,
  type State,
} from "../src/game/engine.ts";
import { pendingDemoActor, demoCommand } from "../src/game/demo.ts";
import {
  listRoomIds,
  pruneStaleRoomFiles,
  readRoomFile,
  roomFileExists,
  writeRoomFile,
} from "./persist.ts";

const DEMO_NAMES = ["루나", "코멧", "노바", "오리온"];
const DEFAULT_DEMO_DELAY_MS = 700;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RECEIPTS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RECEIPTS = 1000;
const DEFAULT_ROOM_IDLE_EVICT_MS = 30 * 60 * 1000;
const DEFAULT_CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CACHED_ROOMS = 500;
const MAX_DEMO_BACKOFF_MS = 30_000;
const DEFAULT_TRICK_ADVANCE_DELAY_MS = 2500;
/** Commands that must apply against the latest state instead of bouncing a
 * stale expectedRevision: they are actor-idempotent (re-applying the same
 * value is a no-op) so a lobby/briefing race between players shouldn't force
 * a client to retry. Every other command keeps the strict revision check. */
const REVISION_BYPASS_COMMANDS = new Set(["set_ready", "briefing_ready"]);

type RoomRecord = {
  state: State;
  /** sha256(playerToken) -> playerId. Raw tokens are never persisted. */
  tokens: Record<string, string>;
  inviteToken: string;
  commandReceipts: Record<string, { actor: string; body: string }>;
};

type CreateResult = {
  snapshot: Snapshot;
  inviteToken: string;
  playerToken: string;
};
type JoinResult = { snapshot: Snapshot; playerToken: string };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

function issueInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * A tiny TTL + max-size cache for idempotency receipts (createRoom/joinRoom
 * commandId -> result). Bounds memory against an attacker (or a buggy
 * client) that sends an unbounded stream of distinct commandIds.
 */
class TtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private ttlMs: number,
    private maxSize: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    const now = Date.now();
    for (const [k, entry] of this.map) if (entry.expiresAt <= now) this.map.delete(k);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/**
 * Server-side room storage: token-authenticated command execution, atomic
 * disk persistence, and timer-driven AI turns. Mirrors the demo semantics of
 * src/services/mock.ts, but trusts nothing the client sends about identity —
 * every mutation is bound to the playerId resolved from a Bearer playerToken.
 */
export class RoomStore {
  private dataDir: string;
  private demoDelayMs: number;
  private rooms = new Map<string, RoomRecord>();
  private lastAccessed = new Map<string, number>();
  private activeConnections = new Map<string, number>();
  private loading = new Map<string, Promise<RoomRecord>>();
  private queues = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private trickTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private demoBackoff = new Map<string, number>();
  private trickAdvanceDelayMs: number;
  private createReceipts: TtlCache<{ body: string; result: CreateResult }>;
  private joinReceipts: TtlCache<{ body: string; result: JoinResult }>;
  private createInflight = new Map<
    string,
    { body: string; promise: Promise<CreateResult> }
  >();
  private joinInflight = new Map<
    string,
    { body: string; promise: Promise<JoinResult> }
  >();
  private inviteIndex = new Map<string, string>();
  private inviteIndexReady: Promise<void> | null = null;
  private pendingInviteInserts: { token: string; roomId: string }[] = [];
  private revisionListeners: ((roomId: string, revision: number) => void)[] =
    [];
  private roomIdleEvictMs: number;
  private maxCachedRooms: number;
  private cacheSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    dataDir: string;
    demoDelayMs?: number;
    receiptsTtlMs?: number;
    maxReceipts?: number;
    roomIdleEvictMs?: number;
    cacheSweepIntervalMs?: number;
    maxCachedRooms?: number;
    trickAdvanceDelayMs?: number;
  }) {
    this.dataDir = options.dataDir;
    this.demoDelayMs = options.demoDelayMs ?? DEFAULT_DEMO_DELAY_MS;
    this.trickAdvanceDelayMs =
      options.trickAdvanceDelayMs ?? DEFAULT_TRICK_ADVANCE_DELAY_MS;
    this.createReceipts = new TtlCache(
      options.receiptsTtlMs ?? DEFAULT_RECEIPTS_TTL_MS,
      options.maxReceipts ?? DEFAULT_MAX_RECEIPTS,
    );
    this.joinReceipts = new TtlCache(
      options.receiptsTtlMs ?? DEFAULT_RECEIPTS_TTL_MS,
      options.maxReceipts ?? DEFAULT_MAX_RECEIPTS,
    );
    this.roomIdleEvictMs = options.roomIdleEvictMs ?? DEFAULT_ROOM_IDLE_EVICT_MS;
    this.maxCachedRooms = options.maxCachedRooms ?? DEFAULT_MAX_CACHED_ROOMS;
    const sweepMs = options.cacheSweepIntervalMs ?? DEFAULT_CACHE_SWEEP_INTERVAL_MS;
    this.cacheSweepTimer = setInterval(() => this.sweepIdleRooms(), sweepMs);
    if (typeof this.cacheSweepTimer.unref === "function")
      this.cacheSweepTimer.unref();
  }

  onRevision(listener: (roomId: string, revision: number) => void): void {
    this.revisionListeners.push(listener);
  }

  private notify(roomId: string, revision: number): void {
    for (const listener of this.revisionListeners) listener(roomId, revision);
  }

  async pruneStaleRooms(maxAgeMs = THIRTY_DAYS_MS): Promise<string[]> {
    return pruneStaleRoomFiles(this.dataDir, maxAgeMs);
  }

  /** Called by the WS layer when a connection for this room registers. */
  connectionOpened(roomId: string): void {
    this.activeConnections.set(roomId, (this.activeConnections.get(roomId) ?? 0) + 1);
  }

  /** Called by the WS layer when a connection for this room closes. */
  connectionClosed(roomId: string): void {
    const count = (this.activeConnections.get(roomId) ?? 0) - 1;
    if (count <= 0) this.activeConnections.delete(roomId);
    else this.activeConnections.set(roomId, count);
  }

  /** Evicts idle, connection-free rooms from the in-memory cache. The room's
   * file on disk is untouched, so the next request simply reloads it. */
  private sweepIdleRooms(): void {
    const now = Date.now();
    for (const roomId of this.rooms.keys()) {
      if (this.timers.has(roomId)) continue; // an AI turn is pending
      if ((this.activeConnections.get(roomId) ?? 0) > 0) continue;
      const last = this.lastAccessed.get(roomId) ?? 0;
      if (now - last > this.roomIdleEvictMs) {
        this.rooms.delete(roomId);
        this.lastAccessed.delete(roomId);
      }
    }
  }

  /** Clears pending AI/eviction timers. Call when shutting a process/test down. */
  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.trickTimers.values()) clearTimeout(timer);
    this.trickTimers.clear();
    if (this.cacheSweepTimer) {
      clearInterval(this.cacheSweepTimer);
      this.cacheSweepTimer = null;
    }
  }

  private async loadRoom(roomId: string): Promise<RoomRecord> {
    const cached = this.rooms.get(roomId);
    if (cached) {
      this.lastAccessed.set(roomId, Date.now());
      return cached;
    }
    const inflight = this.loading.get(roomId);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const loaded = await readRoomFile<RoomRecord>(this.dataDir, roomId);
        if (!loaded) fail("ROOM_NOT_FOUND", "존재하지 않는 방입니다.", 404);
        // Another caller may have populated the cache while this read was
        // in flight (e.g. via a fresh createRoom for a different room that
        // shares no state, or a retry after this same load) - prefer it so
        // we never clobber newer in-memory state with a stale disk read.
        const already = this.rooms.get(roomId);
        if (already) return already;
        this.rooms.set(roomId, loaded);
        this.lastAccessed.set(roomId, Date.now());
        this.maybeScheduleDemo(loaded);
        this.maybeScheduleTrickAdvance(loaded);
        return loaded;
      } finally {
        this.loading.delete(roomId);
      }
    })();
    this.loading.set(roomId, promise);
    return promise;
  }

  /**
   * Serializes every mutation (read, apply, persist) on one room through a
   * single promise chain, so concurrent requests for the same room never
   * interleave. `fn` may mutate `record` in place and must persist itself
   * (via `this.persist`) before returning if it changed anything.
   */
  private async withRoom<T>(
    roomId: string,
    fn: (record: RoomRecord) => Promise<T> | T,
  ): Promise<T> {
    if (!this.rooms.has(roomId)) {
      // An attacker (or a stale client) can request arbitrary room ids; only
      // create a queue entry - and keep it warm in memory - for ids that are
      // actually backed by a room file.
      if (!(await roomFileExists(this.dataDir, roomId)))
        fail("ROOM_NOT_FOUND", "존재하지 않는 방입니다.", 404);
    }
    const prior = this.queues.get(roomId) ?? Promise.resolve();
    const run = prior.then(
      async () => fn(await this.loadRoom(roomId)),
      async () => fn(await this.loadRoom(roomId)),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(roomId, tail);
    tail.then(() => {
      if (this.queues.get(roomId) === tail) this.queues.delete(roomId);
    });
    return run;
  }

  /** Writes to disk first; the in-memory cache (and any receipts/notifications
   * a caller records afterwards) is only updated once the write has
   * succeeded, so a failed write never leaves memory ahead of disk. */
  private async persist(roomId: string, record: RoomRecord): Promise<void> {
    await writeRoomFile(this.dataDir, roomId, record);
    this.rooms.set(roomId, record);
    this.lastAccessed.set(roomId, Date.now());
  }

  private resolveActor(record: RoomRecord, token: string): string {
    const playerId = record.tokens[hashToken(token)];
    if (!playerId) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
    return playerId;
  }

  private async ensureInviteIndex(): Promise<void> {
    if (this.inviteIndexReady) return this.inviteIndexReady;
    this.inviteIndexReady = (async () => {
      for (const id of await listRoomIds(this.dataDir)) {
        const record = await readRoomFile<RoomRecord>(this.dataDir, id).catch(
          () => null,
        );
        if (record && !this.inviteIndex.has(record.inviteToken))
          this.inviteIndex.set(record.inviteToken, id);
      }
      for (const { token, roomId } of this.pendingInviteInserts)
        this.inviteIndex.set(token, roomId);
      this.pendingInviteInserts = [];
    })();
    return this.inviteIndexReady;
  }

  private registerInvite(token: string, roomId: string): void {
    if (this.inviteIndexReady) this.inviteIndex.set(token, roomId);
    else this.pendingInviteInserts.push({ token, roomId });
  }

  private async findRoomIdByInvite(inviteToken: string): Promise<string | null> {
    await this.ensureInviteIndex();
    return this.inviteIndex.get(inviteToken) ?? null;
  }

  async createRoom(input: CreateRoom): Promise<CreateResult> {
    const body = JSON.stringify(input);
    const cached = this.createReceipts.get(input.commandId);
    if (cached) {
      if (cached.body !== body)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 번호에 다른 내용이 전달되었습니다.",
          409,
        );
      return cached.result;
    }
    const pending = this.createInflight.get(input.commandId);
    if (pending) {
      if (pending.body !== body)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 번호에 다른 내용이 전달되었습니다.",
          409,
        );
      return pending.promise;
    }
    const promise = this.doCreateRoom(input, body);
    this.createInflight.set(input.commandId, { body, promise });
    try {
      return await promise;
    } finally {
      this.createInflight.delete(input.commandId);
    }
  }

  private async doCreateRoom(input: CreateRoom, body: string): Promise<CreateResult> {
    if (this.rooms.size >= this.maxCachedRooms)
      fail(
        "SERVER_BUSY",
        "서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.",
        503,
      );
    const playerId = crypto.randomUUID();
    const { token, hash } = issueToken();
    const state = createState(playerId, input.nickname, input.settings, input.characterId);
    const record: RoomRecord = {
      state,
      tokens: { [hash]: playerId },
      inviteToken: issueInviteToken(),
      commandReceipts: {},
    };
    await this.persist(state.roomId, record);
    this.registerInvite(record.inviteToken, state.roomId);
    const result: CreateResult = {
      snapshot: project(state, playerId),
      inviteToken: record.inviteToken,
      playerToken: token,
    };
    this.createReceipts.set(input.commandId, { body, result });
    return result;
  }

  async joinRoom(input: JoinRoom): Promise<JoinResult> {
    const body = JSON.stringify(input);
    const cached = this.joinReceipts.get(input.commandId);
    if (cached) {
      if (cached.body !== body)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 번호에 다른 내용이 전달되었습니다.",
          409,
        );
      return cached.result;
    }
    const pending = this.joinInflight.get(input.commandId);
    if (pending) {
      if (pending.body !== body)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 번호에 다른 내용이 전달되었습니다.",
          409,
        );
      return pending.promise;
    }
    const promise = this.doJoinRoom(input, body);
    this.joinInflight.set(input.commandId, { body, promise });
    try {
      return await promise;
    } finally {
      this.joinInflight.delete(input.commandId);
    }
  }

  private async doJoinRoom(input: JoinRoom, body: string): Promise<JoinResult> {
    const roomId = await this.findRoomIdByInvite(input.inviteToken);
    if (!roomId)
      fail("INVITE_NOT_FOUND", "초대 링크를 찾을 수 없습니다.", 404);
    const result = await this.withRoom(roomId, async (record) => {
      if (
        record.state.phase !== "lobby" ||
        record.state.players.length >= record.state.settings.capacity
      )
        fail("ROOM_FULL", "입장 가능한 좌석이 없습니다.");
      const playerId = crypto.randomUUID();
      const { token, hash } = issueToken();
      const nextState: State = {
        ...record.state,
        players: [
          ...record.state.players,
          newPlayer(playerId, input.nickname, record.state.players.length, false, input.characterId),
        ],
        hands: { ...record.state.hands, [playerId]: [] },
        revision: record.state.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const nextRecord: RoomRecord = {
        ...record,
        state: nextState,
        tokens: { ...record.tokens, [hash]: playerId },
      };
      await this.persist(roomId, nextRecord);
      this.notify(roomId, nextState.revision);
      return { snapshot: project(nextState, playerId), playerToken: token };
    });
    this.joinReceipts.set(input.commandId, { body, result });
    return result;
  }

  async snapshot(roomId: string, token: string): Promise<Snapshot> {
    return this.withRoom(roomId, (record) => {
      const actor = this.resolveActor(record, token);
      return project(record.state, actor);
    });
  }

  async invite(roomId: string, token: string): Promise<string> {
    return this.withRoom(roomId, (record) => {
      const actor = this.resolveActor(record, token);
      if (record.state.hostId !== actor)
        fail("FORBIDDEN", "방장만 초대 링크를 발급할 수 있습니다.", 403);
      return record.inviteToken;
    });
  }

  async command(
    roomId: string,
    token: string,
    input: Envelope,
  ): Promise<Snapshot> {
    return this.withRoom(roomId, async (record) => {
      const actor = this.resolveActor(record, token);
      const body = JSON.stringify(input);
      const previous = record.commandReceipts[input.commandId];
      if (previous) {
        if (previous.actor !== actor || previous.body !== body)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "같은 요청 번호를 다른 행동에 사용할 수 없습니다.",
          );
        return project(record.state, actor);
      }
      const bypassesRevisionCheck = REVISION_BYPASS_COMMANDS.has(
        input.command.type,
      );
      if (
        !bypassesRevisionCheck &&
        record.state.revision !== input.expectedRevision
      )
        throw new ApiError(
          "REVISION_CONFLICT",
          "다른 대원의 행동이 먼저 반영되었습니다. 최신 상태에서 다시 선택해 주세요.",
          409,
          record.state.revision,
        );
      if (record.state.attemptId !== input.attemptId)
        fail(
          "ATTEMPT_MISMATCH",
          "이전 시도의 행동입니다. 새 임무 상태를 확인해 주세요.",
        );
      const nextState = applyCommand(record.state, actor, input.command);
      const nextRecord: RoomRecord = {
        ...record,
        state: nextState,
        commandReceipts: {
          ...record.commandReceipts,
          [input.commandId]: { actor, body },
        },
      };
      await this.persist(roomId, nextRecord);
      this.notify(roomId, nextState.revision);
      this.maybeScheduleDemo(nextRecord);
      this.maybeScheduleTrickAdvance(nextRecord);
      return project(nextState, actor);
    });
  }

  async fillDemoCrew(roomId: string, token: string): Promise<Snapshot> {
    return this.withRoom(roomId, async (record) => {
      const actor = this.resolveActor(record, token);
      if (record.state.hostId !== actor || record.state.phase !== "lobby")
        fail("FORBIDDEN", "대기실의 방장만 데모 대원을 추가할 수 있습니다.");
      const players = [...record.state.players];
      const hands = { ...record.state.hands };
      while (players.length < record.state.settings.capacity) {
        const player = newPlayer(
          crypto.randomUUID(),
          DEMO_NAMES[players.length - 1],
          players.length,
          true,
        );
        players.push(player);
        hands[player.id] = [];
      }
      const nextState: State = {
        ...record.state,
        players,
        hands,
        revision: record.state.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const nextRecord: RoomRecord = { ...record, state: nextState };
      await this.persist(roomId, nextRecord);
      this.notify(roomId, nextState.revision);
      this.maybeScheduleDemo(nextRecord);
      return project(nextState, actor);
    });
  }

  /** Arms a single timer for this room only when an AI actually needs to act. */
  private maybeScheduleDemo(record: RoomRecord): void {
    if (!pendingDemoActor(record.state)) return;
    this.armDemoTimer(record.state.roomId, this.demoDelayMs);
  }

  private armDemoTimer(roomId: string, delay: number): void {
    if (this.timers.has(roomId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      void this.runDemoStep(roomId);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(roomId, timer);
  }

  private async runDemoStep(roomId: string): Promise<void> {
    try {
      await this.withRoom(roomId, async (record) => {
        const botId = pendingDemoActor(record.state);
        if (!botId) return;
        const command = demoCommand(record.state, botId);
        if (!command) return;
        const nextState = applyCommand(record.state, botId, command);
        const nextRecord: RoomRecord = {
          ...record,
          state: nextState,
          commandReceipts: {
            ...record.commandReceipts,
            [crypto.randomUUID()]: { actor: botId, body: JSON.stringify(command) },
          },
        };
        await this.persist(roomId, nextRecord);
        this.notify(roomId, nextState.revision);
        this.maybeScheduleDemo(nextRecord);
        this.maybeScheduleTrickAdvance(nextRecord);
      });
      this.demoBackoff.delete(roomId);
    } catch {
      // The room may have been removed, or the write may have failed (e.g.
      // a temporarily read-only volume). Back off instead of either
      // spinning tightly or stalling the room's AI turn forever; a human
      // command will still re-arm immediately if it succeeds first.
      const failures = (this.demoBackoff.get(roomId) ?? 0) + 1;
      this.demoBackoff.set(roomId, failures);
      const delay = Math.min(
        this.demoDelayMs * 2 ** failures,
        MAX_DEMO_BACKOFF_MS,
      );
      this.armDemoTimer(roomId, delay);
    }
  }

  /**
   * M10: once a trick resolves, any player can call advance_trick - but if
   * nobody does, the server itself moves the game on after a short pause so
   * a slow/idle player doesn't stall the whole table. Guarded by revision so
   * a human (or bot) who advances first wins; this timer becomes a no-op.
   */
  private maybeScheduleTrickAdvance(record: RoomRecord): void {
    if (record.state.phase !== "trick_result") return;
    const roomId = record.state.roomId;
    if (this.trickTimers.has(roomId)) return;
    const expectedRevision = record.state.revision;
    const timer = setTimeout(() => {
      this.trickTimers.delete(roomId);
      void this.autoAdvanceTrick(roomId, expectedRevision);
    }, this.trickAdvanceDelayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.trickTimers.set(roomId, timer);
  }

  private async autoAdvanceTrick(
    roomId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.withRoom(roomId, async (record) => {
      if (
        record.state.phase !== "trick_result" ||
        record.state.revision !== expectedRevision
      )
        return; // someone already advanced (or the room moved on) - nothing to do
      const actorId = record.state.turnPlayerId ?? record.state.hostId;
      const command = { type: "advance_trick" as const };
      const nextState = applyCommand(record.state, actorId, command);
      const nextRecord: RoomRecord = {
        ...record,
        state: nextState,
        commandReceipts: {
          ...record.commandReceipts,
          [crypto.randomUUID()]: { actor: actorId, body: JSON.stringify(command) },
        },
      };
      await this.persist(roomId, nextRecord);
      this.notify(roomId, nextState.revision);
      this.maybeScheduleDemo(nextRecord);
    }).catch(() => {
      // Room removed, or the write failed - a subsequent human/bot action
      // (or the next scheduled attempt) will move things along.
    });
  }
}
