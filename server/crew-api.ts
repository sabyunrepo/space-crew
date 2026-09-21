import type { IncomingMessage, ServerResponse } from "node:http";
import postgres from "postgres";
import { createHandler, normalizeRoute } from "../supabase/functions/_shared/handler.ts";
import { PostgresRepository } from "../supabase/functions/_shared/postgres-repository.ts";
import type { DbPool } from "../supabase/functions/_shared/db.ts";
import { ApiError, RULESET_VERSION } from "../shared/contracts.ts";
import missions from "../shared/missions.json" with { type: "json" };
import { verifyJwt } from "./jwt.ts";
import { IpRateLimiter, clientIp } from "./rate-limit.ts";

const MAX_BODY_BYTES = 64 * 1024;
/** Same limits as the legacy create/join routes in server/app.ts. */
const ROOM_RATE_LIMIT_CAPACITY = 5;
const ROOM_RATE_LIMIT_PER_MINUTE = 10;
/** Headers that describe the incoming Node connection itself, not the
 * application request - never forwarded into the synthesized web Request. */
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-connection",
]);

const POOL_OPTIONS = {
  max: 8,
  prepare: true,
  idle_timeout: 20,
  connect_timeout: 5,
  ssl: false,
  max_lifetime: 300,
} as const;

function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "CONNECT_TIMEOUT" || code === "ECONNRESET";
}

/** Builds the real postgres.js-backed DbPool used in DB mode. Mirrors
 * supabase/functions/crew-api/sbp-entry.ts's connection-error reset
 * behaviour: a dropped connection drops the pool reference so the next call
 * opens a fresh one instead of reusing a poisoned one. Unlike the Edge
 * Function (prepare: false, one isolate per worker), this process is
 * long-lived and can safely reuse prepared statements. */
export function createPgPool(dbUrl: string): {
  pool: DbPool;
  close: () => Promise<void>;
} {
  let sql: ReturnType<typeof postgres> | null = postgres(dbUrl, POOL_OPTIONS);
  function getSql() {
    if (!sql) sql = postgres(dbUrl, POOL_OPTIONS);
    return sql;
  }
  // Drops the poisoned pool so the next call opens a fresh one, but also
  // ends its surviving connections in the background - otherwise repeated
  // connection errors during flapping would each leak a pool's worth of
  // sockets into Postgres instead of closing them.
  function resetSql() {
    const old = sql;
    sql = null;
    if (old) old.end({ timeout: 1 }).catch(() => {});
  }
  const pool: DbPool = {
    async begin(fn) {
      try {
        return (await getSql().begin((tx) =>
          fn({
            query: (text, params = []) =>
              tx.unsafe(text, params as never[], { prepare: true }),
          }),
        )) as never;
      } catch (e) {
        if (isConnectionError(e)) resetSql();
        throw e;
      }
    },
    async query(text, params = []) {
      try {
        return (await getSql().unsafe(text, params as never[], {
          prepare: true,
        })) as never;
      } catch (e) {
        if (isConnectionError(e)) resetSql();
        throw e;
      }
    },
  };
  return {
    pool,
    close: () => (sql ? sql.end({ timeout: 5 }) : Promise.resolve()),
  };
}

/** Boot-time cleanup, run once from server/index.ts the same way the
 * file-backed RoomStore prunes stale rooms. Deletes rooms whose game state
 * has not changed in maxAgeMs; every child table (crew_room_members,
 * crew_game_states, crew_command_receipts, crew_mission_attempts,
 * crew_events) cascades on crew_rooms.id, so nothing is orphaned. */
export async function pruneStaleRooms(pool: DbPool, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = await pool.query<{ id: string }>(
    `delete from public.crew_rooms where updated_at < $1::timestamptz returning id`,
    [cutoff],
  );
  return rows.length;
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new ApiError("PAYLOAD_TOO_LARGE", "요청이 너무 큽니다.", 413));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      req.removeAllListeners("data");
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new ApiError("PAYLOAD_TOO_LARGE", "요청이 너무 큽니다.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolvePromise(chunks.length ? Buffer.concat(chunks) : undefined);
    });
    req.on("error", fail);
  });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key)) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Wraps the shared Edge Function handler (createHandler) for Node: converts
 * IncomingMessage -> web Request, verifies the JWT (the platform gateway did
 * this for the Edge Function; nobody does it here), and writes the Response
 * back. */
export function createCrewApi(options: {
  pool: DbPool;
  projectId: string;
  jwtSecret: string;
  allowedOrigins: string[];
  closePool?: () => Promise<void>;
}): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
} {
  const repository = new PostgresRepository(options.pool, options.projectId);
  const roomRateLimiter = new IpRateLimiter(
    ROOM_RATE_LIMIT_CAPACITY,
    ROOM_RATE_LIMIT_PER_MINUTE,
  );
  const innerHandler = createHandler({
    repository,
    allowedOrigins: options.allowedOrigins,
    authenticate: (token) => Promise.resolve(verifyJwt(token, options.jwtSecret)),
    playableMissionIds: missions.filter((m) => m.playable).map((m) => m.id),
    rulesetVersion: RULESET_VERSION,
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const route = normalizeRoute(url.searchParams.get("route") ?? url.pathname);
    if (
      req.method === "POST" &&
      (route === "/rooms" || route === "/rooms/join") &&
      !roomRateLimiter.allow(clientIp(req))
    ) {
      sendJson(res, 429, {
        error: { code: "RATE_LIMITED", message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", requestId: crypto.randomUUID() },
      });
      return;
    }

    let body: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof ApiError) {
          sendJson(res, error.status, {
            error: { code: error.code, message: error.message, requestId: crypto.randomUUID() },
          });
        } else {
          sendJson(res, 500, {
            error: { code: "INTERNAL_ERROR", message: "서버 처리 중 오류가 발생했습니다.", requestId: crypto.randomUUID() },
          });
        }
        return;
      }
    }

    const request = new Request(url, {
      method: req.method,
      headers: toWebHeaders(req),
      body: body as BodyInit | undefined,
    });
    const response = await innerHandler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  }

  return {
    handle,
    close: async () => {
      await options.closePool?.();
    },
  };
}
