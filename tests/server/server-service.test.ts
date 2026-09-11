import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulates browser globals to exercise ServerService.subscribe()/request()
// without a real network or WebSocket - a fake WebSocket class is injected
// as globalThis.WebSocket, per the review's guidance for this file's tests.
type Listener = (ev: any) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  static instances: FakeWebSocket[] = [];
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    const list = this.listeners[type];
    if (!list) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }
  emit(type: string, ev: any = {}) {
    for (const listener of this.listeners[type] ?? []) listener(ev);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }
  close(code = 1000) {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
  }
  finishClose(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }
}

const docListeners: Listener[] = [];
let localStorageStore: Map<string, string>;
let fetchImpl: (...args: any[]) => Promise<any>;

function installBrowserGlobals() {
  FakeWebSocket.instances = [];
  docListeners.length = 0;
  localStorageStore = new Map([["crew.server.v1.token.room-1", "tok"]]);
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
    location: { protocol: "https:", host: "crew.example" },
    localStorage: {
      getItem: (k: string) => localStorageStore.get(k) ?? null,
      setItem: (k: string, v: string) => localStorageStore.set(k, v),
    },
    document: {
      visibilityState: "visible",
      addEventListener: (_: string, l: Listener) => docListeners.push(l),
      removeEventListener: (_: string, l: Listener) => {
        const i = docListeners.indexOf(l);
        if (i >= 0) docListeners.splice(i, 1);
      },
    },
    fetch: (...args: any[]) => fetchImpl(...args),
  });
}

const fireVisibility = () => docListeners.slice().forEach((l) => l({}));

describe("ServerService (fake WebSocket)", () => {
  let ServerService: typeof import("../../src/services/server.ts").ServerService;

  beforeEach(async () => {
    installBrowserGlobals();
    vi.resetModules();
    ({ ServerService } = await import("../../src/services/server.ts"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("M4: sends an auth message on open and puts no token in the WS URL", () => {
    const svc = new ServerService();
    const unsub = svc.subscribe(
      "room-1",
      () => {},
      () => {},
    );
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).not.toContain("tok");
    expect(ws.url).not.toContain("token=");
    ws.open();
    expect(ws.sent).toEqual([JSON.stringify({ type: "auth", token: "tok" })]);
    unsub();
  });

  it("M5: visibilitychange while CONNECTING does not open a second socket, and unsubscribe silences further revisions", () => {
    const svc = new ServerService();
    let revCalls = 0;
    const unsub = svc.subscribe(
      "room-1",
      () => revCalls++,
      () => {},
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    fireVisibility(); // socket is still CONNECTING - must not create a second one
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].open();
    unsub();
    FakeWebSocket.instances[0].emit("message", {
      data: JSON.stringify({ type: "revision", revision: 9 }),
    });
    expect(revCalls).toBe(0);
  });

  it("M6: a 4401 close stops reconnecting and reports the connection as offline", async () => {
    vi.useFakeTimers();
    const svc = new ServerService();
    const connections: string[] = [];
    const unsub = svc.subscribe(
      "room-1",
      () => {},
      (c) => connections.push(c),
    );
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.finishClose(4401);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt
    expect(connections.at(-1)).toBe("offline");
    unsub();
  });

  it("reconnects with backoff on an ordinary close (not 4401)", async () => {
    vi.useFakeTimers();
    const svc = new ServerService();
    const unsub = svc.subscribe(
      "room-1",
      () => {},
      () => {},
    );
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.finishClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    unsub();
  });

  it("L6: a 200 response with an invalid schema is reported as INVALID_RESPONSE (502), not CONNECTION_FAILED", async () => {
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nonsense: true }),
    });
    const svc = new ServerService();
    await expect(svc.capabilities()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 502,
    });
  });

  it("reports CONNECTION_FAILED (status 0) when the network request itself fails", async () => {
    fetchImpl = async () => {
      throw new TypeError("network down");
    };
    const svc = new ServerService();
    await expect(svc.capabilities()).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
      status: 0,
    });
  });
});
