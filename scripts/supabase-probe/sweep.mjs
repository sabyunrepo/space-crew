#!/usr/bin/env node
// Concurrency sweep for crew-probe: k simultaneous cmd calls per round, k=1..4.
// Used to compare the Functions runtime before/after a platform change.
//
// Env: PROBE_CLIENT_CONFIG (JSON {api_url, anon_key}), PROBE_OUT (result JSON),
//      SWEEP_LEVELS (default "1,2,3,4"), SWEEP_ROUNDS (default 15).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const cfg = JSON.parse(readFileSync(process.env.PROBE_CLIENT_CONFIG, "utf8"));
const levels = (process.env.SWEEP_LEVELS ?? "1,2,3,4").split(",").map(Number);
const rounds = Number(process.env.SWEEP_ROUNDS ?? 15);

const users = [];
for (let i = 0; i < Math.max(...levels); i++) {
  const client = createClient(cfg.api_url, cfg.anon_key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  users.push({ token: data.session.access_token, uid: data.user.id });
}

async function call(user, room) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${cfg.api_url}/functions/v1/crew-probe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, apikey: cfg.anon_key, "content-type": "application/json" },
      body: JSON.stringify({ op: "cmd", room, players: [user.uid], work_ms: 20 }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON gateway error */ }
    return { status: res.status, rtt: performance.now() - t0, total: json?.timings?.total_ms, connect: json?.timings?.connect_ms, err: json?.error?.message };
  } catch (e) {
    return { status: 0, rtt: performance.now() - t0, err: String(e.cause?.code ?? e.message) };
  }
}

const pct = (values, p) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null;
};

const out = { started_at: new Date().toISOString(), levels: {} };
for (const k of levels) {
  const room = crypto.randomUUID();
  const results = [];
  for (let r = 0; r < rounds; r++) {
    results.push(...(await Promise.all(users.slice(0, k).map((u) => call(u, room)))));
    await new Promise((s) => setTimeout(s, 800));
  }
  const ok = results.filter((x) => x.status === 200);
  const status = {};
  for (const x of results) status[x.status] = (status[x.status] ?? 0) + 1;
  out.levels[k] = {
    status,
    slow_over_2s: results.filter((x) => x.rtt > 2000).length,
    rtt_p50: pct(results.map((x) => x.rtt), 0.5),
    rtt_p90: pct(results.map((x) => x.rtt), 0.9),
    rtt_max: pct(results.map((x) => x.rtt), 1),
    server_total_p50: pct(ok.map((x) => x.total), 0.5),
    server_total_max: pct(ok.map((x) => x.total), 1),
    connect_p50: pct(ok.map((x) => x.connect), 0.5),
    connect_max: pct(ok.map((x) => x.connect), 1),
    errors: [...new Set(results.filter((x) => x.err).map((x) => x.err))],
  };
  console.log(`동시 ${k}개`, JSON.stringify(out.levels[k]));
}
writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 1));
