import { describe, it, expect } from "vitest";
import { MockService } from "../src/services/mock.ts";
import {
  createHandler,
  PendingRepository,
} from "../supabase/functions/_shared/handler.ts";
import { SnapshotSchema } from "../shared/contracts.ts";
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}
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
describe("mock service persistence and command contract", () => {
  it("deduplicates create/action, rejects changed payload and stale revision, restores identity and state", async () => {
    const storage = new MemoryStorage();
    const service = new MockService(storage);
    const input = createInput();
    const entry = await service.createRoom(input);
    expect((await service.createRoom(input)).snapshot.roomId).toBe(
      entry.snapshot.roomId,
    );
    const command = {
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
      attemptId: null,
      command: { type: "set_ready" as const, ready: true },
    };
    const first = await service.command(entry.snapshot.roomId, command);
    const second = await service.command(entry.snapshot.roomId, command);
    expect(second.revision).toBe(first.revision);
    await expect(
      service.command(entry.snapshot.roomId, {
        ...command,
        command: { type: "set_ready", ready: false },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.command(entry.snapshot.roomId, {
        ...command,
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const restored = new MockService(storage);
    expect(restored.actor).toBe(service.actor);
    expect(await restored.snapshot(entry.snapshot.roomId)).toEqual(first);
    expect(SnapshotSchema.safeParse(first).success).toBe(true);
    expect(
      (
        await restored.joinRoom({
          commandId: crypto.randomUUID(),
          nickname: "다른 이름",
          inviteToken: entry.inviteToken!,
        })
      ).snapshot.me.playerId,
    ).toBe(first.me.playerId);
  });
  it("rejects a command from an earlier attempt even at current revision", async () => {
    const service = new MockService(new MemoryStorage());
    const { snapshot } = await service.createRoom(createInput());
    await expect(
      service.command(snapshot.roomId, {
        commandId: crypto.randomUUID(),
        expectedRevision: 0,
        attemptId: crypto.randomUUID(),
        command: { type: "set_ready", ready: true },
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_MISMATCH" });
  });
});
describe("Edge HTTP boundary", () => {
  const actor = crypto.randomUUID();
  const repo = new PendingRepository();
  const handler = createHandler({
    repository: repo,
    allowedOrigins: ["http://localhost:5173"],
    authenticate: async (token) => (token === "valid" ? actor : null),
  });
  const request = (
    path: string,
    body?: unknown,
    token = "valid",
    origin = "http://localhost:5173",
  ) =>
    new Request("http://api/functions/v1/crew-api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  it("authenticates before repository use and restricts origins", async () => {
    expect(
      (await handler(request("/capabilities", undefined, "bad"))).status,
    ).toBe(401);
    const response = await handler(
      request("/capabilities", undefined, "valid", "https://evil.example"),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("reports backend pending and never claims 50 missions playable", async () => {
    const response = await handler(request("/capabilities"));
    const data = await response.json();
    expect(data.backendReady).toBe(false);
    expect(data.missions).toHaveLength(50);
    expect(data.missions.every((m: { playable: boolean }) => !m.playable)).toBe(
      true,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("validates identity injection and surfaces explicit unimplemented repository", async () => {
    expect(
      (await handler(request("/rooms", { ...createInput(), playerId: actor })))
        .status,
    ).toBe(400);
    const response = await handler(request("/rooms", createInput()));
    expect(response.status).toBe(501);
    expect((await response.json()).error.code).toBe("BACKEND_NOT_IMPLEMENTED");
  });
  it("routes by the route query when the platform router only admits /functions/v1/<name>", async () => {
    const viaQuery = await handler(request("?route=" + encodeURIComponent("/capabilities")));
    expect(viaQuery.status).toBe(200);
    expect((await viaQuery.json()).missions).toHaveLength(50);
    const create = await handler(request("?route=" + encodeURIComponent("/rooms"), createInput()));
    expect(create.status).toBe(501);
  });
  it("supports preflight without requiring JWT", async () => {
    const response = await handler(
      new Request("http://api/crew-api/rooms", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
  });
});
