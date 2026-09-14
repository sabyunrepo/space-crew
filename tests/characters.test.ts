import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterIdSchema, CreateRoomSchema, CommandSchema } from "../shared/contracts.ts";
import { CHARACTERS } from "../shared/characters.ts";
import { createState, newPlayer, applyCommand, project } from "../src/game/engine.ts";
import { arrangeSeats } from "../src/components/table/seatLayout.ts";
import { RoomStore } from "../server/rooms.ts";
const settings = { name: "캐릭터 탐사", capacity: 3 as const, missionMode: "sequential" as const, startMission: 1 };

test("all 15 identities validate and unknown identifiers cannot become image paths", () => {
  expect(CHARACTERS).toHaveLength(15);
  for (const c of CHARACTERS) expect(CharacterIdSchema.parse(c.id)).toBe(c.id);
  expect(CreateRoomSchema.safeParse({ commandId: crypto.randomUUID(), nickname: "대원", settings, characterId: "../../bad" }).success).toBe(false);
  expect(CommandSchema.safeParse({ type: "set_character", characterId: "unknown" }).success).toBe(false);
});

test.each([3, 4, 5])("%i seats preserve cyclic order for every viewer and shuffled input", (count) => {
  const players = Array.from({ length: count }, (_, seat) => newPlayer(crypto.randomUUID(), `대원${seat}`, seat));
  for (let viewer = 0; viewer < count; viewer++) {
    const layout = arrangeSeats([...players].reverse(), players[viewer].id);
    expect(layout[0].position).toBe("south");
    expect(layout.map((s) => s.player.seat)).toEqual(Array.from({ length: count }, (_, i) => (viewer + i) % count));
    expect(new Set(layout.map((s) => s.position)).size).toBe(count);
  }
});

test("character changes affect only actor, reset readiness, and stop after launch", () => {
  const host = crypto.randomUUID(); let state = createState(host, "선장", settings, "snow");
  const peer = newPlayer(crypto.randomUUID(), "동료", 1, false, "bay"); state.players.push(peer);
  state.players[0].ready = true;
  state = applyCommand(state, host, { type: "set_character", characterId: "tree" });
  expect(project(state, peer.id).players.map((p) => p.characterId)).toEqual(["tree", "bay"]);
  expect(state.players[0].ready).toBe(false);
  state.phase = "playing";
  expect(() => applyCommand(state, host, { type: "set_character", characterId: "pingu" })).toThrow();
});

test("server persists chosen identities across joining and a process restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "crew-character-"));
  let store = new RoomStore({ dataDir });
  try {
    const host = await store.createRoom({ commandId: crypto.randomUUID(), nickname: "선장", settings, characterId: "green-dino" });
    const peer = await store.joinRoom({ commandId: crypto.randomUUID(), nickname: "대원", inviteToken: host.inviteToken, characterId: "ilu" });
    const id = host.snapshot.roomId;
    expect(peer.snapshot.players.map((p) => p.characterId)).toEqual(["green-dino", "ilu"]);
    store.shutdown();
    store = new RoomStore({ dataDir });
    const restored = await store.snapshot(id, peer.playerToken);
    expect(restored.players.map((p) => p.characterId)).toEqual(["green-dino", "ilu"]);
    expect(restored.me.playerId).toBe(peer.snapshot.me.playerId);
  } finally { store.shutdown(); await rm(dataDir, { recursive: true, force: true }); }
});
