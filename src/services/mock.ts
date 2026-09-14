import {
  ApiError,
  CapabilitiesSchema,
  CreateRoomSchema,
  EnvelopeSchema,
  JoinRoomSchema,
  RULESET_VERSION,
  SnapshotSchema,
  type CreateRoom,
  type Envelope,
  type GameService,
  type JoinRoom,
  type Snapshot,
} from "../../shared/contracts.ts";
import missions from "../../shared/missions.json";
import {
  applyCommand,
  createState,
  fail,
  newPlayer,
  project,
  type State,
} from "../game/engine.ts";
import { pendingDemoActor, demoCommand } from "../game/demo.ts";
const PREFIX = "crew.demo.v1.";
type RecordState = {
  state: State;
  token: string;
  receipts: Record<string, { actor: string; body: string }>;
};
export class MockService implements GameService {
  readonly mode = "mock";
  readonly actor: string;
  constructor(private storage: Storage = localStorage) {
    this.actor = storage.getItem(PREFIX + "identity") || crypto.randomUUID();
    storage.setItem(PREFIX + "identity", this.actor);
  }
  private read(id: string): RecordState {
    const raw = this.storage.getItem(PREFIX + id);
    if (!raw)
      return fail(
        "ROOM_NOT_FOUND",
        "이 브라우저에 저장된 방을 찾을 수 없습니다. 로컬 데모 초대는 다른 기기로 연결되지 않습니다.",
        404,
      );
    return JSON.parse(raw);
  }
  private save(record: RecordState) {
    this.storage.setItem(PREFIX + record.state.roomId, JSON.stringify(record));
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(PREFIX);
      channel.postMessage({
        roomId: record.state.roomId,
        revision: record.state.revision,
      });
      channel.close();
    }
  }
  private async locked<T>(key: string, fn: () => T): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks)
      return navigator.locks.request(PREFIX + key, fn);
    return fn();
  }
  async capabilities() {
    return CapabilitiesSchema.parse({
      apiVersion: "1",
      backendReady: true,
      rulesetVersion: RULESET_VERSION,
      missions,
    });
  }
  async createRoom(raw: CreateRoom) {
    const input = CreateRoomSchema.parse(raw);
    return this.locked("create", () => {
      const key = PREFIX + "create." + input.commandId;
      const receipt = this.storage.getItem(key);
      if (receipt) {
        const saved = JSON.parse(receipt);
        if (saved.body !== JSON.stringify(input))
          throw new ApiError(
            "IDEMPOTENCY_CONFLICT",
            "같은 요청 번호에 다른 내용이 전달되었습니다.",
            409,
          );
        const record = this.read(saved.roomId);
        return {
          snapshot: project(record.state, this.actor),
          inviteToken: record.token,
        };
      }
      const record = {
        state: createState(this.actor, input.nickname, input.settings, input.characterId),
        token: crypto.randomUUID() + crypto.randomUUID(),
        receipts: {},
      };
      this.save(record);
      this.storage.setItem(
        key,
        JSON.stringify({
          body: JSON.stringify(input),
          roomId: record.state.roomId,
        }),
      );
      return {
        snapshot: project(record.state, this.actor),
        inviteToken: record.token,
      };
    });
  }
  async joinRoom(raw: JoinRoom) {
    const input = JoinRoomSchema.parse(raw);
    let found: RecordState | undefined;
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)!;
      if (
        !key.startsWith(PREFIX) ||
        !/^[0-9a-f-]{36}$/.test(key.slice(PREFIX.length))
      )
        continue;
      const candidate = JSON.parse(this.storage.getItem(key)!);
      if (candidate.token === input.inviteToken) {
        found = candidate;
        break;
      }
    }
    if (!found)
      return fail(
        "INVITE_NOT_FOUND",
        "초대 링크를 찾을 수 없습니다. 로컬 데모 링크는 같은 브라우저에서만 열립니다.",
        404,
      );
    return this.locked(found.state.roomId, () => {
      const record = this.read(found!.state.roomId);
      if (!record.state.players.some((p) => p.id === this.actor)) {
        if (
          record.state.phase !== "lobby" ||
          record.state.players.length >= record.state.settings.capacity
        )
          return fail("ROOM_FULL", "입장 가능한 좌석이 없습니다.");
        record.state.players.push(
          newPlayer(this.actor, input.nickname, record.state.players.length, false, input.characterId),
        );
        record.state.hands[this.actor] = [];
        record.state.revision++;
        this.save(record);
      }
      return { snapshot: project(record.state, this.actor), inviteToken: null };
    });
  }
  async snapshot(id: string) {
    return SnapshotSchema.parse(project(this.read(id).state, this.actor));
  }
  async command(id: string, raw: Envelope) {
    const input = EnvelopeSchema.parse(raw);
    return this.locked(id, () => this.execute(id, input, this.actor));
  }
  private execute(id: string, input: Envelope, actor: string) {
    const record = this.read(id);
    const body = JSON.stringify(input);
    const previous = record.receipts[input.commandId];
    if (previous) {
      if (previous.actor !== actor || previous.body !== body)
        return fail(
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 번호를 다른 행동에 사용할 수 없습니다.",
        );
      return project(record.state, this.actor);
    }
    if (record.state.revision !== input.expectedRevision)
      throw new ApiError(
        "REVISION_CONFLICT",
        "다른 대원의 행동이 먼저 반영되었습니다. 최신 상태에서 다시 선택해 주세요.",
        409,
        record.state.revision,
      );
    if (record.state.attemptId !== input.attemptId)
      return fail(
        "ATTEMPT_MISMATCH",
        "이전 시도의 행동입니다. 새 임무 상태를 확인해 주세요.",
      );
    record.state = applyCommand(record.state, actor, input.command);
    record.receipts[input.commandId] = { actor, body };
    this.save(record);
    return project(record.state, this.actor);
  }
  async invite(id: string) {
    const record = this.read(id);
    if (record.state.hostId !== this.actor)
      return fail("FORBIDDEN", "방장만 초대 링크를 발급할 수 있습니다.", 403);
    return record.token;
  }
  async fillDemoCrew(id: string) {
    return this.locked(id, () => {
      const record = this.read(id);
      if (record.state.hostId !== this.actor || record.state.phase !== "lobby")
        return fail(
          "FORBIDDEN",
          "대기실의 방장만 데모 대원을 추가할 수 있습니다.",
        );
      const names = ["루나", "코멧", "노바", "오리온"];
      while (record.state.players.length < record.state.settings.capacity) {
        const player = newPlayer(
          crypto.randomUUID(),
          names[record.state.players.length - 1],
          record.state.players.length,
          true,
        );
        record.state.players.push(player);
        record.state.hands[player.id] = [];
      }
      record.state.revision++;
      this.save(record);
      return project(record.state, this.actor);
    });
  }
  async demoStep(id: string) {
    return this.locked(id, () => {
      const { state } = this.read(id);
      const botId = pendingDemoActor(state);
      if (!botId) return project(state, this.actor);
      const command = demoCommand(state, botId);
      if (!command) return project(state, this.actor);
      return this.execute(
        id,
        {
          commandId: crypto.randomUUID(),
          attemptId: state.attemptId,
          expectedRevision: state.revision,
          command,
        },
        botId,
      );
    });
  }
  subscribe(
    id: string,
    onRevision: (revision: number) => void,
    onConnection: Parameters<GameService["subscribe"]>[2],
  ) {
    onConnection("connected");
    const channel = new BroadcastChannel(PREFIX);
    channel.onmessage = (event) => {
      if (event.data.roomId === id) onRevision(event.data.revision);
    };
    const listener = (event: StorageEvent) => {
      if (event.key === PREFIX + id && event.newValue)
        onRevision(JSON.parse(event.newValue).state.revision);
    };
    window.addEventListener("storage", listener);
    return () => {
      channel.close();
      window.removeEventListener("storage", listener);
    };
  }
}
