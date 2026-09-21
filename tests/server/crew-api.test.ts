import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.ts";
import type { DbPool, DbTx } from "../../supabase/functions/_shared/db.ts";

const JWT_SECRET = "test-crew-jwt-secret";
const ALLOWED_ORIGIN = "https://crew.example.com";
const PROJECT_ID = "test-project";

function b64url(input: unknown): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function signToken(sub: string, overrides: Record<string, unknown> = {}, secret = JWT_SECRET): string {
  const headerPart = b64url({ alg: "HS256", typ: "JWT" });
  const payloadPart = b64url({
    sub,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
  const signature = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

/** Same PGlite schema/pool harness as tests/server/postgres-repository.test.ts,
 * duplicated locally per AGENTS.md guidance to extract a shared helper only
 * if needed - this is the only other place it is used. */
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

async function withTempDirs<T>(
  fn: (dirs: { dataDir: string; staticDir: string }) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "crew-data-"));
  const staticDir = await mkdtemp(join(tmpdir(), "crew-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>crew</title>", "utf8");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "assets", "app.abc123.js"), "console.log(1)", "utf8");
  await mkdir(join(staticDir, "cards"), { recursive: true });
  await writeFile(join(staticDir, "cards", "blue-1.png"), "x", "utf8");
  try {
    return await fn({ dataDir, staticDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
    });
  });
}

const createRoomInput = () => ({
  commandId: randomUUID(),
  nickname: "선장",
  settings: { name: "테스트", capacity: 3 as const, missionMode: "sequential" as const, startMission: 1 },
});

describe("createApp DB mode (createCrewApi over PGlite)", () => {
  let db: PGlite;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
    if (db) await db.close();
  });

  async function bootApp(dirs: { dataDir: string; staticDir: string }) {
    db = await setupDb();
    const { server, close } = createApp({
      dataDir: dirs.dataDir,
      staticDir: dirs.staticDir,
      dbPool: makePool(db),
      projectId: PROJECT_ID,
      jwtSecret: JWT_SECRET,
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    const port = await listen(server);
    cleanup = close;
    return { port };
  }

  async function insertUser(id: string) {
    await db.exec(`insert into auth.users values ('${id}')`);
  }

  function apiUrl(port: number, path: string): string {
    return `http://127.0.0.1:${port}/api/crew?route=${encodeURIComponent(path)}`;
  }

  it("answers /capabilities for an authenticated request", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const host = randomUUID();
      await insertUser(host);
      const res = await fetch(apiUrl(port, "/capabilities"), {
        headers: { Authorization: `Bearer ${signToken(host)}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.backendReady).toBe(true);
    });
  });

  it("creates a room, joins by invite, runs a command, and never doubles a resent commandId", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const host = randomUUID();
      const guest = randomUUID();
      await insertUser(host);
      await insertUser(guest);
      const hostToken = signToken(host);

      const createRes = await fetch(apiUrl(port, "/rooms"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify(createRoomInput()),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const roomId = created.snapshot.roomId as string;
      const inviteToken = created.inviteToken as string;

      const guestToken = signToken(guest);
      const joinRes = await fetch(apiUrl(port, "/rooms/join"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify({ commandId: randomUUID(), nickname: "대원", inviteToken }),
      });
      expect(joinRes.status).toBe(200);
      const joined = await joinRes.json();
      expect(joined.snapshot.players).toHaveLength(2);

      const commandBody = {
        commandId: randomUUID(),
        expectedRevision: joined.snapshot.revision,
        attemptId: null,
        command: { type: "set_ready", ready: true },
      };
      const cmdRes1 = await fetch(apiUrl(port, `/rooms/${roomId}/commands`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify(commandBody),
      });
      expect(cmdRes1.status).toBe(200);
      const snap1 = await cmdRes1.json();

      const cmdRes2 = await fetch(apiUrl(port, `/rooms/${roomId}/commands`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify(commandBody),
      });
      expect(cmdRes2.status).toBe(200);
      const snap2 = await cmdRes2.json();
      expect(snap2).toEqual(snap1);
    });
  });

  it("returns 401 without a token and with a forged token", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const noAuth = await fetch(apiUrl(port, "/capabilities"));
      expect(noAuth.status).toBe(401);

      const forged = await fetch(apiUrl(port, "/capabilities"), {
        headers: { Authorization: `Bearer ${signToken(randomUUID(), {}, "wrong-secret")}` },
      });
      expect(forged.status).toBe(401);
    });
  });

  it("rejects a body over 64 KiB with 413", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const host = randomUUID();
      await insertUser(host);
      const res = await fetch(apiUrl(port, "/rooms"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(host)}` },
        body: JSON.stringify({ ...createRoomInput(), huge: "x".repeat(70_000) }),
      });
      expect(res.status).toBe(413);
    });
  });

  it("rejects a disallowed Origin with 403", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const res = await fetch(apiUrl(port, "/capabilities"), {
        headers: { Origin: "https://not-allowed.example.com" },
      });
      expect(res.status).toBe(403);
    });
  });

  it("returns 401 (not 500) for a token whose payload is not a JSON object", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const headerPart = b64url({ alg: "HS256" });
      const payloadPart = b64url(null);
      const signature = createHmac("sha256", JWT_SECRET)
        .update(`${headerPart}.${payloadPart}`)
        .digest("base64url");
      const res = await fetch(apiUrl(port, "/capabilities"), {
        headers: { Authorization: `Bearer ${headerPart}.${payloadPart}.${signature}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // handler.ts strips prefixes like /crew-api and /functions/v1/crew-api
  // before routing (see normalizeRoute); the rate-limit pre-check in
  // crew-api.ts must see the same normalized route, or a prefixed ?route=
  // value bypasses the limiter entirely. These two tests assert the burst
  // is cut off at the same point (the capacity-th request) either way.
  const ROOM_RATE_LIMIT_CAPACITY = 5;
  async function burstStatuses(port: number, token: string, routePath: string): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < ROOM_RATE_LIMIT_CAPACITY + 2; i++) {
      const res = await fetch(apiUrl(port, routePath), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(createRoomInput()),
      });
      statuses.push(res.status);
    }
    return statuses;
  }

  it("rate-limits room creation on the plain /rooms route after the capacity burst", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const host = randomUUID();
      await insertUser(host);
      const statuses = await burstStatuses(port, signToken(host), "/rooms");
      expect(statuses.slice(0, ROOM_RATE_LIMIT_CAPACITY)).toEqual(
        Array(ROOM_RATE_LIMIT_CAPACITY).fill(201),
      );
      expect(statuses[ROOM_RATE_LIMIT_CAPACITY]).toBe(429);
    });
  });

  it("rate-limits room creation the same when the route is platform-prefixed", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const host = randomUUID();
      await insertUser(host);
      const statuses = await burstStatuses(port, signToken(host), "/crew-api/rooms");
      expect(statuses.slice(0, ROOM_RATE_LIMIT_CAPACITY)).toEqual(
        Array(ROOM_RATE_LIMIT_CAPACITY).fill(201),
      );
      expect(statuses[ROOM_RATE_LIMIT_CAPACITY]).toBe(429);
    });
  });

  it("404s the legacy /api/rooms route in DB mode", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRoomInput()),
      });
      expect(res.status).toBe(404);
    });
  });

  it("refuses the /ws upgrade in DB mode", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${randomUUID()}`);
      const outcome = await new Promise<string>((resolve) => {
        socket.on("open", () => resolve("open"));
        socket.on("error", () => resolve("error"));
        socket.on("close", () => resolve("close"));
      });
      expect(outcome).not.toBe("open");
    });
  });

  it("sets cache-control headers for /assets, index.html and /cards", async () => {
    await withTempDirs(async (dirs) => {
      const { port } = await bootApp(dirs);
      const assets = await fetch(`http://127.0.0.1:${port}/assets/app.abc123.js`);
      expect(assets.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const index = await fetch(`http://127.0.0.1:${port}/`);
      expect(index.headers.get("cache-control")).toBe("no-cache");

      const cards = await fetch(`http://127.0.0.1:${port}/cards/blue-1.png`);
      expect(cards.headers.get("cache-control")).toBe("public, max-age=86400");
    });
  });
});
