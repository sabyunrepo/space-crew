import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
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

/** Encodes a masked (client -> server) WS frame with an arbitrary opcode and
 * raw payload bytes, for tests that need to bypass the `ws` client's own
 * framing/validation (e.g. sending intentionally invalid UTF-8). */
function encodeMaskedFrame(opcode: number, payloadBytes: number[]): Buffer {
  const mask = [1, 2, 3, 4];
  const masked = payloadBytes.map((b, i) => b ^ mask[i % 4]);
  if (payloadBytes.length < 126)
    return Buffer.from([0x80 | opcode, 0x80 | payloadBytes.length, ...mask, ...masked]);
  return Buffer.from([
    0x80 | opcode,
    0x80 | 126,
    (payloadBytes.length >> 8) & 0xff,
    payloadBytes.length & 0xff,
    ...mask,
    ...masked,
  ]);
}

function encodeMaskedTextFrame(payload: string): Buffer {
  return encodeMaskedFrame(0x1, [...Buffer.from(payload, "utf8")]);
}

function wsHandshakeRequest(port: number, path: string): string {
  return (
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
    "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n"
  );
}

async function rawWsHandshake(port: number, path: string): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  const response = await new Promise<string>((resolve) => {
    socket.once("data", (buf) => resolve(buf.toString()));
    socket.write(wsHandshakeRequest(port, path));
  });
  expect(response.split("\r\n")[0]).toContain("101");
  return socket;
}

describe("createApp HTTP + WS", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("answers /healthz", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("creates a room over HTTP and issues a playerToken", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
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

  it("M4: authenticates over WS via a first auth message (no token in the URL) and pushes revision", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
      const createRes = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      const created = await createRes.json();
      const roomId = created.entry.snapshot.roomId as string;
      const token = created.playerToken as string;

      const badSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}`);
      await new Promise<void>((resolve) => badSocket.on("open", () => resolve()));
      badSocket.send(JSON.stringify({ type: "auth", token: "not-a-real-token" }));
      const badClose = await new Promise<number>((resolve) => {
        badSocket.on("close", (code) => resolve(code));
      });
      expect(badClose).toBe(4401);

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}`);
      await new Promise<void>((resolve, reject) => {
        socket.on("open", () => resolve());
        socket.on("error", reject);
      });
      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      socket.send(JSON.stringify({ type: "auth", token }));
      await new Promise((r) => setTimeout(r, 150));
      expect(messages).toEqual([{ type: "revision", revision: 0 }]);

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
      await new Promise((r) => setTimeout(r, 150));
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

  it("closes the WS with 4401 if no auth message arrives within authTimeoutMs", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({
        dataDir,
        staticDir,
        demoDelayMs: 0,
        authTimeoutMs: 30,
      });
      const port = await listen(server);
      cleanup = closeApp;
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${crypto.randomUUID()}`,
      );
      const code = await new Promise<number>((resolve) => {
        socket.on("close", (c) => resolve(c));
      });
      expect(code).toBe(4401);
    });
  });

  it("ignores malformed/non-auth pre-auth messages without crashing, then still authenticates", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
      const createRes = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      const created = await createRes.json();
      const roomId = created.entry.snapshot.roomId as string;
      const token = created.playerToken as string;

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}`);
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      socket.send("not json{{{");
      socket.send(JSON.stringify({ type: "hello" }));
      socket.send(JSON.stringify({ type: "auth" })); // missing token field
      await new Promise((r) => setTimeout(r, 80));
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const message = new Promise((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      socket.send(JSON.stringify({ type: "auth", token }));
      expect(await message).toEqual({ type: "revision", revision: 0 });
      socket.close();
    });
  });

  it("C1: survives an invalid-UTF8 WS text frame from an unauthenticated raw socket", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
      const socket = await rawWsHandshake(port, `/ws?roomId=${crypto.randomUUID()}`);
      socket.on("error", () => {});
      socket.write(encodeMaskedFrame(0x1, [0xff, 0xfe])); // invalid UTF-8 text frame
      await new Promise((r) => setTimeout(r, 200));
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      socket.destroy();
    });
  });

  it("M7: terminates a connection that stops responding to heartbeat pings", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({
        dataDir,
        staticDir,
        demoDelayMs: 0,
        heartbeatIntervalMs: 20,
      });
      const port = await listen(server);
      cleanup = closeApp;
      const socket = await rawWsHandshake(port, `/ws?roomId=${crypto.randomUUID()}`);
      socket.on("error", () => {});
      const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      await Promise.race([
        ended,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    });
  }, 10000);

  it("M8: close() closes open WS connections with 1012 and resolves promptly", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      const createRes = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      const created = await createRes.json();
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${created.entry.snapshot.roomId}`,
      );
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      socket.send(JSON.stringify({ type: "auth", token: created.playerToken }));
      await new Promise((r) => setTimeout(r, 80));
      const closeCode = new Promise<number>((resolve) => {
        socket.on("close", (code) => resolve(code));
      });
      const start = Date.now();
      await closeApp();
      expect(Date.now() - start).toBeLessThan(5000);
      expect(await closeCode).toBe(1012);
    });
  });

  it("H2: rate-limits POST /api/rooms per IP with 429 RATE_LIMITED after the burst", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createInput()),
        });
        statuses.push(res.status);
        if (res.status === 429) {
          const body = await res.json();
          expect(body.error.code).toBe("RATE_LIMITED");
        }
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });
  });

  it("serves the SPA fallback for deep links and 404s unknown /api paths as JSON", async () => {
    await withTempDirs(async ({ dataDir, staticDir }) => {
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
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
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
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
      const { server, close: closeApp } = createApp({ dataDir, staticDir, demoDelayMs: 0 });
      const port = await listen(server);
      cleanup = closeApp;
      const res = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
      expect(res.status).toBe(404);
      // The server must still be responsive afterwards.
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    });
  });
});
