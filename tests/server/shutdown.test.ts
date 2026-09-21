import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createApp } from "../../server/app.ts";
import type { DbPool, DbTx } from "../../supabase/functions/_shared/db.ts";

/** Bug 2 fix under test: server/app.ts close() used to call
 * closeAllConnections() (killing in-flight requests) before server.close(),
 * and did nothing to take the container out of a load balancer's rotation
 * first - so a rolling Coolify deploy dropped exactly one in-flight request
 * per swap. The fix drains: /healthz -> 503 immediately, stop accepting new
 * connections only after a short window (letting in-flight requests finish),
 * then close the DB pool, all under a hard deadline. */

const JWT_SECRET = "test-crew-jwt-secret";
const ALLOWED_ORIGIN = "https://crew.example.com";
const PROJECT_ID = "test-project";

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

async function withTempDirs<T>(
  fn: (dirs: { dataDir: string; staticDir: string }) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "crew-data-"));
  const staticDir = await mkdtemp(join(tmpdir(), "crew-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>crew</title>", "utf8");
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

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const createRoomInput = () => ({
  commandId: crypto.randomUUID(),
  nickname: "선장",
  settings: { name: "테스트", capacity: 3 as const, missionMode: "sequential" as const, startMission: 1 },
});

/** Opens a raw socket, sends a POST with the body split in two writes
 * `delayBeforeRestMs` apart, and returns the parsed status line once the
 * server responds. Used to prove a request already "in flight" (headers
 * received, body still streaming in) is not cut when the drain window
 * elapses mid-request. */
function slowInFlightPost(port: number, path: string, bodyJson: string, delayBeforeRestMs: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const header =
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(bodyJson)}\r\nConnection: close\r\n\r\n`;
      const splitAt = Math.max(1, Math.floor(bodyJson.length / 2));
      socket.write(header + bodyJson.slice(0, splitAt));
      setTimeout(() => socket.write(bodyJson.slice(splitAt)), delayBeforeRestMs);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      const statusLine = data.split("\r\n")[0] ?? "";
      resolvePromise(Number(statusLine.split(" ")[1]));
    });
    socket.on("error", reject);
  });
}

describe("graceful shutdown drain", () => {
  it("answers /healthz with 503 immediately, while other routes keep serving 200 during the drain window", async () => {
    await withTempDirs(async (dirs) => {
      const { server, close } = createApp({
        dataDir: dirs.dataDir,
        staticDir: dirs.staticDir,
        demoDelayMs: 0,
        shutdownDrainMs: 150,
        shutdownDeadlineMs: 2000,
      });
      const port = await listen(server);
      const closePromise = close();

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(503);

      const index = await fetch(`http://127.0.0.1:${port}/`);
      expect(index.status).toBe(200);

      await closePromise;
    });
  });

  it("refuses new connections only after the drain window elapses", async () => {
    await withTempDirs(async (dirs) => {
      const { server, close } = createApp({
        dataDir: dirs.dataDir,
        staticDir: dirs.staticDir,
        demoDelayMs: 0,
        shutdownDrainMs: 100,
        shutdownDeadlineMs: 2000,
      });
      const port = await listen(server);
      const closePromise = close();

      // Still within the drain window: a brand new connection must succeed.
      const duringDrain = await fetch(`http://127.0.0.1:${port}/`);
      expect(duringDrain.status).toBe(200);

      await new Promise((r) => setTimeout(r, 180));
      // Past the drain window: server.close() has run, no new connections.
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

      await closePromise;
    });
  });

  it("does not cut a request already in flight when the drain window elapses mid-request", async () => {
    await withTempDirs(async (dirs) => {
      const { server, close } = createApp({
        dataDir: dirs.dataDir,
        staticDir: dirs.staticDir,
        demoDelayMs: 0,
        shutdownDrainMs: 50,
        shutdownDeadlineMs: 2000,
      });
      const port = await listen(server);
      const body = JSON.stringify(createRoomInput());
      // Body finishes arriving well after the 50ms drain window closes.
      const requestPromise = slowInFlightPost(port, "/api/rooms", body, 200);
      await new Promise((r) => setTimeout(r, 10)); // let the headers land first
      const closePromise = close();

      const status = await requestPromise;
      expect(status).toBe(200);

      await closePromise;
    });
  });

  it("stays under the hard deadline even when a request never finishes", async () => {
    await withTempDirs(async (dirs) => {
      const { server, close } = createApp({
        dataDir: dirs.dataDir,
        staticDir: dirs.staticDir,
        demoDelayMs: 0,
        shutdownDrainMs: 30,
        shutdownDeadlineMs: 200,
      });
      const port = await listen(server);
      // Open a request and never send the rest of its body.
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /api/rooms HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"stuck":`,
        );
      });
      await new Promise((r) => setTimeout(r, 10));

      const start = Date.now();
      await close();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(400);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      socket.destroy();
    });
  });

  it("closes the DB pool only after the HTTP server has stopped accepting connections", async () => {
    await withTempDirs(async (dirs) => {
      const db = new PGlite();
      let port = 0;
      const sequence: string[] = [];
      const { server, close } = createApp({
        dataDir: dirs.dataDir,
        staticDir: dirs.staticDir,
        dbPool: makePool(db),
        projectId: PROJECT_ID,
        jwtSecret: JWT_SECRET,
        allowedOrigins: [ALLOWED_ORIGIN],
        shutdownDrainMs: 20,
        shutdownDeadlineMs: 2000,
        closePool: async () => {
          sequence.push("closePool-called");
          const stillAccepting = await canConnect(port);
          sequence.push(stillAccepting ? "server-still-accepting" : "server-already-closed");
        },
      });
      port = await listen(server);
      await close();
      await db.close();
      expect(sequence).toEqual(["closePool-called", "server-already-closed"]);
    });
  });

  it("shuts down cleanly in legacy (no CREW_DB_URL) mode through the full drain sequence", async () => {
    await withTempDirs(async (dirs) => {
      const { server, close } = createApp({
        dataDir: dirs.dataDir,
        staticDir: dirs.staticDir,
        demoDelayMs: 0,
        shutdownDrainMs: 30,
        shutdownDeadlineMs: 500,
      });
      const port = await listen(server);
      const start = Date.now();
      await close();
      expect(Date.now() - start).toBeLessThan(500);
      expect(await canConnect(port)).toBe(false);
    });
  });
});
