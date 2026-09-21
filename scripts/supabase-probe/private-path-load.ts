/** Private-path probe: how fast is the REAL PostgresRepository when a long-lived
 * Node process talks to the project's Postgres over the KT Cloud private network
 * instead of going through the Edge Function (see
 * claudedocs/COOLIFY-ARCHITECTURE-PLAN.ko.md, stage 1).
 *
 * Bundle with esbuild and run on the Coolify VM:
 *   DATABASE_URL=postgres://... node private-path-load.mjs [poolMax] [prepare:0|1]
 * It creates rooms and auth.users rows with 1xxxxxxx-... ids; run it only
 * against a disposable project. */
import postgres from "./function/vendor/postgres.js";
import { PostgresRepository } from "../../supabase/functions/_shared/postgres-repository.ts";
import type { DbPool } from "../../supabase/functions/_shared/db.ts";
import type { Settings } from "../../shared/contracts.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const poolMax = Number(process.argv[2] ?? 8);
const prepare = process.argv[3] === "1";
const projectId = "00000000-0000-4000-8000-000000000001";
const run = Date.now() % 100000;

const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};
const fmt = (values: number[]) =>
  `p50 ${pct(values, 50).toFixed(1)}ms  p90 ${pct(values, 90).toFixed(1)}ms  p99 ${pct(values, 99).toFixed(1)}ms  max ${Math.max(...values).toFixed(1)}ms`;
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

// 1. Cold connection: what the Edge Function paid on every fresh worker.
const cold: number[] = [];
for (let i = 0; i < 15; i++) {
  const one = postgres(url, { max: 1, prepare: false, ssl: false, connect_timeout: 5 });
  const [, ms] = await timed(() => one`select 1`);
  cold.push(ms);
  await one.end();
}
console.log(`cold connect + select 1 (15x)      ${fmt(cold)}`);

const sql = postgres(url, { max: poolMax, prepare, idle_timeout: 20, connect_timeout: 5, ssl: false, max_lifetime: 300 });
const pool: DbPool = {
  begin: (fn) => sql.begin((tx) => fn({ query: (text, params = []) => tx.unsafe(text, params as never[], { prepare }) })) as never,
  query: (text, params = []) => sql.unsafe(text, params as never[], { prepare }) as never,
};
const repo = new PostgresRepository(pool, projectId);

// 2. Warm round trip: the floor for every statement.
await sql`select 1`;
const warm: number[] = [];
for (let i = 0; i < 300; i++) warm.push((await timed(() => sql`select 1`))[1]);
console.log(`warm select 1 (300x)               ${fmt(warm)}`);

const uid = (n: number) => `1${String(run).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const settings: Settings = { name: "private-path", capacity: 5, missionMode: "sequential", startMission: 1 };
let seq = 0;
const nextCommandId = () => uid(900000 + seq++);

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

// 3. Snapshot: the call every client repeats every 4 s.
const probe = await makeRoom(1000, 5);
const snaps: number[] = [];
for (let i = 0; i < 100; i++) snaps.push((await timed(() => repo.snapshot(probe.members[i % 5], probe.roomId)))[1]);
console.log(`snapshot, sequential (100x)        ${fmt(snaps)}`);

// 4. One command at a time: lock + receipt + engine + save + broadcast + commit.
const solo = await makeRoom(2000, 5);
const single: number[] = [];
let rev = (await repo.snapshot(solo.members[0], solo.roomId)).revision;
for (let i = 0; i < 40; i++) {
  const [snap, ms] = await timed(() => repo.command(solo.members[i % 5], solo.roomId, {
    commandId: nextCommandId(), expectedRevision: rev, attemptId: null,
    command: { type: "set_ready", ready: i % 10 < 5 },
  }));
  rev = snap.revision;
  single.push(ms);
}
console.log(`command, sequential (40x)          ${fmt(single)}`);

// 5. Storm: every player of every room at the same instant.
for (const roomCount of [1, 2, 4, 8]) {
  const rooms = await Promise.all(Array.from({ length: roomCount }, (_, i) => makeRoom(4000 + roomCount * 500 + i * 10, 5)));
  const revisions = new Map(await Promise.all(rooms.map(async (room) =>
    [room.roomId, (await repo.snapshot(room.members[0], room.roomId)).revision] as const)));
  const times: number[] = [];
  let failed = 0;
  const [, wall] = await timed(() => Promise.all(rooms.flatMap((room) => room.members.map(async (member) => {
    const [, ms] = await timed(() => repo.command(member, room.roomId, {
      commandId: nextCommandId(), expectedRevision: revisions.get(room.roomId)!, attemptId: null,
      command: { type: "set_ready", ready: true },
    }).catch(() => { failed++; }));
    times.push(ms);
  }))));
  console.log(`storm rooms ${String(roomCount).padStart(2)} (${String(roomCount * 5).padStart(2)} cmds at once)   ${fmt(times)}  wall ${Math.round(wall)}ms  rejected ${failed}`);
}
console.log(`pool max=${poolMax} prepare=${prepare}`);
await sql.end();
