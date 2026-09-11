import { createServer, type IncomingMessage, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  ApiError,
  CapabilitiesSchema,
  CreateRoomSchema,
  EnvelopeSchema,
  JoinRoomSchema,
  RULESET_VERSION,
  type Envelope,
} from "../shared/contracts.ts";
import missions from "../shared/missions.json" with { type: "json" };
import { RoomStore } from "./rooms.ts";

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function errorBody(code: string, message: string, currentRevision?: number) {
  return {
    error: {
      code,
      message,
      requestId: crypto.randomUUID(),
      ...(currentRevision === undefined ? {} : { currentRevision }),
    },
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
      if (chunks.length === 0) {
        resolvePromise(undefined);
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("INVALID_JSON", "올바른 JSON 본문이 필요합니다."));
      }
    });
    req.on("error", fail);
  });
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const match = /^Bearer (.+)$/i.exec(header ?? "");
  if (!match)
    throw new ApiError("UNAUTHENTICATED", "로그인이 필요합니다.", 401);
  return match[1];
}

export function createApp(options: {
  dataDir: string;
  staticDir: string;
  demoDelayMs?: number;
}): { server: Server; store: RoomStore } {
  const store = new RoomStore({
    dataDir: options.dataDir,
    demoDelayMs: options.demoDelayMs,
  });
  const staticRoot = resolve(options.staticDir);
  const wss = new WebSocketServer({ noServer: true });
  const roomSockets = new Map<string, Set<WebSocket>>();

  store.onRevision((roomId, revision) => {
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    const payload = JSON.stringify({ type: "revision", revision });
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  });

  function registerSocket(roomId: string, socket: WebSocket) {
    let sockets = roomSockets.get(roomId);
    if (!sockets) {
      sockets = new Set();
      roomSockets.set(roomId, sockets);
    }
    sockets.add(socket);
    socket.on("close", () => {
      sockets!.delete(socket);
      if (sockets!.size === 0) roomSockets.delete(roomId);
    });
  }

  async function serveStatic(pathname: string): Promise<
    { body: Buffer; contentType: string; cacheControl?: string } | null
  > {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null; // malformed percent-encoding: treat as not found
    }
    const hasExtension = extname(decoded) !== "";
    const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const candidate = hasExtension
      ? resolve(staticRoot, "." + relative)
      : resolve(staticRoot, "index.html");
    if (candidate !== staticRoot && !candidate.startsWith(staticRoot + sep))
      return null;
    const info = await stat(candidate).catch(() => null);
    if (!info || !info.isFile()) return null;
    const body = await readFile(candidate);
    const ext = extname(candidate);
    const cacheControl = decoded.startsWith("/cards/")
      ? "public, max-age=86400"
      : undefined;
    return {
      body,
      contentType: MIME_TYPES[ext] ?? "application/octet-stream",
      cacheControl,
    };
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Last-resort safety net: never let a rejected promise here crash the
      // process. Individual routes already handle their own errors.
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const url = new URL(req.url ?? "/", "http://internal");
    const pathname = url.pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

    if (pathname === "/healthz" && req.method === "GET") {
      sendJson(200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/")) {
      try {
        await handleApi(req, pathname, url, sendJson);
      } catch (error) {
        if (error instanceof z.ZodError) {
          sendJson(400, errorBody("VALIDATION_ERROR", "요청이 API 계약과 일치하지 않습니다."));
        } else if (error instanceof ApiError) {
          sendJson(error.status, errorBody(error.code, error.message, error.currentRevision));
        } else {
          sendJson(500, errorBody("INTERNAL_ERROR", "서버 처리 중 오류가 발생했습니다."));
        }
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(404, errorBody("NOT_FOUND", "요청 경로가 없습니다."));
      return;
    }
    const asset = await serveStatic(pathname);
    if (!asset) {
      sendJson(404, errorBody("NOT_FOUND", "요청한 파일을 찾을 수 없습니다."));
      return;
    }
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      ...(asset.cacheControl ? { "Cache-Control": asset.cacheControl } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : asset.body);
  }

  async function handleApi(
    req: import("node:http").IncomingMessage,
    pathname: string,
    _url: URL,
    sendJson: (status: number, body: unknown) => void,
  ) {
    const path = pathname.slice("/api".length) || "/";

    if (path === "/capabilities" && req.method === "GET") {
      sendJson(
        200,
        CapabilitiesSchema.parse({
          apiVersion: "1",
          backendReady: true,
          rulesetVersion: RULESET_VERSION,
          missions,
        }),
      );
      return;
    }

    if (path === "/rooms" && req.method === "POST") {
      const input = CreateRoomSchema.parse(await readJsonBody(req));
      const created = await store.createRoom(input);
      sendJson(200, {
        entry: { snapshot: created.snapshot, inviteToken: created.inviteToken },
        playerToken: created.playerToken,
      });
      return;
    }

    if (path === "/join" && req.method === "POST") {
      const input = JoinRoomSchema.parse(await readJsonBody(req));
      const joined = await store.joinRoom(input);
      sendJson(200, {
        entry: { snapshot: joined.snapshot, inviteToken: null },
        playerToken: joined.playerToken,
      });
      return;
    }

    const match = /^\/rooms\/([^/]+)(?:\/(commands|invite|demo-crew))?$/.exec(
      path,
    );
    if (!match) {
      sendJson(404, errorBody("NOT_FOUND", "요청 경로가 없습니다."));
      return;
    }
    const roomId = match[1];
    if (!UUID.test(roomId)) {
      sendJson(404, errorBody("NOT_FOUND", "요청 경로가 없습니다."));
      return;
    }
    const token = bearerToken(req);

    if (!match[2] && req.method === "GET") {
      sendJson(200, await store.snapshot(roomId, token));
      return;
    }
    if (match[2] === "commands" && req.method === "POST") {
      const input: Envelope = EnvelopeSchema.parse(await readJsonBody(req));
      sendJson(200, await store.command(roomId, token, input));
      return;
    }
    if (match[2] === "invite" && req.method === "GET") {
      sendJson(200, { inviteToken: await store.invite(roomId, token) });
      return;
    }
    if (match[2] === "demo-crew" && req.method === "POST") {
      sendJson(200, await store.fillDemoCrew(roomId, token));
      return;
    }
    sendJson(404, errorBody("NOT_FOUND", "요청 경로가 없습니다."));
  }

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://internal");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const roomId = url.searchParams.get("roomId") ?? "";
    const token = url.searchParams.get("token") ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      void (async () => {
        try {
          if (!UUID.test(roomId)) throw new Error("invalid room");
          await store.snapshot(roomId, token);
          registerSocket(roomId, ws);
        } catch {
          ws.close(4401, "unauthorized");
        }
      })();
    });
  });

  return { server, store };
}
