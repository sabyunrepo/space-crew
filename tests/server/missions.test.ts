import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/rooms.ts";
import { SnapshotSchema, type Command, type Snapshot } from "../../shared/contracts.ts";
import { suggestDemoCommand } from "../../src/game/demo.ts";

/** Exercise the real authoritative store, player authentication, public
 * projections and disk restart across every mission, using separate tokens. */
describe.each([3, 4, 5] as const)("%i-player mission integration", (capacity) => {
  it.each(Array.from({ length: 50 }, (_, i) => i + 1))(
    "mission %i survives preparation/playing restart and reaches a valid result",
    async (mission) => {
      const dataDir = await mkdtemp(join(tmpdir(), "crew-mission-matrix-"));
      let store = new RoomStore({ dataDir, trickAdvanceDelayMs: 60_000 });
      try {
        const host = await store.createRoom({
          commandId: crypto.randomUUID(), nickname: "선장",
          settings: { name: "전체 미션 검증", capacity, missionMode: "sequential", startMission: mission },
        });
        const roomId = host.snapshot.roomId;
        const tokens = new Map([[host.snapshot.me.playerId, host.playerToken]]);
        for (let i = 1; i < capacity; i++) {
          const joined = await store.joinRoom({ commandId: crypto.randomUUID(), nickname: `대원${i}`, inviteToken: host.inviteToken });
          tokens.set(joined.snapshot.me.playerId, joined.playerToken);
        }
        let snap: Snapshot = await store.snapshot(roomId, host.playerToken);
        async function execute(token: string, command: Command) {
          if (command.type === "confirm_tokens" && [23, 40].includes(mission)) command = { ...command, firstTaskId: snap.tasks[0].id, secondTaskId: snap.tasks[mission === 23 ? 1 : 3].id };
          const envelope = { commandId: crypto.randomUUID(), expectedRevision: snap.revision, attemptId: snap.attemptId, command };
          const next = await store.command(roomId, token, envelope);
          expect(SnapshotSchema.safeParse(next).success).toBe(true);
          expect(next.revision).toBe(snap.revision + 1);
          // A lost response/retry must never apply the same effect twice.
          const duplicate = await store.command(roomId, token, envelope);
          expect(duplicate).toEqual(next);
          snap = next;
        }
        for (const token of tokens.values()) await execute(token, { type: "set_ready", ready: true });
        await execute(host.playerToken, { type: "start_mission" });
        expect(snap.missionId).toBe(mission);
        const attemptId = snap.attemptId;
        const restoredPhases = new Set<string>();
        let commands = 0;
        while (!["success", "failure"].includes(snap.phase) && commands++ < 220) {
          const phaseKey = snap.phase === "preparation" ? `preparation:${snap.preparation?.stage}:${Math.min(snap.preparation?.answeredPlayerIds.length ?? 0, 1)}` : snap.phase;
          if (!restoredPhases.has(phaseKey)) {
            // Restore after a real action in each preparation stage too. A
            // stage with several answers exercises partially completed input.
            const before = await Promise.all([...tokens.values()].map((t) => store.snapshot(roomId, t)));
            store.shutdown();
            store = new RoomStore({ dataDir, trickAdvanceDelayMs: 60_000 });
            const after = await Promise.all([...tokens.values()].map((t) => store.snapshot(roomId, t)));
            expect(after).toEqual(before);
            restoredPhases.add(phaseKey);
          }
          if (snap.phase === "trick_result") {
            await execute(host.playerToken, { type: "advance_trick" });
            continue;
          }
          let acted = false;
          for (const [playerId, token] of tokens) {
            const view = await store.snapshot(roomId, token);
            expect(view.me.playerId).toBe(playerId);
            expect(view).not.toHaveProperty("hands");
            expect(JSON.stringify(view).match(/"hand":/g)).toHaveLength(1);
            expect(view.attemptId).toBe(attemptId);
            const command = suggestDemoCommand(view);
            if (command) { await execute(token, command); acted = true; break; }
          }
          expect(acted, `mission ${mission}: stuck at ${phaseKey}`).toBe(true);
        }
        expect(commands).toBeLessThan(220);
        expect(["success", "failure"]).toContain(snap.phase);
        expect(snap.resultReason).toBeTruthy();
        const peers = await Promise.all([...tokens.values()].map((t) => store.snapshot(roomId, t)));
        expect(new Set(peers.map((p) => p.phase)).size).toBe(1);
        expect(new Set(peers.map((p) => p.resultReason)).size).toBe(1);
        if (snap.phase === "failure") {
          await execute(host.playerToken, { type: "retry_mission" });
          expect(snap.missionId).toBe(mission);
          expect(snap.attemptId).not.toBe(attemptId);
        }
      } finally { store.shutdown(); await rm(dataDir, { recursive: true, force: true }); }
    },
  );
});


it("restart voting persists, rejects duplicate effects, and preserves the room identity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "crew-vote-"));
  let store = new RoomStore({ dataDir });
  try {
    const host = await store.createRoom({ commandId: crypto.randomUUID(), nickname: "선장", settings: { name: "재시작", capacity: 3, missionMode: "random", startMission: 1 } });
    const peers = [host];
    for (let i=1;i<3;i++) peers.push(await store.joinRoom({ commandId: crypto.randomUUID(), nickname: `대원${i}`, inviteToken: host.inviteToken }) as typeof host);
    const roomId=host.snapshot.roomId;
    let snap=peers.at(-1)!.snapshot;
    const command = async (index: number, action: Command) => {
      const envelope={ commandId:crypto.randomUUID(), expectedRevision:snap.revision, attemptId:snap.attemptId, command:action };
      snap=await store.command(roomId,peers[index].playerToken,envelope);
      const duplicate=await store.command(roomId,peers[index].playerToken,envelope);
      expect(duplicate).toEqual(snap);
    };
    for(let i=0;i<3;i++) await command(i,{type:"set_ready",ready:true});
    await command(0,{type:"start_mission"});
    const mission=snap.missionId, attempt=snap.attemptId;
    await command(1,{type:"request_restart"});
    await command(0,{type:"vote_restart",agree:true});
    store.shutdown(); store=new RoomStore({dataDir});
    snap=await store.snapshot(roomId,host.playerToken);
    expect(snap.restartVote?.approvals).toHaveLength(2);
    expect(snap.attemptId).toBe(attempt);
    await command(2,{type:"vote_restart",agree:true});
    expect(snap.restartVote).toBeNull();
    expect(snap.missionId).toBe(mission);
    expect(snap.attemptId).not.toBe(attempt);
    expect(snap.attemptNumber).toBe(2);
    expect(snap.roomId).toBe(roomId);
    expect(await store.invite(roomId,host.playerToken)).toBe(host.inviteToken);
  } finally {store.shutdown(); await rm(dataDir,{recursive:true,force:true});}
});
