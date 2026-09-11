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
import {
  listRoomIds,
  pruneStaleRoomFiles,
  readRoomFile,
  writeRoomFile,
} from "./persist.ts";

const DEMO_NAMES = ["루나", "코멧", "노바", "오리온"];
const DEFAULT_DEMO_DELAY_MS = 700;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Ports mock.ts's demoStep bot-detection: who (if anyone) must act next. */
function pendingDemoActor(state: State): string | null {
  if (state.phase === "briefing")
    return state.players.find((p) => p.isDemo && !p.briefingReady)?.id ?? null;
  if (state.phase === "task_selection" || state.phase === "playing")
    return (
      state.players.find((p) => p.isDemo && p.id === state.turnPlayerId)
        ?.id ?? null
    );
  return null;
}

function demoCommand(state: State, botId: string) {
  if (state.phase === "briefing") return { type: "briefing_ready" as const };
  if (state.phase === "task_selection") {
    const task = state.tasks.find((t) => !t.ownerId);
    return task ? { type: "choose_task" as const, taskId: task.id } : null;
  }
  if (state.phase === "playing") {
    const cardId = project(state, botId).me.legalCardIds[0];
    return cardId ? { type: "play_card" as const, cardId } : null;
  }
  return null;
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
  private queues = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private createReceipts = new Map<
    string,
    { body: string; result: CreateResult }
  >();
  private joinReceipts = new Map<string, { body: string; result: JoinResult }>();
  private revisionListeners: ((roomId: string, revision: number) => void)[] =
    [];

  constructor(options: { dataDir: string; demoDelayMs?: number }) {
    this.dataDir = options.dataDir;
    this.demoDelayMs = options.demoDelayMs ?? DEFAULT_DEMO_DELAY_MS;
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

  /** Clears pending AI timers. Call when shutting a process/test down. */
  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async loadRoom(roomId: string): Promise<RoomRecord> {
    const cached = this.rooms.get(roomId);
    if (cached) return cached;
    const loaded = await readRoomFile<RoomRecord>(this.dataDir, roomId);
    if (!loaded) fail("ROOM_NOT_FOUND", "존재하지 않는 방입니다.", 404);
    this.rooms.set(roomId, loaded);
    return loaded;
  }

  private async persist(record: RoomRecord): Promise<void> {
    this.rooms.set(record.state.roomId, record);
    await writeRoomFile(this.dataDir, record.state.roomId, record);
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
    const prior = this.queues.get(roomId) ?? Promise.resolve();
    const run = prior.then(
      async () => fn(await this.loadRoom(roomId)),
      async () => fn(await this.loadRoom(roomId)),
    );
    this.queues.set(
      roomId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private resolveActor(record: RoomRecord, token: string): string {
    const playerId = record.tokens[hashToken(token)];
    if (!playerId) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
    return playerId;
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
    const playerId = crypto.randomUUID();
    const { token, hash } = issueToken();
    const state = createState(playerId, input.nickname, input.settings);
    const record: RoomRecord = {
      state,
      tokens: { [hash]: playerId },
      inviteToken: issueInviteToken(),
      commandReceipts: {},
    };
    await this.persist(record);
    const result: CreateResult = {
      snapshot: project(state, playerId),
      inviteToken: record.inviteToken,
      playerToken: token,
    };
    this.createReceipts.set(input.commandId, { body, result });
    return result;
  }

  private async findRoomIdByInvite(inviteToken: string): Promise<string | null> {
    for (const id of await listRoomIds(this.dataDir)) {
      const record = await this.loadRoom(id).catch(() => null);
      if (record && record.inviteToken === inviteToken) return id;
    }
    return null;
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
      record.state.players.push(
        newPlayer(playerId, input.nickname, record.state.players.length),
      );
      record.state.hands[playerId] = [];
      record.state.revision += 1;
      record.state.updatedAt = new Date().toISOString();
      record.tokens[hash] = playerId;
      await this.persist(record);
      this.notify(roomId, record.state.revision);
      return { snapshot: project(record.state, playerId), playerToken: token };
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
      if (record.state.revision !== input.expectedRevision)
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
      record.state = applyCommand(record.state, actor, input.command);
      record.commandReceipts[input.commandId] = { actor, body };
      await this.persist(record);
      this.notify(roomId, record.state.revision);
      this.maybeScheduleDemo(record);
      return project(record.state, actor);
    });
  }

  async fillDemoCrew(roomId: string, token: string): Promise<Snapshot> {
    return this.withRoom(roomId, async (record) => {
      const actor = this.resolveActor(record, token);
      if (record.state.hostId !== actor || record.state.phase !== "lobby")
        fail("FORBIDDEN", "대기실의 방장만 데모 대원을 추가할 수 있습니다.");
      while (record.state.players.length < record.state.settings.capacity) {
        const player = newPlayer(
          crypto.randomUUID(),
          DEMO_NAMES[record.state.players.length - 1],
          record.state.players.length,
          true,
        );
        record.state.players.push(player);
        record.state.hands[player.id] = [];
      }
      record.state.revision += 1;
      record.state.updatedAt = new Date().toISOString();
      await this.persist(record);
      this.notify(roomId, record.state.revision);
      this.maybeScheduleDemo(record);
      return project(record.state, actor);
    });
  }

  /** Arms a single timer for this room only when an AI actually needs to act. */
  private maybeScheduleDemo(record: RoomRecord): void {
    if (!pendingDemoActor(record.state)) return;
    const roomId = record.state.roomId;
    if (this.timers.has(roomId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      void this.runDemoStep(roomId);
    }, this.demoDelayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(roomId, timer);
  }

  private async runDemoStep(roomId: string): Promise<void> {
    await this.withRoom(roomId, async (record) => {
      const botId = pendingDemoActor(record.state);
      if (!botId) return;
      const command = demoCommand(record.state, botId);
      if (!command) return;
      record.state = applyCommand(record.state, botId, command);
      record.commandReceipts[crypto.randomUUID()] = {
        actor: botId,
        body: JSON.stringify(command),
      };
      await this.persist(record);
      this.notify(roomId, record.state.revision);
      this.maybeScheduleDemo(record);
    }).catch(() => {
      // The room may have been removed between scheduling and firing; a
      // human command will re-arm the timer if the room still exists.
    });
  }
}
