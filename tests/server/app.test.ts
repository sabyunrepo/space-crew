import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { createApp } from "../../server/app.ts";

const createInput = () => ({
  commandId: crypto.randomUUID(),
  nickname: "별빛",
  settings: {
    name: "테스트",
    capacity: 3 as const,
    missionMode: "sequential" as const,
    startMission: 1,
  },
});

async function withTempDirs<T>(
  fn: (dirs: { dataDir: string; staticDir: string }) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "crew-data-"));
  const staticDir = await mkdtemp(join(tmpdir(), "crew-static-"));
  await writeFile(
    join(staticDir, "index.html"),
    "<!doctype html><title>crew</title>",
    "utf8",
  );
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

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("createApp HTTP + WS", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("answers /healthz", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, store } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = async () => {
        store.shutdown();
        await close(server);
      };
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("creates a room over HTTP and issues a playerToken", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, store } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = async () => {
        store.shutdown();
        await close(server);
      };
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.playerToken).toBe("string");
      expect(body.entry.snapshot.roomId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  it("delivers a revision message over WS after another player's command, and rejects a bad token", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, store } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = async () => {
        store.shutdown();
        await close(server);
      };
      const createRes = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      const created = await createRes.json();
      const roomId = created.entry.snapshot.roomId as string;
      const token = created.playerToken as string;

      const badSocket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=not-a-real-token`,
      );
      const badClose = await new Promise<number>((resolve) => {
        badSocket.on("close", (code) => resolve(code));
      });
      expect(badClose).toBe(4401);

      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${token}`,
      );
      await new Promise((resolve, reject) => {
        socket.on("open", resolve);
        socket.on("error", reject);
      });
      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

      const commandRes = await fetch(
        `http://127.0.0.1:${port}/api/rooms/${roomId}/commands`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            expectedRevision: 0,
            attemptId: null,
            command: { type: "set_ready", ready: true },
          }),
        },
      );
      expect(commandRes.status).toBe(200);
      const snapshot = await commandRes.json();
      expect(snapshot.revision).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        messages.some(
          (m) =>
            typeof m === "object" &&
            m !== null &&
            (m as { type?: string }).type === "revision" &&
            (m as { revision?: number }).revision === 1,
        ),
      ).toBe(true);
      socket.close();
    });
  });

  it("serves the SPA fallback for deep links and 404s unknown /api paths as JSON", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, store } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = async () => {
        store.shutdown();
        await close(server);
      };
      const roomPage = await fetch(
        `http://127.0.0.1:${port}/rooms/${crypto.randomUUID()}`,
      );
      expect(roomPage.status).toBe(200);
      expect(await roomPage.text()).toContain("<title>crew</title>");

      const unknown = await fetch(`http://127.0.0.1:${port}/api/nope`);
      expect(unknown.status).toBe(404);
      const body = await unknown.json();
      expect(body.error.code).toBeDefined();
    });
  });

  it("rejects request bodies larger than 64KB with 413", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, store } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = async () => {
        store.shutdown();
        await close(server);
      };
      const huge = "x".repeat(70_000);
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...createInput(), huge }),
      });
      expect(res.status).toBe(413);
    });
  });

  it("does not crash on a malformed percent-encoded static path", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, store } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = async () => {
        store.shutdown();
        await close(server);
      };
      const res = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
      expect(res.status).toBe(404);
      // The server must still be responsive afterwards.
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    });
  });
});
