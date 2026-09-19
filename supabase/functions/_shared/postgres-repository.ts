import {
  ApiError,
  type CreateRoom,
  type Envelope,
  type JoinRoom,
  type Snapshot,
} from "../../../shared/contracts.ts";
import {
  applyCommand,
  createState,
  fail,
  newPlayer,
  removePlayer,
  project,
  REVISION_BYPASS_COMMANDS,
  type State,
} from "../../../src/game/engine.ts";
import type { CrewRepository } from "./handler.ts";
import type { DbPool, DbTx } from "./db.ts";

/** Implements the transaction contract in docs/API.ko.md ("서버 트랜잭션 구현
 * 계약") against a generic DbPool, so it runs unchanged against the real
 * postgres.js pool (crew-api/index.ts, crew-api/sbp-entry.ts) and against
 * PGlite in tests/server/postgres-repository.test.ts. Identity is the
 * Supabase auth uid itself - it IS the engine's playerId, so no separate
 * players/token-mapping table is needed. */

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** jsonb columns may come back already parsed (postgres.js) or as raw text
 * (some minimal drivers) - normalize either way instead of branching per driver. */
function asObject<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

type Row = Record<string, unknown>;

export class PostgresRepository implements CrewRepository {
  readonly ready = true;
  constructor(
    private pool: DbPool,
    private projectId: string,
  ) {}

  /** Serializes concurrent requests that share the same (actor, commandId)
   * before anything else - the only guard available for create(), where no
   * room row exists yet to lock. Cheap and harmless for the other methods. */
  private async lockCommand(tx: DbTx, actor: string, commandId: string): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`${actor}:${commandId}`]);
  }

  private async receipt(tx: DbTx, actor: string, commandId: string): Promise<{ request_hash: string; response: unknown } | undefined> {
    const rows = await tx.query<Row>(
      `select request_hash, response from crew_private.command_receipts where actor_user_id = $1::uuid and command_id = $2::uuid`,
      [actor, commandId],
    );
    return rows[0] as { request_hash: string; response: unknown } | undefined;
  }

  private async saveReceipt(
    tx: DbTx,
    actor: string,
    commandId: string,
    roomId: string | null,
    hash: string,
    revision: number | null,
    response: unknown,
  ): Promise<void> {
    await tx.query(
      `insert into crew_private.command_receipts
         (actor_user_id, command_id, room_id, request_hash, committed_revision, response)
       values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::bigint, $6::jsonb)`,
      [actor, commandId, roomId, hash, revision, JSON.stringify(response)],
    );
  }

  private async broadcast(tx: DbTx, state: State): Promise<void> {
    const members = [...state.players, ...(state.waitingPlayers ?? [])];
    for (const member of members) {
      const payload = JSON.stringify(project(state, member.id));
      const topic = `sbp:${this.projectId}:${member.id}`;
      await tx.query(`select realtime.send($1::jsonb, 'snapshot', $2::text, true)`, [payload, topic]);
    }
  }

  private async recordEvent(tx: DbTx, roomId: string, revision: number, actor: string, type: string, payload: unknown): Promise<void> {
    await tx.query(
      `insert into crew_private.events (room_id, revision, actor_user_id, command_type, payload)
       values ($1::uuid, $2::bigint, $3::uuid, $4::text, $5::jsonb)`,
      [roomId, revision, actor, type, JSON.stringify(payload ?? {})],
    );
  }

  /** Keeps crew_private.mission_attempts in sync whenever begin()/removePlayer()
   * inside applyCommand() starts a new attempt or closes the current one. An
   * attempt abandoned mid-mission (e.g. a full-approval restart vote) is
   * marked 'abandoned' rather than left dangling as 'active'. */
  private async syncMissionAttempt(tx: DbTx, roomId: string, prev: State, next: State): Promise<void> {
    if (next.attemptId && next.attemptId !== prev.attemptId) {
      if (prev.attemptId)
        await tx.query(
          `update crew_private.mission_attempts set status = 'abandoned', finished_at = now()
           where attempt_id = $1::uuid and status = 'active'`,
          [prev.attemptId],
        );
      await tx.query(
        `insert into crew_private.mission_attempts (attempt_id, room_id, mission_id, attempt_number, ruleset_version, status)
         values ($1::uuid, $2::uuid, $3::smallint, $4::integer, $5::text, 'active')`,
        [next.attemptId, roomId, next.missionId, next.attemptNumber, next.rulesetVersion],
      );
    }
    if (next.attemptId && ["success", "failure"].includes(next.phase) && next.phase !== prev.phase)
      await tx.query(
        `update crew_private.mission_attempts set status = $2::text, finished_at = now() where attempt_id = $1::uuid`,
        [next.attemptId, next.phase],
      );
  }

  private async requireRoom(tx: DbTx, roomId: string, forUpdate = false): Promise<void> {
    const rows = await tx.query<Row>(
      `select id from crew_private.rooms where id = $1::uuid${forUpdate ? " for update" : ""}`,
      [roomId],
    );
    if (!rows.length) fail("ROOM_NOT_FOUND", "존재하지 않는 방입니다.", 404);
  }

  private async requireMember(tx: DbTx, roomId: string, actor: string): Promise<void> {
    const rows = await tx.query<Row>(
      `select 1 from crew_private.room_members where room_id = $1::uuid and user_id = $2::uuid`,
      [roomId, actor],
    );
    if (!rows.length) fail("NOT_MEMBER", "이 방의 대원이 아닙니다.", 403);
  }

  async create(actorAuthId: string, input: CreateRoom) {
    return this.pool.begin(async (tx) => {
      await this.lockCommand(tx, actorAuthId, input.commandId);
      const hash = await sha256Hex(JSON.stringify(input));
      const existing = await this.receipt(tx, actorAuthId, input.commandId);
      if (existing) {
        if (existing.request_hash !== hash) fail("IDEMPOTENCY_CONFLICT", "같은 요청 번호에 다른 내용이 전달되었습니다.", 409);
        return asObject<{ snapshot: Snapshot; inviteToken: string }>(existing.response);
      }
      const state = createState(actorAuthId, input.nickname, input.settings, input.characterId);
      const inviteToken = randomToken();
      const inviteHash = await sha256Hex(inviteToken);
      await tx.query(
        `insert into crew_private.rooms
           (id, host_user_id, name, capacity, mission_mode, start_mission, phase, revision, ruleset_version, invite_token_hash)
         values ($1::uuid, $2::uuid, $3::text, $4::smallint, $5::text, $6::smallint, $7::text, $8::bigint, $9::text, $10::text)`,
        [
          state.roomId, actorAuthId, input.settings.name, input.settings.capacity, input.settings.missionMode,
          input.settings.startMission, state.phase, state.revision, state.rulesetVersion, inviteHash,
        ],
      );
      await tx.query(`insert into crew_private.room_members (room_id, user_id) values ($1::uuid, $2::uuid)`, [state.roomId, actorAuthId]);
      await tx.query(`insert into crew_private.game_states (room_id, state) values ($1::uuid, $2::jsonb)`, [state.roomId, JSON.stringify(state)]);
      const result = { snapshot: project(state, actorAuthId), inviteToken };
      await this.saveReceipt(tx, actorAuthId, input.commandId, state.roomId, hash, state.revision, result);
      return result;
    });
  }

  async join(actorAuthId: string, input: JoinRoom) {
    return this.pool.begin(async (tx) => {
      await this.lockCommand(tx, actorAuthId, input.commandId);
      const inviteHash = await sha256Hex(input.inviteToken);
      const [room] = await tx.query<Row>(`select id from crew_private.rooms where invite_token_hash = $1::text`, [inviteHash]);
      if (!room) fail("INVITE_NOT_FOUND", "초대 링크를 찾을 수 없습니다.", 404);
      const roomId = room.id as string;
      const hash = await sha256Hex(JSON.stringify({ roomId, input }));
      const existing = await this.receipt(tx, actorAuthId, input.commandId);
      if (existing) {
        if (existing.request_hash !== hash) fail("IDEMPOTENCY_CONFLICT", "같은 요청 번호에 다른 내용이 전달되었습니다.", 409);
        return asObject<{ snapshot: Snapshot; inviteToken: string | null }>(existing.response);
      }
      // Lock the room row before touching game_states, per the transaction contract.
      await tx.query(`select 1 from crew_private.rooms where id = $1::uuid for update`, [roomId]);
      const [row] = await tx.query<Row>(`select state from crew_private.game_states where room_id = $1::uuid`, [roomId]);
      const state = asObject<State>(row.state);
      const isMember = state.players.some((p) => p.id === actorAuthId) || (state.waitingPlayers ?? []).some((p) => p.id === actorAuthId);
      let result: { snapshot: Snapshot; inviteToken: string | null };
      let committedRevision = state.revision;
      if (isMember) {
        result = { snapshot: project(state, actorAuthId), inviteToken: null };
      } else {
        const occupied = state.players.length + (state.waitingPlayers ?? []).length;
        if (occupied >= state.settings.capacity) fail("ROOM_FULL", "입장 가능한 좌석이 없습니다.");
        const player = newPlayer(actorAuthId, input.nickname, occupied, false, input.characterId);
        const nextState: State = {
          ...state,
          players: state.phase === "lobby" ? [...state.players, player] : state.players,
          waitingPlayers: state.phase === "lobby" ? (state.waitingPlayers ?? []) : [...(state.waitingPlayers ?? []), player],
          waitingPolicy: state.phase === "lobby" ? null : "prompt",
          hands: { ...state.hands, [actorAuthId]: [] },
          revision: state.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        await tx.query(`insert into crew_private.room_members (room_id, user_id) values ($1::uuid, $2::uuid)`, [roomId, actorAuthId]);
        await tx.query(`update crew_private.rooms set revision = $2::bigint, phase = $3::text, updated_at = now() where id = $1::uuid`, [
          roomId, nextState.revision, nextState.phase,
        ]);
        await tx.query(`update crew_private.game_states set state = $2::jsonb, updated_at = now() where room_id = $1::uuid`, [
          roomId, JSON.stringify(nextState),
        ]);
        await this.recordEvent(tx, roomId, nextState.revision, actorAuthId, "join", {});
        await this.broadcast(tx, nextState);
        committedRevision = nextState.revision;
        result = { snapshot: project(nextState, actorAuthId), inviteToken: null };
      }
      await this.saveReceipt(tx, actorAuthId, input.commandId, roomId, hash, committedRevision, result);
      return result;
    });
  }

  async snapshot(actorAuthId: string, roomId: string): Promise<Snapshot> {
    return this.pool.begin(async (tx) => {
      await this.requireRoom(tx, roomId);
      await this.requireMember(tx, roomId, actorAuthId);
      const [row] = await tx.query<Row>(`select state from crew_private.game_states where room_id = $1::uuid`, [roomId]);
      return project(asObject<State>(row.state), actorAuthId);
    });
  }

  async command(actorAuthId: string, roomId: string, input: Envelope): Promise<Snapshot> {
    return this.pool.begin(async (tx) => {
      await this.lockCommand(tx, actorAuthId, input.commandId);
      await this.requireRoom(tx, roomId);
      await this.requireMember(tx, roomId, actorAuthId);
      // Lock the room row before checking the receipt / touching game_states.
      await tx.query(`select 1 from crew_private.rooms where id = $1::uuid for update`, [roomId]);
      const hash = await sha256Hex(JSON.stringify({ roomId, input }));
      const existing = await this.receipt(tx, actorAuthId, input.commandId);
      if (existing) {
        if (existing.request_hash !== hash) fail("IDEMPOTENCY_CONFLICT", "같은 요청 번호를 다른 행동에 사용할 수 없습니다.");
        return asObject<Snapshot>(existing.response);
      }
      const [row] = await tx.query<Row>(`select state from crew_private.game_states where room_id = $1::uuid`, [roomId]);
      const state = asObject<State>(row.state);
      const bypass = REVISION_BYPASS_COMMANDS.has(input.command.type);
      if (!bypass && state.revision !== input.expectedRevision)
        throw new ApiError("REVISION_CONFLICT", "다른 대원의 행동이 먼저 반영되었습니다. 최신 상태에서 다시 선택해 주세요.", 409, state.revision);
      if (state.attemptId !== input.attemptId) fail("ATTEMPT_MISMATCH", "이전 시도의 행동입니다. 새 임무 상태를 확인해 주세요.");
      const nextState = applyCommand(state, actorAuthId, input.command);
      await tx.query(
        `update crew_private.rooms set revision = $2::bigint, phase = $3::text, attempt_id = $4::uuid, updated_at = now() where id = $1::uuid`,
        [roomId, nextState.revision, nextState.phase, nextState.attemptId],
      );
      await tx.query(`update crew_private.game_states set state = $2::jsonb, updated_at = now() where room_id = $1::uuid`, [
        roomId, JSON.stringify(nextState),
      ]);
      await this.syncMissionAttempt(tx, roomId, state, nextState);
      const response = project(nextState, actorAuthId);
      await this.saveReceipt(tx, actorAuthId, input.commandId, roomId, hash, nextState.revision, response);
      await this.recordEvent(tx, roomId, nextState.revision, actorAuthId, input.command.type, input.command);
      await this.broadcast(tx, nextState);
      return response;
    });
  }

  async invite(actorAuthId: string, roomId: string, commandId: string): Promise<{ inviteToken: string }> {
    return this.pool.begin(async (tx) => {
      await this.lockCommand(tx, actorAuthId, commandId);
      const [room] = await tx.query<Row>(`select host_user_id from crew_private.rooms where id = $1::uuid for update`, [roomId]);
      if (!room) fail("ROOM_NOT_FOUND", "존재하지 않는 방입니다.", 404);
      if (room.host_user_id !== actorAuthId) fail("FORBIDDEN", "방장만 초대 링크를 발급할 수 있습니다.", 403);
      const hash = await sha256Hex(JSON.stringify({ roomId, commandId }));
      const existing = await this.receipt(tx, actorAuthId, commandId);
      if (existing) {
        if (existing.request_hash !== hash) fail("IDEMPOTENCY_CONFLICT", "같은 요청 번호에 다른 내용이 전달되었습니다.", 409);
        return asObject<{ inviteToken: string }>(existing.response);
      }
      const inviteToken = randomToken();
      const inviteHash = await sha256Hex(inviteToken);
      await tx.query(`update crew_private.rooms set invite_token_hash = $2::text, updated_at = now() where id = $1::uuid`, [roomId, inviteHash]);
      const result = { inviteToken };
      await this.saveReceipt(tx, actorAuthId, commandId, roomId, hash, null, result);
      return result;
    });
  }

  async leave(actorAuthId: string, roomId: string): Promise<void> {
    await this.pool.begin(async (tx) => {
      await this.requireRoom(tx, roomId, true);
      await this.requireMember(tx, roomId, actorAuthId);
      const [row] = await tx.query<Row>(`select state from crew_private.game_states where room_id = $1::uuid`, [roomId]);
      const state = asObject<State>(row.state);
      const nextState = removePlayer(state, actorAuthId);
      await tx.query(`delete from crew_private.room_members where room_id = $1::uuid and user_id = $2::uuid`, [roomId, actorAuthId]);
      await tx.query(
        `update crew_private.rooms set revision = $2::bigint, phase = $3::text, attempt_id = $4::uuid, host_user_id = $5::uuid, updated_at = now() where id = $1::uuid`,
        [roomId, nextState.revision, nextState.phase, nextState.attemptId, nextState.hostId],
      );
      await tx.query(`update crew_private.game_states set state = $2::jsonb, updated_at = now() where room_id = $1::uuid`, [
        roomId, JSON.stringify(nextState),
      ]);
      await this.syncMissionAttempt(tx, roomId, state, nextState);
      await this.recordEvent(tx, roomId, nextState.revision, actorAuthId, "leave", {});
      await this.broadcast(tx, nextState);
    });
  }
}
