import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ApiError,
  CapabilitiesSchema,
  CreateRoomSchema,
  EntrySchema,
  EnvelopeSchema,
  JoinRoomSchema,
  SnapshotSchema,
  type CreateRoom,
  type Envelope,
  type GameService,
  type JoinRoom,
} from "../../shared/contracts.ts";
export class SupabaseService implements GameService {
  readonly mode = "supabase";
  private client: SupabaseClient;
  private authPending?: Promise<string>;
  private apiUrl: string;
  constructor(
    private url: string,
    private key: string,
    apiUrl?: string,
  ) {
    if (!url || !key)
      throw new Error(
        "Supabase 연결 모드에는 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY가 필요합니다.",
      );
    this.client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    this.apiUrl = (apiUrl || `${url}/functions/v1/crew-api`).replace(/\/$/, "");
  }
  private async token() {
    if (!this.authPending)
      this.authPending = (async () => {
        const { data, error } = await this.client.auth.getSession();
        if (error) throw error;
        if (data.session) return data.session.access_token;
        const created = await this.client.auth.signInAnonymously();
        if (created.error) throw created.error;
        if (!created.data.session)
          throw new Error("익명 로그인에 실패했습니다.");
        return created.data.session.access_token;
      })().finally(() => {
        this.authPending = undefined;
      });
    return this.authPending;
  }
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    try {
      const token = await this.token();
      const response = await fetch(this.apiUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: this.key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new ApiError(
          result.error?.code ?? "SERVER_ERROR",
          result.error?.message ?? "서버 요청에 실패했습니다.",
          response.status,
          result.error?.currentRevision,
        );
      return schema.parse(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "CONNECTION_FAILED",
        "서버 응답을 확인할 수 없습니다. 연결을 확인한 뒤 같은 요청을 다시 전송해 주세요.",
        0,
      );
    }
  }
  capabilities() {
    return this.request("/capabilities", CapabilitiesSchema);
  }
  createRoom(input: CreateRoom) {
    return this.request("/rooms", EntrySchema, CreateRoomSchema.parse(input));
  }
  joinRoom(input: JoinRoom) {
    return this.request(
      "/rooms/join",
      EntrySchema,
      JoinRoomSchema.parse(input),
    );
  }
  snapshot(id: string) {
    return this.request(`/rooms/${z.uuid().parse(id)}`, SnapshotSchema);
  }
  command(id: string, input: Envelope) {
    return this.request(
      `/rooms/${z.uuid().parse(id)}/commands`,
      SnapshotSchema,
      EnvelopeSchema.parse(input),
    );
  }
  async invite(id: string) {
    return (
      await this.request(
        `/rooms/${z.uuid().parse(id)}/invites`,
        z.object({ inviteToken: z.string() }),
        { commandId: crypto.randomUUID() },
      )
    ).inviteToken;
  }
  subscribe(
    id: string,
    onRevision: Parameters<GameService["subscribe"]>[1],
    onConnection: Parameters<GameService["subscribe"]>[2],
  ) {
    let stopped = false;
    const channel = this.client.channel(`crew-room-${id}`);
    onConnection("connecting");
    void this.token()
      .then(async (token) => {
        if (stopped) return;
        await this.client.realtime.setAuth(token);
        if (stopped) return;
        channel
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "room_versions",
              filter: `room_id=eq.${id}`,
            },
            (payload) => onRevision(Number(payload.new.revision)),
          )
          .subscribe((status) => {
            if (!stopped)
              onConnection(
                status === "SUBSCRIBED"
                  ? "connected"
                  : status === "CLOSED"
                    ? "offline"
                    : "reconnecting",
              );
          });
      })
      .catch(() => {
        if (!stopped) onConnection("offline");
      });
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session && !stopped)
        void this.client.realtime.setAuth(session.access_token);
    });
    return () => {
      stopped = true;
      data.subscription.unsubscribe();
      void this.client.removeChannel(channel);
    };
  }
}
