import { z } from "zod";
import {
  ApiError,
  CapabilitiesSchema,
  EntrySchema,
  SnapshotSchema,
  type Connection,
  type CreateRoom,
  type Envelope,
  type GameService,
  type JoinRoom,
} from "../../shared/contracts.ts";

const TOKEN_PREFIX = "crew.server.v1.token.";
const MAX_BACKOFF_MS = 10_000;
const BASE_BACKOFF_MS = 500;

const tokenKey = (roomId: string) => TOKEN_PREFIX + roomId;

function wsUrl(roomId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws?roomId=${encodeURIComponent(roomId)}`;
}

const CreateOrJoinResponseSchema = z.object({
  entry: EntrySchema,
  playerToken: z.string(),
});

/**
 * `GameService` backed by the Node realtime server (`server/app.ts`): REST
 * for commands, a WebSocket for revision push. The server never trusts a
 * client-declared playerId — every request is authenticated by the Bearer
 * playerToken this class keeps in localStorage, one per room.
 */
export class ServerService implements GameService {
  readonly mode = "server";

  private tokenFor(roomId: string): string {
    const token = localStorage.getItem(tokenKey(roomId));
    if (!token)
      throw new ApiError(
        "TOKEN_NOT_FOUND",
        "이 브라우저에 이 방의 자리 정보가 없습니다. 초대 링크로 다시 입장하세요.",
        401,
      );
    return token;
  }

  private saveToken(roomId: string, token: string): void {
    localStorage.setItem(tokenKey(roomId), token);
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      response = await fetch("/api" + path, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      // The request never reached (or returned from) the server at all.
      throw new ApiError(
        "CONNECTION_FAILED",
        "서버 응답을 확인할 수 없습니다. 연결을 확인한 뒤 같은 요청을 다시 전송해 주세요.",
        0,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      // L6: the server answered but the body isn't even JSON - distinct
      // from a dropped connection, so it shouldn't look retriable the same way.
      throw new ApiError(
        "INVALID_RESPONSE",
        "서버 응답 형식이 올바르지 않습니다.",
        502,
      );
    }
    if (!response.ok) {
      const error = (result as { error?: Record<string, unknown> } | null)?.error;
      throw new ApiError(
        typeof error?.code === "string" ? error.code : "SERVER_ERROR",
        typeof error?.message === "string" ? error.message : "서버 요청에 실패했습니다.",
        response.status,
        typeof error?.currentRevision === "number" ? error.currentRevision : undefined,
      );
    }
    const parsed = schema.safeParse(result);
    if (!parsed.success)
      // L6: a 200 whose body doesn't match the contract is a server-side
      // bug, not a network failure - surface it distinctly (502) instead of
      // the misleading "offline" CONNECTION_FAILED/status-0.
      throw new ApiError(
        "INVALID_RESPONSE",
        "서버 응답 형식이 올바르지 않습니다.",
        502,
      );
    return parsed.data;
  }

  async capabilities() {
    return this.request("/capabilities", CapabilitiesSchema);
  }

  async createRoom(input: CreateRoom) {
    const result = await this.request("/rooms", CreateOrJoinResponseSchema, {
      body: input,
    });
    this.saveToken(result.entry.snapshot.roomId, result.playerToken);
    return result.entry;
  }

  async joinRoom(input: JoinRoom) {
    const result = await this.request("/join", CreateOrJoinResponseSchema, {
      body: input,
    });
    this.saveToken(result.entry.snapshot.roomId, result.playerToken);
    return result.entry;
  }

  async snapshot(roomId: string) {
    return this.request(`/rooms/${roomId}`, SnapshotSchema, {
      token: this.tokenFor(roomId),
    });
  }

  async command(roomId: string, input: Envelope) {
    return this.request(`/rooms/${roomId}/commands`, SnapshotSchema, {
      body: input,
      token: this.tokenFor(roomId),
    });
  }

  async invite(roomId: string) {
    const result = await this.request(
      `/rooms/${roomId}/invite`,
      z.object({ inviteToken: z.string() }),
      { token: this.tokenFor(roomId) },
    );
    return result.inviteToken;
  }

  async fillDemoCrew(roomId: string) {
    return this.request(`/rooms/${roomId}/demo-crew`, SnapshotSchema, {
      method: "POST",
      body: {},
      token: this.tokenFor(roomId),
    });
  }

  async leaveRoom(roomId: string): Promise<void> {
    const token = this.tokenFor(roomId);
    await this.request(`/rooms/${roomId}/leave`, z.object({ ok: z.literal(true) }), {
      method: "POST",
      body: {},
      token,
    });
    localStorage.removeItem(tokenKey(roomId));
  }

  subscribe(
    roomId: string,
    onRevision: (revision: number) => void,
    onConnection: (connection: Connection) => void,
  ): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const backoffMs = () => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);

    const pullLatest = () => {
      this.snapshot(roomId)
        .then((snap) => onRevision(snap.revision))
        .catch(() => {
          // A transient failure here is fine: the next WS message or
          // visibility-driven pull will retry.
        });
    };

    const connect = () => {
      if (stopped) return;
      let token: string;
      try {
        token = this.tokenFor(roomId);
      } catch {
        onConnection("offline");
        return;
      }
      onConnection(attempt === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(wsUrl(roomId));
      socket = ws;
      ws.addEventListener("open", () => {
        if (stopped || socket !== ws) return;
        attempt = 0;
        onConnection("connected");
        // M4: the server never trusts a token in the URL/query string - the
        // first message on the socket authenticates it.
        ws.send(JSON.stringify({ type: "auth", token }));
        pullLatest();
      });
      ws.addEventListener("message", (event) => {
        if (stopped || socket !== ws) return;
        try {
          const data = JSON.parse(String(event.data));
          if (data?.type === "revision" && typeof data.revision === "number")
            onRevision(data.revision);
        } catch {
          // ignore malformed frames
        }
      });
      ws.addEventListener("close", (event) => {
        if (socket === ws) socket = null;
        if (stopped) return;
        // M6: the server closes with 4401 when the token is rejected (or
        // never arrives in time). Retrying the same token would just loop
        // forever, so stop and let the caller re-authenticate (e.g. re-join).
        if ((event as CloseEvent).code === 4401) {
          onConnection("offline");
          return;
        }
        onConnection("reconnecting");
        attempt += 1;
        reconnectTimer = setTimeout(connect, backoffMs());
      });
      ws.addEventListener("error", () => {
        if (socket === ws) ws.close();
      });
    };

    const onVisibility = () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (socket && socket.readyState === WebSocket.OPEN) {
        pullLatest();
        return;
      }
      // M5: only (re)connect when there is truly no socket in flight - a
      // CONNECTING/CLOSING socket already has (or will get) a close handler
      // that reconnects; opening a second one here would leak a duplicate.
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      socket?.close();
    };
  }
}
