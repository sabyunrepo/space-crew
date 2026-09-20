// Deno entrypoint for the standard Supabase CLI (`supabase functions serve` /
// `supabase functions deploy`). The self-hosted sbp platform instead deploys
// the esbuild bundle produced from sbp-entry.ts by scripts/build-crew-api.mjs
// (no npm:/deno.json import map allowed there) - see docs/FRONTEND-HANDOFF.ko.md.
import postgres from "npm:postgres@3.4.9";
import { createHandler } from "../_shared/handler.ts";
import { PostgresRepository } from "../_shared/postgres-repository.ts";
import { decodeJwtSub } from "../_shared/jwt.ts";
import { RULESET_VERSION } from "../_shared/contracts.ts";
import missions from "../_shared/missions.ts";
import type { DbPool } from "../_shared/db.ts";

const dbUrl = Deno.env.get("SUPABASE_DB_URL");
if (!dbUrl) throw new Error("SUPABASE_DB_URL required");
const projectId = Deno.env.get("CREW_PROJECT_ID");
if (!projectId) throw new Error("CREW_PROJECT_ID required");

// forceCreate:false-style worker reuse means this module can serve several
// concurrent requests: the pool is created lazily once per isolate and never
// sql.end()ed after a request. A connection error drops the pool reference so
// the next request builds a fresh one (see claudedocs/SUPABASE-BPRIME-PROBE.ko.md).
// max mirrors sbp-entry.ts - see the note there for why it is 8.
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
    allowedOrigins: (Deno.env.get("CREW_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    authenticate: (token) => Promise.resolve(decodeJwtSub(token)),
    playableMissionIds: missions.filter((m) => m.playable).map((m) => m.id),
    rulesetVersion: RULESET_VERSION,
  }),
);
