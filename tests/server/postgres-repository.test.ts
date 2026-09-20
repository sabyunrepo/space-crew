import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { ApiError } from "../../shared/contracts.ts";
import { PostgresRepository } from "../../supabase/functions/_shared/postgres-repository.ts";
import type { DbPool, DbTx } from "../../supabase/functions/_shared/db.ts";

/** Wraps PGlite (a single, sequential connection) behind the same DbPool
 * contract the real postgres.js pool implements. Per AGENTS.md this stands in
 * for real concurrency: two "concurrent" commands below just run back to
 * back, which still exercises the receipt/revision-conflict logic that a real
 * concurrent request would hit under the room row lock. */
function makePool(db: PGlite): DbPool {
  return {
    async begin<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => fn({ query: async (text, params = []) => (await tx.query(text, params as unknown[])).rows as never }));
    },
    async query(text, params = []) {
      return (await db.query(text, params as unknown[])).rows as never;
    },
  };
}

async function setupDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema realtime;
    create table realtime.sent_log (id bigint generated always as identity primary key, topic text not null, payload jsonb not null, sent_at timestamptz not null default now());
    create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language sql as $$
      insert into realtime.sent_log(topic, payload) values (topic, payload)
    $$;`);
  const dir = "supabase/sbp";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(`${dir}/${file}`, "utf8"));
  return db;
}

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("PostgresRepository (PGlite)", () => {
  let db: PGlite;
  let repo: PostgresRepository;
  const host = uid(1);
  const guest = uid(2);
  const stranger = uid(3);

  beforeAll(async () => {
    db = await setupDb();
    // Real deployments connect as the "postgres" role for both the sbp SQL
    // that creates these tables (so it owns them, bypassing RLS) and the
    // Edge Function's own queries (SUPABASE_DB_URL) - mirror that here by
    // running everything as PGlite's default role rather than switching to
    // service_role, which owns nothing and would hit the RLS-default-deny.
    await db.exec(`insert into auth.users values ('${host}'),('${guest}'),('${stranger}')`);
    repo = new PostgresRepository(makePool(db), "test-project");
  });
  afterAll(async () => db.close());

  const settings = { name: "탐사대", capacity: 3 as const, missionMode: "sequential" as const, startMission: 1 };

  it("creates a room and is idempotent for a resent commandId", async () => {
    const input = { commandId: uid(100), nickname: "선장", settings };
    const first = await repo.create(host, input);
    expect(first.snapshot.phase).toBe("lobby");
    expect(first.snapshot.hostId).toBe(host);
    expect(first.inviteToken).toBeTruthy();

    const resend = await repo.create(host, input);
    expect(resend).toEqual(first);

    await expect(
      repo.create(host, { ...input, nickname: "다른이름" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("lets a stranger join by invite token, and rejoin returns the same seat", async () => {
    const { snapshot, inviteToken } = await repo.create(host, { commandId: uid(101), nickname: "선장", settings });
    const roomId = snapshot.roomId;
    const joined = await repo.join(guest, { commandId: uid(102), nickname: "대원", inviteToken: inviteToken! });
    expect(joined.snapshot.players).toHaveLength(2);
    expect(joined.inviteToken).toBeNull();

    const rejoined = await repo.join(guest, { commandId: uid(103), nickname: "대원", inviteToken: inviteToken! });
    expect(rejoined.snapshot.revision).toBe(joined.snapshot.revision);
    expect(rejoined.snapshot.players).toHaveLength(2);

    await expect(
      repo.join(stranger, { commandId: uid(104), nickname: "누구", inviteToken: "not-a-real-token-000000" }),
    ).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
    void roomId;
  });

  it("rejects snapshot/command access from non-members and unknown rooms", async () => {
    const { snapshot } = await repo.create(host, { commandId: uid(105), nickname: "선장", settings });
    await expect(repo.snapshot(stranger, snapshot.roomId)).rejects.toMatchObject({ code: "NOT_MEMBER", status: 403 });
    await expect(repo.snapshot(host, uid(999))).rejects.toMatchObject({ code: "ROOM_NOT_FOUND", status: 404 });
  });

  it("only the host can mint a new invite", async () => {
    const { snapshot, inviteToken } = await repo.create(host, { commandId: uid(106), nickname: "선장", settings });
    await repo.join(guest, { commandId: uid(107), nickname: "대원", inviteToken: inviteToken! });
    await expect(repo.invite(guest, snapshot.roomId, uid(108))).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const rotated = await repo.invite(host, snapshot.roomId, uid(109));
    expect(rotated.inviteToken).not.toBe(inviteToken);
    await expect(
      repo.join(stranger, { commandId: uid(110), nickname: "누구", inviteToken: inviteToken! }),
    ).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
    const joinedWithNew = await repo.join(stranger, { commandId: uid(111), nickname: "누구", inviteToken: rotated.inviteToken });
    expect(joinedWithNew.snapshot.players).toHaveLength(3);
  });

  it("runs commands, rejects stale revisions, and never doubles a resent command", async () => {
    const { snapshot: created, inviteToken } = await repo.create(host, { commandId: uid(112), nickname: "선장", settings });
    const roomId = created.roomId;
    await repo.join(guest, { commandId: uid(113), nickname: "대원1", inviteToken: inviteToken! });
    const third = await repo.join(stranger, { commandId: uid(114), nickname: "대원2", inviteToken: inviteToken! });

    let revision = third.snapshot.revision;
    for (const actor of [host, guest, stranger]) {
      const envelope = { commandId: uid(200 + revision), expectedRevision: revision, attemptId: null, command: { type: "set_ready" as const, ready: true } };
      const snap = await repo.command(actor, roomId, envelope);
      revision = snap.revision;
    }

    // start_mission moves everyone into "briefing" and deals hands. Keep the
    // exact envelope: a real resend retransmits the same expectedRevision it
    // originally sent, even after the server's revision has moved on.
    const startEnvelope = {
      commandId: uid(300), expectedRevision: revision, attemptId: null as string | null, command: { type: "start_mission" as const },
    };
    const started = await repo.command(host, roomId, startEnvelope);
    expect(started.phase).toBe("briefing");
    expect(started.me.hand.length).toBeGreaterThan(0);

    // A stale expectedRevision on a *new* commandId is rejected with the
    // current one attached (request_restart is not in the revision-bypass
    // set, unlike briefing_ready).
    await expect(
      repo.command(guest, roomId, { commandId: uid(301), expectedRevision: started.revision - 1, attemptId: started.attemptId, command: { type: "request_restart" } }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: started.revision });

    // Resending the exact same commandId+body never re-applies the effect.
    const resend = await repo.command(host, roomId, startEnvelope);
    expect(resend).toEqual(started);

    // A different command body under the same commandId is a conflict, not a silent overwrite.
    await expect(
      repo.command(host, roomId, { ...startEnvelope, command: { type: "briefing_ready" } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("never leaks another member's hand, and broadcasts a snapshot per member on every change", async () => {
    const { snapshot: created, inviteToken } = await repo.create(host, { commandId: uid(400), nickname: "선장", settings });
    const roomId = created.roomId;
    await repo.join(guest, { commandId: uid(401), nickname: "대원1", inviteToken: inviteToken! });
    const third = await repo.join(stranger, { commandId: uid(402), nickname: "대원2", inviteToken: inviteToken! });
    let revision = third.snapshot.revision;
    for (const actor of [host, guest, stranger]) {
      const snap = await repo.command(actor, roomId, {
        commandId: uid(500 + revision), expectedRevision: revision, attemptId: null, command: { type: "set_ready", ready: true },
      });
      revision = snap.revision;
    }
    const started = await repo.command(host, roomId, {
      commandId: uid(600), expectedRevision: revision, attemptId: null, command: { type: "start_mission" },
    });

    const hostView = await repo.snapshot(host, roomId);
    const guestView = await repo.snapshot(guest, roomId);
    expect(hostView.me.hand.length).toBeGreaterThan(0);
    expect(guestView.me.hand.length).toBeGreaterThan(0);
    expect(new Set(hostView.me.hand).size + new Set(guestView.me.hand).size).toBeGreaterThan(0);
    expect(hostView.me.hand.some((c) => guestView.me.hand.includes(c))).toBe(false);

    const sent = (await db.query<{ topic: string; payload: { roomId?: string } }>(
      `select topic, payload from realtime.sent_log where topic like $1`,
      [`sbp:test-project:%`],
    )).rows;
    const topicsForThisRoom = sent.filter((row) => row.payload.roomId === roomId);
    expect(topicsForThisRoom.length).toBeGreaterThanOrEqual(3);
    for (const member of [host, guest, stranger])
      expect(sent.some((row) => row.topic === `sbp:test-project:${member}`)).toBe(true);
    void started;
  });

  it("removes a member on leave, and the last member cannot leave", async () => {
    const { snapshot: created, inviteToken } = await repo.create(host, { commandId: uid(700), nickname: "선장", settings });
    const roomId = created.roomId;
    await repo.join(guest, { commandId: uid(701), nickname: "대원1", inviteToken: inviteToken! });
    await repo.leave(guest, roomId);
    const afterLeave = await repo.snapshot(host, roomId);
    expect(afterLeave.players).toHaveLength(1);
    await expect(repo.snapshot(guest, roomId)).rejects.toMatchObject({ code: "NOT_MEMBER" });
    await expect(repo.leave(host, roomId)).rejects.toMatchObject({ code: "LAST_MEMBER" });
  });
});

describe("postgres.js parameter typing", () => {
  it("casts every JSON-string parameter through text so postgres.js cannot double-encode it", async () => {
    // postgres.js serializes a parameter the server types as jsonb with
    // JSON.stringify, so a pre-stringified value becomes a jsonb *string*
    // (seen live: crew_game_states_state_check violation). PGlite does not
    // reproduce this, hence a source-level guard.
    const source = await readFile("supabase/functions/_shared/postgres-repository.ts", "utf8");
    expect(source.match(/\$\d+::jsonb/g) ?? []).toEqual([]);
    expect((source.match(/\$\d+::text::jsonb/g) ?? []).length).toBeGreaterThan(0);
  });
});
