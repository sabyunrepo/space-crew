import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
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
import { IpRateLimiter, clientIp } from "./rate-limit.ts";
import { createCrewApi } from "./crew-api.ts";
import type { DbPool } from "../supabase/functions/_shared/db.ts";

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WS_MAX_PAYLOAD_BYTES = 4096;
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** Room creation / join: 10 req/min per IP, burst 5. */
const ROOM_RATE_LIMIT_CAPACITY = 5;
const ROOM_RATE_LIMIT_PER_MINUTE = 10;
/** WS auth attempts: 30/min per IP, closed immediately over the limit. */
const WS_AUTH_RATE_LIMIT_CAPACITY = 30;
const WS_AUTH_RATE_LIMIT_PER_MINUTE = 30;

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

type WsConnState = {
  alive: boolean;
  authenticated: boolean;
  roomId: string;
  authTimer: ReturnType<typeof setTimeout> | null;
};

export function createApp(options: {
  dataDir: string;
  staticDir: string;
  demoDelayMs?: number;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** DB mode switch: when set, /api/crew is mounted against this pool and
   * the legacy file-backed /api/* routes and /ws upgrade are disabled. */
  dbPool?: DbPool;
  projectId?: string;
  jwtSecret?: string;
  allowedOrigins?: string[];
  closePool?: () => Promise<void>;
}): { server: Server; store: RoomStore; close: () => Promise<void> } {
  const store = new RoomStore({
    dataDir: options.dataDir,
    demoDelayMs: options.demoDelayMs,
  });
  const dbMode = options.dbPool !== undefined;
  const crewApi = options.dbPool
    ? createCrewApi({
        pool: options.dbPool,
        projectId: options.projectId!,
        jwtSecret: options.jwtSecret!,
        allowedOrigins: options.allowedOrigins ?? [],
        closePool: options.closePool,
      })
    : null;
  const staticRoot = resolve(options.staticDir);
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });
  const roomSockets = new Map<string, Set<WebSocket>>();
  const wsState = new Map<WebSocket, WsConnState>();
  const roomRateLimiter = new IpRateLimiter(
    ROOM_RATE_LIMIT_CAPACITY,
    ROOM_RATE_LIMIT_PER_MINUTE,
  );
  const wsAuthRateLimiter = new IpRateLimiter(
    WS_AUTH_RATE_LIMIT_CAPACITY,
    WS_AUTH_RATE_LIMIT_PER_MINUTE,
  );

  store.onRevision((roomId, revision) => {
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    const payload = JSON.stringify({ type: "revision", revision });
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  });

  function registerSocket(roomId: string, socket: WebSocket) {
    // L4: the auth check (an async store.snapshot call) may finish after the
    // client has already gone away - never add a non-OPEN socket.
    if (socket.readyState !== WebSocket.OPEN) return;
    let sockets = roomSockets.get(roomId);
    if (!sockets) {
      sockets = new Set();
      roomSockets.set(roomId, sockets);
    }
    sockets.add(socket);
    store.connectionOpened(roomId);
    socket.on("close", () => {
      sockets!.delete(socket);
      if (sockets!.size === 0) roomSockets.delete(roomId);
      store.connectionClosed(roomId);
    });
  }

  // M7: heartbeat. A dead peer (network drop, crashed tab) never sends a
  // FIN, so without this a broken connection lingers in roomSockets forever.
  const heartbeatTimer: ReturnType<typeof setInterval> | null =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          for (const ws of wss.clients) {
            const state = wsState.get(ws);
            if (!state) continue;
            if (!state.alive) {
              ws.terminate();
              continue;
            }
            state.alive = false;
            ws.ping();
          }
        }, heartbeatIntervalMs)
      : null;
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function")
    heartbeatTimer.unref();

  function handleConnection(ws: WebSocket, roomId: string, ip: string) {
    // C1: an upgraded socket that never gets an error handler can crash the
    // process on a single malformed frame (e.g. invalid UTF-8 in a text
    // frame) - the ws Receiver emits 'error' and, unhandled, that's fatal.
    ws.on("error", () => ws.terminate());

    const state: WsConnState = {
      alive: true,
      authenticated: false,
      roomId,
      authTimer: null,
    };
    wsState.set(ws, state);
    ws.on("pong", () => {
      state.alive = true;
    });

    state.authTimer = setTimeout(() => {
      if (!state.authenticated) ws.close(4401, "auth timeout");
    }, authTimeoutMs);
    if (typeof state.authTimer.unref === "function") state.authTimer.unref();

    ws.on("close", () => {
      if (state.authTimer) clearTimeout(state.authTimer);
      wsState.delete(ws);
    });

    ws.on("message", (data, isBinary) => {
      if (state.authenticated || isBinary) return; // M4: only one auth message is ever read
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // malformed pre-auth frame: ignore, never crash
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { type?: unknown }).type !== "auth" ||
        typeof (parsed as { token?: unknown }).token !== "string"
      )
        return;
      const token = (parsed as { token: string }).token;
      void (async () => {
        if (!wsAuthRateLimiter.allow(ip)) {
          ws.close(4401, "rate limited");
          return;
        }
        try {
          const snapshot = await store.snapshot(roomId, token);
          if (state.authTimer) clearTimeout(state.authTimer);
          state.authenticated = true;
          if (ws.readyState !== WebSocket.OPEN) return; // L4
          registerSocket(roomId, ws);
          ws.send(JSON.stringify({ type: "revision", revision: snapshot.revision }));
        } catch {
          ws.close(4401, "unauthorized");
        }
      })();
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
    // /assets/* is Vite's hashed build output - safe to cache for a year.
    // index.html (direct hit or the SPA fallback above) must always be
    // revalidated, or a cached one would keep pointing at stale hashed
    // assets. /cards/ and /characters/ have no hash in their names, so a day
    // is as long as it is safe to go without a check.
    const cacheControl = decoded.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : decoded.startsWith("/cards/") || decoded.startsWith("/characters/")
        ? "public, max-age=86400"
        : candidate === resolve(staticRoot, "index.html")
          ? "no-cache"
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

    if (
      req.method === "POST" &&
      (pathname === "/api/rooms" || pathname === "/api/join") &&
      !roomRateLimiter.allow(clientIp(req))
    ) {
      sendJson(
        429,
        errorBody("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도하세요."),
      );
      return;
    }

    if (dbMode) {
      if (pathname === "/api/crew" || pathname.startsWith("/api/crew/")) {
        await crewApi!.handle(req, res);
        return;
      }
      if (pathname.startsWith("/api/")) {
        sendJson(404, errorBody("NOT_FOUND", "요청 경로가 없습니다."));
        return;
      }
    } else if (pathname.startsWith("/api/")) {
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

    const match = /^\/rooms\/([^/]+)(?:\/(commands|invite|demo-crew|leave))?$/.exec(
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
    if (match[2] === "leave" && req.method === "POST") {
      await store.leaveRoom(roomId, token);
      sendJson(200, { ok: true });
      return;
    }
    sendJson(404, errorBody("NOT_FOUND", "요청 경로가 없습니다."));
  }

  server.on("upgrade", (req, socket, head) => {
    // A raw socket that errors before the WS handshake completes (e.g. the
    // client vanishes mid-handshake) must not crash the process either.
    socket.on("error", () => {});
    if (dbMode) {
      socket.destroy();
      return;
    }
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
    if (!UUID.test(roomId)) {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, roomId, ip);
    });
  });

  function close(): Promise<void> {
    return new Promise((resolveClose) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      store.shutdown();
      for (const ws of wss.clients) {
        try {
          ws.close(1012, "server shutting down");
        } catch {
          // ignore - the socket may already be closing
        }
      }
      if (typeof server.closeAllConnections === "function")
        server.closeAllConnections();
      server.close(() => {
        if (crewApi) crewApi.close().finally(() => resolveClose());
        else resolveClose();
      });
    });
  }

  return { server, store, close };
}
