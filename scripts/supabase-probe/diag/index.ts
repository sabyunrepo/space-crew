// Stage-by-stage diagnosis for crew-probe 502s. Functions logs are disabled on
// this platform, so every stage reports its own error name/message instead.
// No static imports: a module-evaluation failure would only surface as a 502.

type Stage = { stage: string; ok: boolean; ms: number; detail?: unknown };

async function run(stage: string, fn: () => Promise<unknown>): Promise<Stage> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    return { stage, ok: true, ms: performance.now() - t0, detail };
  } catch (e) {
    const err = e as Error;
    // Error text never contains the DB URL: it is not passed to any message below.
    return { stage, ok: false, ms: performance.now() - t0, detail: `${err?.name}: ${String(err?.message).slice(0, 300)}` };
  }
}

Deno.serve(async () => {
  const stages: Stage[] = [];
  const dbUrl = Deno.env.get("SUPABASE_DB_URL") ?? "";
  stages.push(await run("env", async () => ({
    has_db_url: dbUrl.length > 0,
    has_service_role: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    deno: Deno.version?.deno,
  })));
  stages.push(await run("db_url_shape", async () => {
    const u = new URL(dbUrl);
    return { protocol: u.protocol, host: u.hostname, port: u.port || "5432", user: u.username, db: u.pathname };
  }));
  stages.push(await run("tcp_connect", async () => {
    const u = new URL(dbUrl);
    const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port || 5432) });
    conn.close();
    return "connected";
  }));
  stages.push(await run("node_buffer", async () => {
    const m = await import("node:buffer");
    return typeof m.Buffer;
  }));
  stages.push(await run("node_process", async () => {
    const m = await import("node:process");
    return typeof m.default;
  }));
  stages.push(await run("globals", async () => {
    const g = globalThis as Record<string, unknown>;
    return { Buffer: typeof g.Buffer, process: typeof g.process };
  }));
  stages.push(await run("import_postgres", async () => {
    const m = await import("./vendor/postgres.js");
    return typeof m.default;
  }));
  stages.push(await run("postgres_query", async () => {
    const { default: postgres } = await import("./vendor/postgres.js");
    const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 1, connect_timeout: 5, ssl: false });
    try {
      const rows = await sql`select current_user as u, version() as v`;
      return rows[0];
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }));
  return new Response(JSON.stringify({ stages }), { headers: { "content-type": "application/json" } });
});
