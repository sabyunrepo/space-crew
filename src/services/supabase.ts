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
  type Snapshot,
} from "../../shared/contracts.ts";

/** Statuses worth retrying the exact same commandId+body for: the request
 * either never reached the function (network/connection failure, status 0),
 * hit the platform's per-project concurrency gate (429), or the function
 * container was killed/timed out before committing (503/504) - see
 * claudedocs/SUPABASE-BPRIME-PROBE.ko.md. Anything else (4xx business
 * errors, REVISION_CONFLICT) is not retried here. */
const RETRYABLE_STATUSES = new Set([0, 429, 503, 504]);
const MAX_COMMAND_ATTEMPTS = 5;
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 4000;

function jitteredBackoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt) * (0.5 + Math.random());
}

export class SupabaseService implements GameService {
  readonly mode = "supabase";
  private client: SupabaseClient;
  private authPending?: Promise<string>;
  private apiUrl: string;
  /** Per-room snapshot cache, kept fresh by the private-broadcast subscription
   * in subscribe(). A cache hit lets snapshot() skip the network entirely
   * right after an onRevision callback - see docs/API.ko.md. */
  private cache = new Map<string, Snapshot>();

  constructor(
    private url: string,
    private key: string,
    apiUrl?: string,
    private projectId?: string,
  ) {
    if (!url || !key)
      throw new Error(
        "Supabase 연결 모드에는 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY가 필요합니다.",
      );
    if (!projectId)
      throw new Error("Supabase 연결 모드에는 VITE_SUPABASE_PROJECT_ID가 필요합니다.");
    this.client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    this.apiUrl = (apiUrl || `${url}/functions/v1/crew-api`).replace(/\/$/, "");
  }

  private async token(): Promise<string> {
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

  private async userId(): Promise<string> {
    await this.token();
    const { data } = await this.client.auth.getSession();
    if (!data.session) throw new Error("익명 로그인에 실패했습니다.");
    return data.session.user.id;
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

  /** Retries an unresolved command with the exact same commandId/body -
   * never a new one - so a resend after a dropped 503/504/network response
   * is idempotent server-side instead of double-applying. */
  private async withCommandRetry<T>(attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < MAX_COMMAND_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        if (!(error instanceof ApiError) || !RETRYABLE_STATUSES.has(error.status)) throw error;
        if (i === MAX_COMMAND_ATTEMPTS - 1) break;
        await new Promise((resolve) => setTimeout(resolve, jitteredBackoff(i)));
      }
    }
    throw lastError;
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
  /** The GameService contract: returns the cached snapshot from the private
   * broadcast subscription when one is available (no network round trip),
   * otherwise fetches and caches it. Callers that need the true latest state
   * regardless of cache (e.g. after a REVISION_CONFLICT) still get it almost
   * always, since the broadcast for a committed command arrives to this
   * client at essentially the same time as the HTTP response that reported
   * the conflict; a stale cache only costs one extra round trip, never a
   * wrong result, because the server re-validates expectedRevision either way. */
  async snapshot(id: string): Promise<Snapshot> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    return this.fetchSnapshot(id);
  }
  private async fetchSnapshot(id: string): Promise<Snapshot> {
    const snap = await this.request(`/rooms/${z.uuid().parse(id)}`, SnapshotSchema);
    this.cacheIfNewer(snap);
    return snap;
  }
  private cacheIfNewer(snap: Snapshot): void {
    const cached = this.cache.get(snap.roomId);
    if (!cached || snap.revision >= cached.revision) this.cache.set(snap.roomId, snap);
  }
  command(id: string, input: Envelope) {
    return this.withCommandRetry(async () => {
      const snap = await this.request(
        `/rooms/${z.uuid().parse(id)}/commands`,
        SnapshotSchema,
        EnvelopeSchema.parse(input),
      );
      this.cacheIfNewer(snap);
      return snap;
    });
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
  async leaveRoom(id: string): Promise<void> {
    await this.request(`/rooms/${z.uuid().parse(id)}/leave`, z.object({ ok: z.literal(true) }), {});
    this.cache.delete(id);
  }
  subscribe(
    id: string,
    onRevision: Parameters<GameService["subscribe"]>[1],
    onConnection: Parameters<GameService["subscribe"]>[2],
  ) {
    let stopped = false;
    let channel: ReturnType<SupabaseClient["channel"]> | null = null;
    let wasConnected = false;
    onConnection("connecting");

    const resync = () => {
      this.fetchSnapshot(id)
        .then((snap) => { if (!stopped) onRevision(snap.revision); })
        .catch(() => {
          // A transient failure here is fine: the next broadcast, poll or
          // visibility-driven refresh will retry.
        });
    };

    void (async () => {
      try {
        const token = await this.token();
        const uid = await this.userId();
        if (stopped) return;
        await this.client.realtime.setAuth(token);
        if (stopped) return;
        // own-user-v1: the platform only authorizes a private channel whose
        // topic is exactly sbp:<project uuid>:<auth uid> for that user.
        const topic = `sbp:${this.projectId}:${uid}`;
        channel = this.client.channel(topic, { config: { private: true } });
        channel
          .on("broadcast", { event: "snapshot" }, (message) => {
            const payload = message.payload as Snapshot | undefined;
            if (!payload || payload.roomId !== id) return;
            const cached = this.cache.get(id);
            if (cached && payload.revision <= cached.revision) return;
            this.cache.set(id, payload);
            onRevision(payload.revision);
          })
          .subscribe((status) => {
            if (stopped) return;
            if (status === "SUBSCRIBED") {
              onConnection("connected");
              // A reconnect may have missed broadcasts sent while offline -
              // a private channel never replays history, so re-fetch.
              if (wasConnected) resync();
              wasConnected = true;
            } else if (status === "CLOSED") {
              onConnection("offline");
            } else {
              onConnection("reconnecting");
            }
          });
      } catch {
        if (!stopped) onConnection("offline");
      }
    })();

    const { data: authListener } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session && !stopped) void this.client.realtime.setAuth(session.access_token);
    });

    return () => {
      stopped = true;
      authListener.subscription.unsubscribe();
      if (channel) void this.client.removeChannel(channel);
    };
  }
}
