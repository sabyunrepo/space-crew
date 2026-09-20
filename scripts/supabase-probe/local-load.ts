/** Local load probe for the crew-api database layer (issue sabyunrepo/supabase-selfhost-platform#61).
 *
 * Runs the REAL PostgresRepository against a REAL Postgres through the REAL
 * vendored postgres.js - the same three pieces the deployed worker uses - so
 * driver-specific behaviour (jsonb double encoding, array parameters) is
 * exercised here instead of only in the PGlite harness, which has a different
 * driver. It reports per-command round trips and latency at several
 * concurrency levels, for one shared room (row-lock serialized) and for
 * separate rooms (pool-limited).
 *
 * Usage: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/postgres \
 *          npx tsx scripts/supabase-probe/local-load.ts [poolMax]
 */
import postgres from "./function/vendor/postgres.js";
import { PostgresRepository } from "../../supabase/functions/_shared/postgres-repository.ts";
import type { DbPool } from "../../supabase/functions/_shared/db.ts";
import type { Settings } from "../../shared/contracts.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const poolMax = Number(process.argv[2] ?? 3);
const projectId = "00000000-0000-4000-8000-000000000001";

const sql = postgres(url, { max: poolMax, prepare: false, idle_timeout: 20, connect_timeout: 5, ssl: false, max_lifetime: 300 });

/** Counts round trips the way the deployed pool would see them: every
 * tx.query plus the BEGIN and COMMIT postgres.js issues around the callback. */
let roundTrips = 0;
const pool: DbPool = {
  async begin(fn) {
    roundTrips += 2;
    return await sql.begin((tx) => fn({ query: (text, params = []) => { roundTrips++; return tx.unsafe(text, params); } }));
  },
  async query(text, params = []) {
    roundTrips++;
    return await sql.unsafe(text, params as never[]) as never;
  },
};
const repo = new PostgresRepository(pool, projectId);

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const settings: Settings = { name: "load", capacity: 5, missionMode: "sequential", startMission: 1 };
let commandSeq = 0;
const nextCommandId = () => uid(900000 + commandSeq++);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]);
}

/** Builds one room with `players` members and returns its id plus the members. */
async function makeRoom(seed: number, players: number) {
  const host = uid(seed);
  const members = [host];
  await sql`insert into auth.users (id) values (${host}) on conflict do nothing`;
  const { snapshot, inviteToken } = await repo.create(host, { commandId: nextCommandId(), nickname: `호스트${seed}`, settings });
  for (let i = 1; i < players; i++) {
    const guest = uid(seed + i);
    await sql`insert into auth.users (id) values (${guest}) on conflict do nothing`;
    await repo.join(guest, { commandId: nextCommandId(), nickname: `대원${i}`, inviteToken: inviteToken! });
    members.push(guest);
  }
  return { roomId: snapshot.roomId, members };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

async function main() {
  console.log(`pool max=${poolMax}`);

  // Round-trip cost of one snapshot and one broadcast-carrying command.
  const probe = await makeRoom(1000, 5);
  roundTrips = 0;
  await repo.snapshot(probe.members[0], probe.roomId);
  const snapshotTrips = roundTrips;
  roundTrips = 0;
  await sql`delete from realtime.sent_log`;
  await repo.leave(probe.members[4], probe.roomId);
  const leaveTrips = roundTrips;
  const sent = await sql`select count(*)::int as n from realtime.sent_log`;
  console.log(`round trips: snapshot=${snapshotTrips}  leave+broadcast(4 members)=${leaveTrips}  realtime rows sent=${sent[0].n}`);

  // Write path: every player of every room sends set_ready at the same moment,
  // the phase transition that lost 14% of its commands to 429 before the queue.
  console.log("\nset_ready storm - all players of all rooms at once");
  for (const roomCount of [1, 2, 4, 8]) {
    const rooms = await Promise.all(Array.from({ length: roomCount }, (_, i) => makeRoom(4000 + roomCount * 500 + i * 10, 5)));
    const revisions = new Map(await Promise.all(rooms.map(async (room) =>
      [room.roomId, (await repo.snapshot(room.members[0], room.roomId)).revision] as const)));
    const times: number[] = [];
    const [, wall] = await timed(async () => {
      await Promise.all(rooms.flatMap((room) => room.members.map(async (member) => {
        const [, ms] = await timed(() => repo.command(member, room.roomId, {
          commandId: nextCommandId(), expectedRevision: revisions.get(room.roomId)!, attemptId: null,
          command: { type: "set_ready", ready: true },
        }).catch(() => undefined));
        times.push(ms);
      })));
    });
    console.log(`  rooms ${String(roomCount).padStart(2)} (${roomCount * 5} commands)  p50 ${String(percentile(times, 50)).padStart(4)}ms ` +
      `p90 ${String(percentile(times, 90)).padStart(4)}ms  wall ${String(Math.round(wall)).padStart(5)}ms  ` +
      `${String(Math.round((roomCount * 5 * 1000) / wall)).padStart(5)} cmd/s`);
  }

  // Pool saturation: local Postgres answers in well under a millisecond, so
  // hold each transaction for the server time production actually measured
  // (38-70 ms at concurrency 1-4, #59) and see where the pool becomes the wall.
  console.log("\npool saturation - 40ms transactions, 32 at once");
  const holdTimes: number[] = [];
  const [, holdWall] = await timed(async () => {
    await Promise.all(Array.from({ length: 32 }, async () => {
      const [, ms] = await timed(() => pool.begin((tx) => tx.query("select pg_sleep(0.04)")));
      holdTimes.push(ms);
    }));
  });
  console.log(`  p50 ${percentile(holdTimes, 50)}ms  p90 ${percentile(holdTimes, 90)}ms  wall ${Math.round(holdWall)}ms  ` +
    `${Math.round((32 * 1000) / holdWall)} tx/s  (ideal with ${poolMax} connections: ${Math.round(poolMax / 0.04)} tx/s)`);

  await sql.end();
}

await main();
