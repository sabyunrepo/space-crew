import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { it, expect } from "vitest";
it("applies the migration and restricts Realtime rows to members; private hands are inaccessible", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    await db.exec(
      await readFile(
        "supabase/migrations/20260909044625_crew_contract_v1.sql",
        "utf8",
      ),
    );
    const user = "10000000-0000-4000-8000-000000000001",
      stranger = "10000000-0000-4000-8000-000000000002",
      player = "20000000-0000-4000-8000-000000000001",
      room = "30000000-0000-4000-8000-000000000001";
    await db.exec(`insert into auth.users values ('${user}'),('${stranger}');
      set role crew_server;
      insert into crew_private.players(id,auth_user_id,nickname) values ('${player}','${user}','별빛');
      insert into crew_private.rooms(id,host_player_id,name,capacity,mission_mode,start_mission,ruleset_version) values ('${room}','${player}','테스트',3,'sequential',1,'test');
      insert into crew_private.game_states(room_id,state) values ('${room}','{"hands":{"secret":["rocket-4"]}}');
      insert into public.room_subscriptions values ('${room}','${user}');
      insert into public.room_versions values ('${room}',4);
      reset role; set role authenticated; set request.jwt.claim.sub='${user}';`);
    expect((await db.query("select * from public.room_versions")).rows).toEqual(
      [{ room_id: room, revision: 4 }],
    );
    await expect(
      db.query("select * from crew_private.game_states"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query("update public.room_versions set revision=99"),
    ).rejects.toThrow(/permission denied/);
    await db.exec(`set request.jwt.claim.sub='${stranger}';`);
    expect(
      (await db.query("select * from public.room_versions")).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("select * from public.room_subscriptions")).rows,
    ).toHaveLength(0);
    await db.exec("reset role; set role anon;");
    await expect(
      db.query("select * from public.room_versions"),
    ).rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role crew_server;");
    await expect(
      db.query(
        `insert into crew_private.room_members(room_id,player_id,seat) values ('${room}','${player}',5)`,
      ),
    ).rejects.toThrow(/check constraint/);
  } finally {
    await db.close();
  }
}, 30000);
