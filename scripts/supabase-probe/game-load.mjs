#!/usr/bin/env node
// Game-level load probe: the real crew-api room lifecycle, not a synthetic
// handler. sweep.mjs measures one probe function at k concurrent calls; this
// builds whole rooms of anonymous players and then makes every player of every
// room send set_ready at the same instant - the phase that lost commands to 429
// before the router's request queue (platform issue #61).
//
// Each room's commands serialize on that room's row lock, so the interesting
// number is rooms x players, not a single room's depth.
//
// Env: PROBE_CLIENT_CONFIG (JSON {api_url, anon_key}), PROBE_OUT (result JSON),
//      LOAD_ROOMS (default "1,2,4,8"), LOAD_ROUNDS (default 3),
//      LOAD_PLAYERS (default 5).
import { readFileSync, writeFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(process.env.PROBE_CLIENT_CONFIG, "utf8"));
const roomCounts = (process.env.LOAD_ROOMS ?? "1,2,4,8").split(",").map(Number);
const rounds = Number(process.env.LOAD_ROUNDS ?? 3);
const players = Number(process.env.LOAD_PLAYERS ?? 5);
const FN = `${cfg.api_url}/functions/v1/crew-api`;
const settings = { name: "부하", capacity: players, missionMode: "sequential", startMission: 1 };

async function anonToken() {
  const res = await fetch(`${cfg.api_url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: cfg.anon_key, authorization: `Bearer ${cfg.anon_key}`, "content-type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`anon signup ${res.status}`);
  return json.access_token;
}

async function api(token, route, body) {
  const started = performance.now();
  const res = await fetch(`${FN}?route=${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: cfg.anon_key, authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, ms: performance.now() - started };
}

const cid = () => crypto.randomUUID();
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]);
};

async function buildRoom(index) {
  const tokens = await Promise.all(Array.from({ length: players }, anonToken));
  const created = await api(tokens[0], "/rooms", { commandId: cid(), nickname: `선장${index}`, settings });
  if (created.status !== 201) throw new Error(`create ${created.status}`);
  for (let p = 1; p < players; p++) {
    const joined = await api(tokens[p], "/rooms/join", {
      commandId: cid(), nickname: `대원${p}`, inviteToken: created.json.inviteToken,
    });
    if (![200, 201].includes(joined.status)) throw new Error(`join ${joined.status}`);
  }
  return { roomId: created.json.snapshot.roomId, tokens };
}

const sweeps = {};
for (const count of roomCounts) {
  const runs = [];
  for (let round = 0; round < rounds; round++) {
    const rooms = [];
    for (let i = 0; i < count; i++) rooms.push(await buildRoom(i));
    const revisions = new Map();
    for (const room of rooms) revisions.set(room.roomId, (await api(room.tokens[0], `/rooms/${room.roomId}`)).json.revision);

    const results = [];
    const started = performance.now();
    await Promise.all(rooms.flatMap((room) => room.tokens.map(async (token) => {
      results.push(await api(token, `/rooms/${room.roomId}/commands`, {
        commandId: cid(), expectedRevision: revisions.get(room.roomId), attemptId: null,
        command: { type: "set_ready", ready: true },
      }));
    })));
    const wall = performance.now() - started;

    const status = {};
    for (const r of results) status[r.status] = (status[r.status] ?? 0) + 1;
    // Every player of a room must end on the same revision, or the queue
    // reordered something it should not have.
    let converged = true;
    for (const room of rooms) {
      const views = await Promise.all(room.tokens.map((t) => api(t, `/rooms/${room.roomId}`)));
      const revs = new Set(views.filter((v) => v.status === 200).map((v) => v.json.revision));
      if (revs.size !== 1 || views.some((v) => v.status !== 200)) converged = false;
    }
    runs.push({
      commands: results.length, status, converged,
      wall_ms: Math.round(wall),
      p50_ms: pct(results.map((r) => r.ms), 50),
      p90_ms: pct(results.map((r) => r.ms), 90),
      ok_per_second: Number(((status[200] ?? 0) / (wall / 1000)).toFixed(1)),
    });
    console.log(`rooms ${String(count).padStart(2)} round ${round + 1}: ${JSON.stringify(runs.at(-1))}`);
  }
  sweeps[`${count}_rooms`] = runs;
}

if (process.env.PROBE_OUT) {
  writeFileSync(process.env.PROBE_OUT, JSON.stringify({
    schema_version: 1, kind: "crew-api-game-load", observed_at: new Date().toISOString(),
    api_url: cfg.api_url, players_per_room: players, rounds, sweeps,
  }, null, 2) + "\n");
  console.log(`wrote ${process.env.PROBE_OUT}`);
}
