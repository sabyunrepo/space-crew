#!/usr/bin/env node
// Compares end-to-end latency of the multiplayer crew-api game API through
// its two paths, from this machine, using identical scenarios with fresh
// users/rooms per path:
//   OLD - Supabase Edge Function:  ${api_url}/functions/v1/crew-api?route=<path>
//   NEW - same-origin Node server: https://crew.bsh00.com/api/crew?route=<path>
// Both talk to the same Postgres database and accept the same user JWTs.
//
// Config: ~/.sbp/crew-queue-20260920/client-config.json ({api_url, anon_key},
// searched recursively since key nesting may vary). Never prints the anon key
// or any access token.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".sbp/crew-queue-20260920/client-config.json");
const NEW_ORIGIN = "https://crew.bsh00.com";
const RESULT_OUT =
  "/private/tmp/claude-501/-Users-byeonsanghun-goinfre-mission/56baa817-f222-4192-b662-035ed06da600/scratchpad/path-compare-result.json";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 crew-probe/1.0";

function findKey(obj, pattern) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (pattern.test(k) && typeof v === "string") return v;
  }
  for (const v of Object.values(obj)) {
    const found = findKey(v, pattern);
    if (found !== undefined) return found;
  }
  return undefined;
}

const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const apiUrl = findKey(rawConfig, /^api[_-]?url$/i) ?? findKey(rawConfig, /url/i);
const anonKey = findKey(rawConfig, /anon[_-]?key/i) ?? findKey(rawConfig, /key/i);
if (!apiUrl || !anonKey) {
  console.error("client-config.json에서 api_url/anon_key를 찾지 못했습니다.");
  process.exit(1);
}

const cid = () => crypto.randomUUID();
const pct = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]);
};

async function timedFetch(url, opts) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, ms: performance.now() - t0 };
  } catch (error) {
    return { status: 0, json: { error: { code: "FETCH_FAILED", message: String(error?.message ?? error) } }, ms: performance.now() - t0 };
  }
}

async function anonToken() {
  const res = await timedFetch(`${apiUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ data: {} }),
  });
  if (!res.json?.access_token) throw new Error(`anon signup failed: status=${res.status}`);
  return res.json.access_token;
}

function oldApi(token, route, method, body) {
  return timedFetch(`${apiUrl}/functions/v1/crew-api?route=${route}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function newApi(token, route, method, body) {
  return timedFetch(`${NEW_ORIGIN}/api/crew?route=${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: NEW_ORIGIN,
      "User-Agent": UA,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const settings = { name: "perf-compare", capacity: 3, missionMode: "sequential", startMission: 1 };

async function buildRoom(apiFn, label) {
  const tokens = [];
  for (let i = 0; i < 3; i++) tokens.push(await anonToken());
  const created = await apiFn(tokens[0], "/rooms", "POST", {
    commandId: cid(),
    nickname: "host",
    settings,
  });
  if (created.status !== 201) {
    throw new Error(
      `[${label}] room create failed: status=${created.status} body=${JSON.stringify(created.json).slice(0, 300)}`,
    );
  }
  const roomId = created.json.snapshot.roomId;
  const inviteToken = created.json.inviteToken;
  for (let p = 1; p < 3; p++) {
    const joined = await apiFn(tokens[p], "/rooms/join", "POST", {
      commandId: cid(),
      nickname: `guest${p}`,
      inviteToken,
    });
    if (![200, 201].includes(joined.status)) {
      throw new Error(
        `[${label}] join failed: status=${joined.status} body=${JSON.stringify(joined.json).slice(0, 300)}`,
      );
    }
  }
  return { tokens, roomId, revision: created.json.snapshot.revision };
}

// metric buckets: { old: {samples:[{ms,status}]}, new: {...} }
const metrics = {
  snapshot: { old: [], new: [] },
  command: { old: [], new: [] },
  storm: { old: [], new: [] },
  baseline: { old: [], new: [] },
};
let oldRequestCount = 0;
let newRequestCount = 0;

async function runSnapshotBlock(apiFn, ctx, bucket) {
  for (let i = 0; i < 60; i++) {
    const token = ctx.tokens[i % 3];
    const r = await apiFn(token, `/rooms/${ctx.roomId}`, "GET");
    bucket.push({ ms: r.ms, status: r.status });
    if (r.status === 200) ctx.revision = r.json.revision;
  }
}

async function runCommandBlock(apiFn, ctx, bucket) {
  let conflicts = 0;
  for (let i = 0; i < 60; i++) {
    const token = ctx.tokens[i % 3];
    const ready = i % 2 === 0;
    const r = await apiFn(token, `/rooms/${ctx.roomId}/commands`, "POST", {
      commandId: cid(),
      expectedRevision: ctx.revision,
      attemptId: null,
      command: { type: "set_ready", ready },
    });
    bucket.push({ ms: r.ms, status: r.status });
    if (r.status === 200) {
      ctx.revision = r.json.revision;
    } else {
      if (r.json?.error?.code === "REVISION_CONFLICT") conflicts++;
      // resync (untimed) so the sequence doesn't cascade-fail
      const resync = await apiFn(token, `/rooms/${ctx.roomId}`, "GET");
      if (resync.status === 200) ctx.revision = resync.json.revision;
    }
  }
  return conflicts;
}

async function runStormBlock(apiFn, ctx, bucket) {
  for (let round = 0; round < 15; round++) {
    const expectedRevision = ctx.revision;
    const results = await Promise.all(
      ctx.tokens.map((token) =>
        apiFn(token, `/rooms/${ctx.roomId}/commands`, "POST", {
          commandId: cid(),
          expectedRevision,
          attemptId: null,
          command: { type: "set_ready", ready: round % 2 === 0 },
        }),
      ),
    );
    for (const r of results) bucket.push({ ms: r.ms, status: r.status });
    const resync = await apiFn(ctx.tokens[0], `/rooms/${ctx.roomId}`, "GET");
    if (resync.status === 200) ctx.revision = resync.json.revision;
  }
}

async function main() {
  console.log("설정: 신규 사용자 3명씩으로 OLD/NEW 방 생성 중...");
  const oldCtx = await buildRoom(oldApi, "OLD");
  const newCtx = await buildRoom(newApi, "NEW");
  console.log(`OLD room=${oldCtx.roomId} NEW room=${newCtx.roomId}`);

  // untimed warm requests so TLS setup isn't counted
  await oldApi(oldCtx.tokens[0], `/rooms/${oldCtx.roomId}`, "GET");
  await oldApi(oldCtx.tokens[0], `/rooms/${oldCtx.roomId}`, "GET");
  await newApi(newCtx.tokens[0], `/rooms/${newCtx.roomId}`, "GET");
  await newApi(newCtx.tokens[0], `/rooms/${newCtx.roomId}`, "GET");

  console.log("워밍업 (5회씩, 폐기)...");
  for (let i = 0; i < 5; i++) await oldApi(oldCtx.tokens[i % 3], `/rooms/${oldCtx.roomId}`, "GET");
  for (let i = 0; i < 5; i++) await newApi(newCtx.tokens[i % 3], `/rooms/${newCtx.roomId}`, "GET");

  console.log("snapshot 블록 (OLD 60 -> NEW 60)...");
  await runSnapshotBlock(oldApi, oldCtx, metrics.snapshot.old);
  await runSnapshotBlock(newApi, newCtx, metrics.snapshot.new);

  console.log("command 블록 (OLD 60 -> NEW 60)...");
  const oldConflicts = await runCommandBlock(oldApi, oldCtx, metrics.command.old);
  const newConflicts = await runCommandBlock(newApi, newCtx, metrics.command.new);

  console.log("storm 블록 (OLD 15라운드 -> NEW 15라운드)...");
  await runStormBlock(oldApi, oldCtx, metrics.storm.old);
  await runStormBlock(newApi, newCtx, metrics.storm.new);

  console.log("baseline 블록 (OLD auth/v1/settings 30 -> NEW /healthz 30)...");
  for (let i = 0; i < 30; i++) {
    const r = await timedFetch(`${apiUrl}/auth/v1/settings`, {
      headers: { apikey: anonKey, "User-Agent": UA },
    });
    metrics.baseline.old.push({ ms: r.ms, status: r.status });
  }
  for (let i = 0; i < 30; i++) {
    const r = await timedFetch(`${NEW_ORIGIN}/healthz`, { headers: { "User-Agent": UA } });
    metrics.baseline.new.push({ ms: r.ms, status: r.status });
  }

  for (const m of Object.values(metrics)) {
    oldRequestCount += m.old.length;
    newRequestCount += m.new.length;
  }

  const summary = {};
  for (const [name, { old: oldSamples, new: newSamples }] of Object.entries(metrics)) {
    const statusCounts = (samples) => {
      const c = {};
      for (const s of samples) if (s.status < 200 || s.status >= 300) c[s.status] = (c[s.status] ?? 0) + 1;
      return c;
    };
    const oldMs = oldSamples.map((s) => s.ms);
    const newMs = newSamples.map((s) => s.ms);
    summary[name] = {
      old: { p50: pct(oldMs, 50), p90: pct(oldMs, 90), p99: pct(oldMs, 99), max: Math.round(Math.max(...oldMs)), count: oldMs.length, nonOk: statusCounts(oldSamples) },
      new: { p50: pct(newMs, 50), p90: pct(newMs, 90), p99: pct(newMs, 99), max: Math.round(Math.max(...newMs)), count: newMs.length, nonOk: statusCounts(newSamples) },
    };
    summary[name].diffP50 = summary[name].new.p50 - summary[name].old.p50;
  }

  console.log("\n=== 결과 (ms) ===");
  console.log(
    "metric".padEnd(10),
    "side".padEnd(5),
    "p50".padStart(6),
    "p90".padStart(6),
    "p99".padStart(6),
    "max".padStart(6),
    "count".padStart(6),
    "non-2xx",
  );
  for (const [name, s] of Object.entries(summary)) {
    for (const side of ["old", "new"]) {
      console.log(
        name.padEnd(10),
        side.padEnd(5),
        String(s[side].p50).padStart(6),
        String(s[side].p90).padStart(6),
        String(s[side].p99).padStart(6),
        String(s[side].max).padStart(6),
        String(s[side].count).padStart(6),
        JSON.stringify(s[side].nonOk),
      );
    }
    console.log(`  NEW-OLD diff at p50: ${s.diffP50} ms`);
  }
  console.log(`\nOLD 요청 수(측정 구간): ${oldRequestCount}, NEW 요청 수(측정 구간): ${newRequestCount}`);
  console.log(`command 단계 REVISION_CONFLICT 재조회 횟수: OLD=${oldConflicts} NEW=${newConflicts}`);

  writeFileSync(
    RESULT_OUT,
    JSON.stringify(
      {
        schema_version: 1,
        kind: "old-vs-new-path-compare",
        observed_at: new Date().toISOString(),
        old_request_count: oldRequestCount,
        new_request_count: newRequestCount,
        command_revision_conflicts: { old: oldConflicts, new: newConflicts },
        summary,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`결과 JSON 기록: ${RESULT_OUT}`);
}

main().catch((error) => {
  console.error("측정 실패:", error?.message ?? error);
  process.exit(1);
});
