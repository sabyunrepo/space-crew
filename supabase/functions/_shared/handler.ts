import { z } from "zod";
import {
  ApiError,
  CapabilitiesSchema,
  CreateRoomSchema,
  EnvelopeSchema,
  JoinRoomSchema,
  EntrySchema,
  SnapshotSchema,
  type CreateRoom,
  type Envelope,
  type JoinRoom,
  type Snapshot,
} from "./contracts.ts";
import missions from "./missions.ts";
// A repository method must perform authentication binding, authorization and a SINGLE DB transaction.
// Implement with a dedicated DB login that SET ROLE crew_server. Never expose the DB password to Vite.
export interface CrewRepository {
  ready: boolean;
  create(
    actorAuthId: string,
    input: CreateRoom,
  ): Promise<z.infer<typeof EntrySchema>>;
  join(
    actorAuthId: string,
    input: JoinRoom,
  ): Promise<z.infer<typeof EntrySchema>>;
  snapshot(actorAuthId: string, roomId: string): Promise<Snapshot>;
  command(
    actorAuthId: string,
    roomId: string,
    input: Envelope,
  ): Promise<Snapshot>;
  invite(
    actorAuthId: string,
    roomId: string,
    commandId: string,
  ): Promise<{ inviteToken: string }>;
  leave(actorAuthId: string, roomId: string): Promise<void>;
}
export class PendingRepository implements CrewRepository {
  readonly ready = false;
  private unavailable(): never {
    throw new ApiError(
      "BACKEND_NOT_IMPLEMENTED",
      "서버 트랜잭션과 미션 엔진 연결이 아직 구현되지 않았습니다.",
      501,
    );
  }
  async create(
    _actor: string,
    _input: CreateRoom,
  ): Promise<z.infer<typeof EntrySchema>> {
    return this.unavailable();
  }
  async join(
    _actor: string,
    _input: JoinRoom,
  ): Promise<z.infer<typeof EntrySchema>> {
    return this.unavailable();
  }
  async snapshot(_actor: string, _roomId: string): Promise<Snapshot> {
    return this.unavailable();
  }
  async command(
    _actor: string,
    _roomId: string,
    _input: Envelope,
  ): Promise<Snapshot> {
    return this.unavailable();
  }
  async invite(
    _actor: string,
    _roomId: string,
    _commandId: string,
  ): Promise<{ inviteToken: string }> {
    return this.unavailable();
  }
  async leave(_actor: string, _roomId: string): Promise<void> {
    return this.unavailable();
  }
}
async function jsonBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(
      "INVALID_CONTENT_TYPE",
      "application/json이 필요합니다.",
      415,
    );
  if (Number(request.headers.get("content-length")) > 32768)
    throw new ApiError("PAYLOAD_TOO_LARGE", "요청이 너무 큽니다.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("INVALID_JSON", "JSON 본문이 필요합니다.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new ApiError("PAYLOAD_TOO_LARGE", "요청이 너무 큽니다.", 413);
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("INVALID_JSON", "올바른 JSON 본문이 필요합니다.");
  }
}
export function createHandler(options: {
  repository: CrewRepository;
  authenticate: (token: string) => Promise<string | null>;
  allowedOrigins: string[];
  playableMissionIds?: number[];
  rulesetVersion?: string;
}) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get("origin");
    const allowed = !origin || options.allowedOrigins.includes(origin);
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      Vary: "Origin",
    });
    if (origin && allowed) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization, apikey, content-type, x-client-info",
      );
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (!allowed)
        throw new ApiError(
          "ORIGIN_DENIED",
          "허용되지 않은 프론트 도메인입니다.",
          403,
        );
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const token = /^Bearer (.+)$/i.exec(
        request.headers.get("authorization") || "",
      )?.[1];
      if (!token)
        throw new ApiError("UNAUTHENTICATED", "로그인이 필요합니다.", 401);
      const actor = await options.authenticate(token);
      if (!actor || !z.uuid().safeParse(actor).success)
        throw new ApiError(
          "UNAUTHENTICATED",
          "유효한 로그인 세션이 아닙니다.",
          401,
        );
      const path =
        new URL(request.url).pathname
          .replace(/^\/functions\/v1\/crew-api(?=\/|$)/, "")
          .replace(/^\/crew-api(?=\/|$)/, "")
          .replace(/\/$/, "") || "/";
      const repo = options.repository;
      if (path === "/capabilities" && request.method === "GET")
        return reply(
          CapabilitiesSchema.parse({
            apiVersion: "1",
            backendReady: repo.ready,
            rulesetVersion: options.rulesetVersion ?? "crew-p9-server-pending",
            missions: missions.map((m) => ({
              ...m,
              playable:
                repo.ready && (options.playableMissionIds ?? []).includes(m.id),
            })),
          }),
        );
      if (path === "/rooms" && request.method === "POST")
        return reply(
          EntrySchema.parse(
            await repo.create(
              actor,
              CreateRoomSchema.parse(await jsonBody(request)),
            ),
          ),
          201,
        );
      if (path === "/rooms/join" && request.method === "POST")
        return reply(
          EntrySchema.parse(
            await repo.join(
              actor,
              JoinRoomSchema.parse(await jsonBody(request)),
            ),
          ),
        );
      const match = /^\/rooms\/([^/]+)(?:\/(commands|invites|leave))?$/.exec(path);
      if (!match) throw new ApiError("NOT_FOUND", "요청 경로가 없습니다.", 404);
      const roomId = z.uuid().parse(match[1]);
      if (!match[2] && request.method === "GET")
        return reply(SnapshotSchema.parse(await repo.snapshot(actor, roomId)));
      if (match[2] === "commands" && request.method === "POST")
        return reply(
          SnapshotSchema.parse(
            await repo.command(
              actor,
              roomId,
              EnvelopeSchema.parse(await jsonBody(request)),
            ),
          ),
        );
      if (match[2] === "leave" && request.method === "POST") {
        await repo.leave(actor, roomId);
        return reply({ ok: true });
      }
      if (match[2] === "invites" && request.method === "POST") {
        const input = z
          .object({ commandId: z.uuid() })
          .strict()
          .parse(await jsonBody(request));
        return reply(
          z
            .object({ inviteToken: z.string().min(20).max(256) })
            .parse(await repo.invite(actor, roomId, input.commandId)),
          201,
        );
      }
      throw new ApiError(
        "METHOD_NOT_ALLOWED",
        "지원하지 않는 HTTP 메서드입니다.",
        405,
      );
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "요청 또는 응답이 API 계약과 일치하지 않습니다.",
              requestId,
            },
          },
          400,
        );
      if (error instanceof ApiError)
        return reply(
          {
            error: {
              code: error.code,
              message: error.message,
              requestId,
              ...(error.currentRevision === undefined
                ? {}
                : { currentRevision: error.currentRevision }),
            },
          },
          error.status,
        );
      // Never log JWTs, invite tokens or private hands.
      return reply(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "서버 처리 중 오류가 발생했습니다.",
            requestId,
          },
        },
        500,
      );
    }
  };
}
