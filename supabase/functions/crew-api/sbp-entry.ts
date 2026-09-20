// Entry point for the self-hosted (sbp) platform deploy. Bundled by
// scripts/build-crew-api.mjs into dist-edge/crew-api/index.ts - never run
// directly and never deployed as source (npm:/jsr:/https: imports and a
// deno.json import map are both forbidden on that platform, see
// claudedocs/SUPABASE-BPRIME-PROBE.ko.md). __CREW_PROJECT_ID__ is replaced by
// esbuild `define` at build time: the project UUID is not on the platform's
// runtime env allowlist, so it cannot be read from Deno.env here.
import postgres from "postgres";
import { createHandler } from "../_shared/handler.ts";
import { PostgresRepository } from "../_shared/postgres-repository.ts";
import { decodeJwtSub } from "../_shared/jwt.ts";
import { RULESET_VERSION } from "../_shared/contracts.ts";
import missions from "../_shared/missions.ts";
import type { DbPool } from "../_shared/db.ts";

declare const __CREW_PROJECT_ID__: string;
const projectId = __CREW_PROJECT_ID__;
if (!projectId) throw new Error("CREW_PROJECT_ID was not injected at build time");

const dbUrl = Deno.env.get("SUPABASE_DB_URL");
if (!dbUrl) throw new Error("SUPABASE_DB_URL required");

// Worker reuse: this module-level pool is created lazily once per isolate and
// reused across every request that isolate handles (never sql.end()ed after a
// request). A connection error drops the reference so the next request builds
// a fresh pool. Must also work correctly when the platform still creates a
// fresh worker per request (forceCreate:true) - see the probe report.
// max is the whole project's database concurrency, because worker reuse means
// there is exactly one worker for this one function. At 3 it was narrower than
// the router's 16-request admission: 32 transactions of 40 ms queued to p90
// 453 ms, against 170 ms at 8 (scripts/supabase-probe/local-load.ts). 8 keeps
// a modest share of the shared Postgres, which every other service also uses.
let sql: ReturnType<typeof postgres> | null = null;
function getSql() {
  if (!sql)
    sql = postgres(dbUrl!, { max: 8, prepare: false, idle_timeout: 20, connect_timeout: 5, ssl: false, max_lifetime: 300 });
  return sql;
}
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "CONNECT_TIMEOUT" || code === "ECONNRESET";
}
const pool: DbPool = {
  async begin(fn) {
    try {
      return await getSql().begin((tx) => fn({ query: (text, params = []) => tx.unsafe(text, params) }));
    } catch (e) {
      if (isConnectionError(e)) sql = null;
      throw e;
    }
  },
  async query(text, params = []) {
    try {
      return await getSql().unsafe(text, params as never[]) as never;
    } catch (e) {
      if (isConnectionError(e)) sql = null;
      throw e;
    }
  },
};

Deno.serve(
  createHandler({
    repository: new PostgresRepository(pool, projectId),
    // The sbp runtime only forwards APP_* secrets (sbp secrets set) to workers.
    allowedOrigins: (Deno.env.get("APP_CREW_ALLOWED_ORIGINS") ?? Deno.env.get("CREW_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    authenticate: (token) => Promise.resolve(decodeJwtSub(token)),
    playableMissionIds: missions.filter((m) => m.playable).map((m) => m.id),
    rulesetVersion: RULESET_VERSION,
  }),
);
