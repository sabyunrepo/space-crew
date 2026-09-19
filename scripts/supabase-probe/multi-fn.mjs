#!/usr/bin/env node
// Multi-function memory probe for worker reuse: every function gets its own
// reused worker, so idle workers from many functions may pile up.
// Env: PROBE_CLIENT_CONFIG, PROBE_OUT, MULTI_FN_NAMES (comma list), MULTI_FN_SECONDS (default 90).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const cfg = JSON.parse(readFileSync(process.env.PROBE_CLIENT_CONFIG, "utf8"));
const names = (process.env.MULTI_FN_NAMES ?? "fn-a,fn-b,fn-c,fn-d,fn-e,fn-f,fn-g,fn-h").split(",");
const seconds = Number(process.env.MULTI_FN_SECONDS ?? 90);
const client = createClient(cfg.api_url, cfg.anon_key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await client.auth.signInAnonymously();
if (error) throw error;

async function call(name) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${cfg.api_url}/functions/v1/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: cfg.anon_key, "content-type": "application/json" },
      body: JSON.stringify({ op: "diag" }),
      signal: AbortSignal.timeout(20000),
    });
    await res.text();
    return { name, status: res.status, rtt: Math.round(performance.now() - t0), at: new Date().toISOString() };
  } catch (e) {
    return { name, status: 0, rtt: Math.round(performance.now() - t0), err: String(e.cause?.code ?? e.name), at: new Date().toISOString() };
  }
}

const log = [];
// Phase 1: touch every function once, one after another.
for (const name of names) log.push({ phase: "sequential", ...(await call(name)) });
// Phase 2: waves of 4 simultaneous calls to different functions, rotating.
const end = Date.now() + seconds * 1000;
let offset = 0;
while (Date.now() < end) {
  const wave = [0, 1, 2, 3].map((i) => names[(offset + i) % names.length]);
  offset += 4;
  log.push(...(await Promise.all(wave.map(call))).map((r) => ({ phase: "waves", ...r })));
  await new Promise((s) => setTimeout(s, 500));
}
const status = {};
for (const r of log) status[`${r.phase}:${r.status}`] = (status[`${r.phase}:${r.status}`] ?? 0) + 1;
const slow = log.filter((r) => r.rtt > 2000).length;
console.log(JSON.stringify({ status, slow_over_2s: slow, calls: log.length }));
writeFileSync(process.env.PROBE_OUT, JSON.stringify({ names, seconds, status, slow_over_2s: slow, log }, null, 1));
