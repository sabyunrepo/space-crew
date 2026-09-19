// Edge Function: room-level row-lock transaction + per-user private Broadcast probe.
// Deployed standalone (no shared imports) so the whole deploy unit is this folder.
//
// Platform constraints this file is written against:
// - No npm:/jsr:/https: imports. "postgres" (postgres.js) is vendored locally
//   as vendor/postgres.js by ../build.mjs.
// - node: builtin imports are expected to work (Deno Node compatibility).
// - Router already verified the JWT (HS256, exp, role=authenticated, sub is a
//   UUID) before calling this function; we only need the `sub` claim, no
//   re-verification.
//
// Worker-reuse constraints: the router runs with forceCreate:false, so one
// worker isolate can handle several requests concurrently. The postgres.js
// connection pool below is therefore created lazily once per isolate and
// reused across requests (never `sql.end()`ed after a request).

// vendor/postgres.js binds Buffer/process itself (see build.mjs banner).
// @deno-types="./vendor/postgres.d.ts"
import postgres from "./vendor/postgres.js";

const MODULE_T0 = performance.now();
// deno-lint-ignore no-unused-vars
const MODULE_EPOCH = Date.now();

const PROJECT_ID = "8b616c05-f470-4449-aa25-2287714d0db6";

const REQUIRED_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLIC_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_FUNCTION_SLUG",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function base64UrlDecode(input: string): string {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Router already verified this JWT. We only pull `sub` out of the payload. */
function getSub(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return isUuid(payload?.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

type Sql = ReturnType<typeof postgres>;

// Lazily created once per worker isolate, then reused by every request that
// isolate handles (forceCreate:false means requests can arrive concurrently).
let pool: Sql | null = null;
let workerRequestCount = 0;

function getPool(): { sql: Sql; reused: boolean } {
  const reused = pool !== null;
  if (!pool) {
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrl) throw new Error("SUPABASE_DB_URL not set");
    pool = postgres(dbUrl, {
      max: 3,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 5,
      ssl: false,
      max_lifetime: 60 * 5,
    });
  }
  return { sql: pool, reused };
}

/** Drop the shared pool reference on connection failure so the next request
 * builds a fresh one; the broken pool is closed in the background. */
function dropPool(bad: Sql): void {
  if (pool === bad) pool = null;
  bad.end({ timeout: 1 }).catch(() => {});
}

function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return code === "CONNECT_TIMEOUT" || code === "ECONNRESET" ||
    /CONNECT_TIMEOUT|ECONNRESET/.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleDiag(): Promise<Response> {
  const envPresence: Record<string, boolean> = {};
  for (const key of REQUIRED_ENV_KEYS) {
    envPresence[key] = Boolean(Deno.env.get(key));
  }

  let dbConnectMs: number | null = null;
  let currentUser: string | null = null;
  let version: string | null = null;
  let realtimeSendExists: boolean | null = null;
  let dbError: string | null = null;

  let sql: Sql | undefined;
  try {
    ({ sql } = getPool());
    const t0 = performance.now();
    const [row] = await sql`select current_user, version()`;
    dbConnectMs = performance.now() - t0;
    currentUser = row.current_user;
    version = row.version;

    const sendRows = await sql`select 1 from pg_proc where proname = 'send'`;
    realtimeSendExists = sendRows.length > 0;
  } catch (e) {
    if (sql && isConnectionError(e)) dropPool(sql);
    dbError = e instanceof Error ? e.message : String(e);
  }

  return jsonResponse({
    env: envPresence,
    db: {
      connect_ms: dbConnectMs,
      current_user: currentUser,
      version,
      realtime_send_exists: realtimeSendExists,
      error: dbError,
    },
    module_to_handler_ms: performance.now() - MODULE_T0,
  });
}

interface CmdInput {
  room: string;
  players: string[];
  work_ms: number;
  command_id: string | null;
  expect_revision: number | null;
}

function validateCmdInput(body: unknown): CmdInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isUuid(b.room)) return null;
  if (!Array.isArray(b.players) || b.players.length < 1 || b.players.length > 5) return null;
  if (!b.players.every(isUuid)) return null;

  let work_ms = 0;
  if (b.work_ms !== undefined) {
    if (typeof b.work_ms !== "number" || !Number.isFinite(b.work_ms) || b.work_ms < 0 || b.work_ms > 500) {
      return null;
    }
    work_ms = b.work_ms;
  }

  let command_id: string | null = null;
  if (b.command_id !== undefined) {
    if (!isUuid(b.command_id)) return null;
    command_id = b.command_id as string;
  }

  let expect_revision: number | null = null;
  if (b.expect_revision !== undefined) {
    if (
      typeof b.expect_revision !== "number" ||
      !Number.isInteger(b.expect_revision) ||
      b.expect_revision < 0
    ) {
      return null;
    }
    expect_revision = b.expect_revision;
  }

  return {
    room: b.room as string,
    players: b.players as string[],
    work_ms,
    command_id,
    expect_revision,
  };
}

interface PeekInput {
  room: string;
}

function validatePeekInput(body: unknown): PeekInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isUuid(b.room)) return null;
  return { room: b.room as string };
}

async function handlePeek(body: unknown): Promise<Response> {
  const input = validatePeekInput(body);
  if (!input) {
    return errorResponse("bad_input", "expected {room: uuid}", 400);
  }

  let sql: Sql | undefined;
  try {
    ({ sql } = getPool());
    const rows = await sql`
      select revision from public.probe_rooms where room_id = ${input.room}::uuid
    `;
    const revision = rows.length > 0 ? Number(rows[0].revision) : 0;
    return jsonResponse({ revision });
  } catch (e) {
    if (sql && isConnectionError(e)) dropPool(sql);
    const message = e instanceof Error ? e.message : "unknown error";
    return errorResponse("peek_failed", message, 500);
  }
}

async function handleCmd(req: Request, body: unknown): Promise<Response> {
  const handlerT0 = performance.now();
  const moduleToHandlerMs = handlerT0 - MODULE_T0;

  const actorSub = getSub(req);
  if (!actorSub) {
    return errorResponse("no_sub", "missing or invalid subject claim", 401);
  }

  const input = validateCmdInput(body);
  if (!input) {
    return errorResponse(
      "bad_input",
      "expected {room: uuid, players: uuid[1..5], work_ms?: 0..500, command_id?: uuid, expect_revision?: integer>=0}",
      400,
    );
  }

  const topicPrefix = `sbp:${PROJECT_ID}:`;
  let sql: Sql | undefined;
  let poolReused = false;

  try {
    ({ sql, reused: poolReused } = getPool());

    // sql.begin() pins one physical connection for the whole callback and
    // scopes BEGIN/COMMIT/ROLLBACK to it, so concurrent requests sharing this
    // pool (max: 3) never interleave transaction-control statements onto the
    // same connection the way raw `sql\`BEGIN\`` ... `sql\`COMMIT\`` would.
    const outcome = await sql.begin(async (tx) => {
      const connectMs = performance.now() - handlerT0;

      await tx`insert into public.probe_rooms (room_id) values (${input.room}::uuid) on conflict do nothing`;

      const lockStart = performance.now();
      const [locked] = await tx`
        select revision, state from public.probe_rooms where room_id = ${input.room}::uuid for update
      `;
      const lockWaitMs = performance.now() - lockStart;
      const currentRevision = Number(locked.revision);

      // The receipt lookup happens only after FOR UPDATE has been granted:
      // if two resends of the same command_id raced ahead of the lock, both
      // would see "no receipt yet" and both would apply the command twice.
      // Serializing on the row lock first makes the second resend observe
      // the first resend's receipt.
      if (input.command_id) {
        const [receipt] = await tx`
          select revision from public.probe_receipts where command_id = ${input.command_id}::uuid
        `;
        if (receipt) {
          return {
            kind: "duplicate" as const,
            revision: Number(receipt.revision),
            connectMs,
            lockWaitMs,
          };
        }
      }

      if (input.expect_revision !== null && input.expect_revision !== currentRevision) {
        return {
          kind: "skipped" as const,
          revision: currentRevision,
          reason: "stale_expect_revision",
        };
      }

      const workStart = performance.now();
      await sleep(input.work_ms);
      const workMs = performance.now() - workStart;

      const writeStart = performance.now();
      const [updated] = await tx`
        update public.probe_rooms
        set revision = revision + 1,
            state = jsonb_set(
              state,
              '{log}',
              coalesce(state -> 'log', '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('a', ${actorSub}::uuid, 'r', revision + 1))
            ),
            updated_at = now()
        where room_id = ${input.room}::uuid
        returning revision
      `;
      const writeMs = performance.now() - writeStart;
      const revision = Number(updated.revision);

      if (input.command_id) {
        await tx`
          insert into public.probe_receipts (command_id, room_id, actor, revision)
          values (${input.command_id}::uuid, ${input.room}::uuid, ${actorSub}::uuid, ${revision}::bigint)
        `;
      }

      const commitStart = performance.now();
      const serverCommitEpoch = Date.now();
      await tx`
        select realtime.send(
          jsonb_build_object(
            'revision', ${revision}::bigint,
            'actor', ${actorSub}::uuid,
            'room', ${input.room}::uuid,
            'server_commit_epoch', ${serverCommitEpoch}::bigint,
            'for', p
          ),
          'snapshot',
          ${topicPrefix}::text || p::text,
          true
        )
        from unnest(${input.players}::uuid[]) as p
      `;
      const commitMs = performance.now() - commitStart;

      return {
        kind: "committed" as const,
        revision,
        connectMs,
        lockWaitMs,
        workMs,
        writeMs,
        commitMs,
        serverCommitEpoch,
      };
    });

    const workerAgeMs = performance.now() - MODULE_T0;

    if (outcome.kind === "duplicate") {
      return jsonResponse({
        revision: outcome.revision,
        duplicate: true,
        pool_reused: poolReused,
        worker_request_count: workerRequestCount,
        worker_age_ms: workerAgeMs,
        timings: {
          module_to_handler_ms: moduleToHandlerMs,
          connect_ms: outcome.connectMs,
          lock_wait_ms: outcome.lockWaitMs,
          total_ms: performance.now() - handlerT0,
        },
      });
    }

    if (outcome.kind === "skipped") {
      return jsonResponse({
        revision: outcome.revision,
        skipped: true,
        reason: outcome.reason,
        pool_reused: poolReused,
        worker_request_count: workerRequestCount,
        worker_age_ms: workerAgeMs,
      });
    }

    return jsonResponse({
      revision: outcome.revision,
      pool_reused: poolReused,
      worker_request_count: workerRequestCount,
      worker_age_ms: workerAgeMs,
      timings: {
        module_to_handler_ms: moduleToHandlerMs,
        connect_ms: outcome.connectMs,
        lock_wait_ms: outcome.lockWaitMs,
        work_ms: outcome.workMs,
        write_ms: outcome.writeMs,
        commit_ms: outcome.commitMs,
        total_ms: performance.now() - handlerT0,
      },
      server_epoch_done: Date.now(),
    });
  } catch (e) {
    if (sql && isConnectionError(e)) dropPool(sql);
    const message = e instanceof Error ? e.message : "unknown error";
    return errorResponse("cmd_failed", message, 500);
  }
}

Deno.serve(async (req) => {
  workerRequestCount++;

  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", "POST only", 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("bad_json", "invalid JSON body", 400);
  }

  const op = (body as Record<string, unknown> | null)?.op;
  if (op === "diag") return handleDiag();
  if (op === "cmd") return handleCmd(req, body);
  if (op === "peek") return handlePeek(body);
  return errorResponse("bad_op", "op must be 'diag', 'cmd', or 'peek'", 400);
});
