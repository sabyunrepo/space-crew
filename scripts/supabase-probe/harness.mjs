#!/usr/bin/env node
// Latency/consistency probe for "room-level row-lock transaction + per-user
// private Broadcast" on a self-hosted Supabase stack.
//
// Env:
//   PROBE_CLIENT_CONFIG - path to JSON {project_id, api_url, anon_key}
//   PROBE_OUT           - path to write the result JSON
//   PROBE_ROUNDS        - round count for scenarios C/D (default 10)
//   PROBE_ONLY          - comma list of scenario letters to run, e.g. "F,G"
//                         (login/subscribe/baseline always run; omit to run
//                         the default set A,B,C,D,E,F,G -- G2 is a reference
//                         variant of G and only runs if named explicitly)
//
// Never logs keys or tokens. Run with Node 22+:
//   PROBE_CLIENT_CONFIG=./probe-config.json PROBE_OUT=./probe-result.json \
//     node scripts/supabase-probe/harness.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const NUM_PLAYERS = 5;
const FUNCTION_PATH = "/functions/v1/crew-probe";
const SEQUENTIAL_ROUNDS = 20;
const SEQUENTIAL_GAP_MS = 300;
const ROTATING_ROUNDS = 30;
const ROTATING_GAP_MS = 200;
const BURST_ROUNDS = (() => {
  const v = Number(process.env.PROBE_ROUNDS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
})();
const BURST_GAP_MS = 1000;
const RETRY_MAX_ATTEMPTS = 5; // additional attempts after the first, on 429
const RETRY_JITTER_MIN_MS = 100;
const RETRY_JITTER_MAX_MS = 300;
const SUBSCRIBE_TIMEOUT_MS = 15000;
// F/G/G2: same-command_id resend on 503/504/network-error/429, per the
// idempotency contract (client resends the identical body, server dedupes
// via probe_receipts).
const IDEMPOTENT_RETRY_MAX_ATTEMPTS = 6; // additional attempts after the first
const IDEMPOTENT_RETRY_JITTER_MIN_MS = 300;
const IDEMPOTENT_RETRY_JITTER_MAX_MS = 800;
const SCENARIO_F_ROUNDS = 15;
const SCENARIO_F_CONCURRENCY = 4; // measured 503/504 trigger point
const SCENARIO_G_ROUNDS = 20;
const SCENARIO_G2_ROUNDS = 10;
const SCENARIO_G2_LEADER_WAIT_MS = 1500;
const DEFAULT_SCENARIOS = ["A", "B", "C", "D", "E", "F", "G"]; // G2 is opt-in only
// A commit observed via 503/504/network error can still land on the server
// several seconds after the client gave up (this is the exact bug this
// harness exists to catch). Give any scenario that saw an unknown-outcome
// call this much time to settle before we peek the final revision and move
// on, so we don't misreport a late commit as lost or bleed it into the next
// scenario's room.
const SETTLE_GRACE_MS = 12000;

function nowEpochMs() {
  return performance.timeOrigin + performance.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProbeOnly() {
  const raw = process.env.PROBE_ONLY;
  if (!raw) return new Set(DEFAULT_SCENARIOS);
  const set = new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  return set.size > 0 ? set : new Set(DEFAULT_SCENARIOS);
}

function loadConfig() {
  const configPath = process.env.PROBE_CLIENT_CONFIG;
  const outPath = process.env.PROBE_OUT;
  if (!configPath) throw new Error("PROBE_CLIENT_CONFIG env var is required");
  if (!outPath) throw new Error("PROBE_OUT env var is required");
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  for (const key of ["project_id", "api_url", "anon_key"]) {
    if (!raw[key]) throw new Error(`PROBE_CLIENT_CONFIG missing "${key}"`);
  }
  return { config: raw, outPath };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return { n: 0, p50: null, p90: null, max: null };
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p90: percentile(clean, 90),
    max: clean[clean.length - 1],
  };
}

// ---------------------------------------------------------------------------
// Users: 5 independent anonymous sessions, each subscribed to its own
// private broadcast channel sbp:<project_id>:<uid>.
// ---------------------------------------------------------------------------

async function createUser(config, index) {
  const client = createClient(config.api_url, config.anon_key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.session || !data.user) {
    throw new Error(`player${index} signInAnonymously failed: ${error?.message ?? "no session"}`);
  }
  return {
    index,
    uid: data.user.id,
    token: data.session.access_token,
    client,
    received: [], // { room, revision, recv_epoch_ms, server_commit_epoch, delivery_ms } -- never reset, spans the whole run
    channel: null,
    subscribeStatus: null,
    statusLog: [], // every channel status/system event, including after SUBSCRIBED
  };
}

function subscribeUser(user, projectId) {
  return new Promise((resolve) => {
    user.client.realtime.setAuth(user.token);
    const topic = `sbp:${projectId}:${user.uid}`;
    const channel = user.client.channel(topic, {
      config: { private: true, broadcast: { self: false } },
    });
    channel.on("broadcast", { event: "snapshot" }, (msg) => {
      const recvEpochMs = nowEpochMs();
      const serverCommitEpoch = msg?.payload?.server_commit_epoch ?? null;
      user.received.push({
        room: msg?.payload?.room ?? null,
        revision: msg?.payload?.revision ?? null,
        recv_epoch_ms: recvEpochMs,
        server_commit_epoch: serverCommitEpoch,
        delivery_ms: serverCommitEpoch != null ? recvEpochMs - serverCommitEpoch : null,
      });
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      user.subscribeStatus = "TIMED_OUT";
      resolve(false);
    }, SUBSCRIBE_TIMEOUT_MS);

    channel.on("system", {}, (payload) => {
      user.statusLog.push({ at: nowEpochMs(), system: JSON.stringify(payload).slice(0, 300) });
    });
    channel.subscribe((status, err) => {
      user.statusLog.push({ at: nowEpochMs(), status, err: err ? String(err.message ?? err).slice(0, 300) : null });
      if (settled) return;
      if (status === "SUBSCRIBED") {
        settled = true;
        clearTimeout(timer);
        user.subscribeStatus = "SUBSCRIBED";
        resolve(true);
      } else if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") {
        settled = true;
        clearTimeout(timer);
        user.subscribeStatus = status;
        resolve(false);
      }
    });
    user.channel = channel;
  });
}

// ---------------------------------------------------------------------------
// Function + baseline HTTP calls
// ---------------------------------------------------------------------------

function extractResponseHeaders(headers) {
  const out = {};
  for (const key of ["server", "via", "content-type"]) {
    const v = headers.get(key);
    if (v) out[key] = v;
  }
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase().startsWith("x-sbp-")) out[k] = v;
  }
  return out;
}

async function callProbe(config, token, body) {
  const startEpoch = nowEpochMs();
  const t0 = performance.now();
  let status = 0;
  let json = null;
  let networkError = null;
  let bodyTextHead = null;
  let responseHeaders = {};
  try {
    const res = await fetch(config.api_url + FUNCTION_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: config.anon_key,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      // Surface a hung request as an error instead of stalling the whole run.
      signal: AbortSignal.timeout(20000),
    });
    status = res.status;
    responseHeaders = extractResponseHeaders(res.headers);
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
      bodyTextHead = text.slice(0, 300);
    }
  } catch (e) {
    networkError = e instanceof Error
      ? [e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(" | ")
      : String(e);
  }
  const rttMs = performance.now() - t0;
  const responseEpoch = nowEpochMs();
  return {
    status,
    json,
    rtt_ms: rttMs,
    request_start_epoch_ms: startEpoch,
    response_epoch_ms: responseEpoch,
    networkError,
    body_text_head: bodyTextHead,
    response_headers: responseHeaders,
  };
}

async function peekRevision(config, token, room) {
  return callProbe(config, token, { op: "peek", room });
}

async function baselineHealth(config, times = 10) {
  const rtts = [];
  for (let i = 0; i < times; i++) {
    const t0 = performance.now();
    try {
      await fetch(config.api_url + "/auth/v1/health", {
        headers: { apikey: config.anon_key },
      });
    } catch {
      // recorded as a missing sample; rtts stays short one entry
      continue;
    }
    rtts.push(performance.now() - t0);
  }
  return rtts;
}

// ---------------------------------------------------------------------------
// Integrity: ground truth is the room's revision counter (via peek) plus the
// broadcasts actually observed for that room, not the HTTP status of any one
// call -- a 503/504/network error can still correspond to a commit that
// landed after the client gave up.
// ---------------------------------------------------------------------------

async function settleIfUnknownOutcome(outcomes, label) {
  const hasUnknown = outcomes.some((o) => o.networkError || o.status === 503 || o.status === 504);
  if (hasUnknown) {
    console.log(`[harness]   ${label}: 결과 불명 호출 감지, 정착 대기 ${SETTLE_GRACE_MS}ms...`);
    await sleep(SETTLE_GRACE_MS);
  }
  return hasUnknown;
}

async function checkIntegrity(config, peekToken, users, room, outcomes) {
  const peek = await peekRevision(config, peekToken, room);
  const finalRevision = typeof peek.json?.revision === "number" ? peek.json.revision : null;

  const observedSet = new Set();
  for (const u of users) {
    for (const m of u.received) {
      if (m.room === room && m.revision != null) observedSet.add(m.revision);
    }
  }

  const success200 = outcomes.filter((o) => o.status === 200 && o.revision != null);
  const success200Revisions = success200.map((o) => o.revision);
  const noDuplicates = new Set(success200Revisions).size === success200Revisions.length;

  let coversAll = finalRevision != null;
  if (coversAll) {
    for (let r = 1; r <= finalRevision; r++) {
      if (!observedSet.has(r)) {
        coversAll = false;
        break;
      }
    }
  }

  const unknownOutcome = outcomes.filter((o) => o.networkError || o.status === 503 || o.status === 504);

  return {
    final_revision: finalRevision,
    peek_call: { status: peek.status, rtt_ms: peek.rtt_ms, networkError: peek.networkError },
    observed_revision_count: observedSet.size,
    success_200_count: success200.length,
    no_duplicate_200_revisions: noDuplicates,
    covers_1_to_n: coversAll,
    no_lost_updates: coversAll && noDuplicates,
    unknown_outcome_calls: unknownOutcome.length,
    unknown_outcome_committed: finalRevision != null ? finalRevision - success200.length : null,
  };
}

function lateForeign(users, room, windowStartEpoch, windowEndEpoch) {
  const entries = [];
  for (const u of users) {
    for (const m of u.received) {
      if (
        m.room != null &&
        m.room !== room &&
        m.recv_epoch_ms >= windowStartEpoch &&
        m.recv_epoch_ms <= windowEndEpoch
      ) {
        entries.push({
          player_index: u.index,
          foreign_room: m.room,
          revision: m.revision,
          delivery_ms: m.delivery_ms,
        });
      }
    }
  }
  return entries;
}

function deliveryStats(users, room) {
  const values = [];
  for (const u of users) {
    for (const m of u.received) {
      if (m.room === room && m.delivery_ms != null) values.push(m.delivery_ms);
    }
  }
  return stats(values);
}

// ---------------------------------------------------------------------------
// Scenario A: single diag call
// ---------------------------------------------------------------------------

async function scenarioA(config, actor) {
  const result = await callProbe(config, actor.token, { op: "diag" });
  return result;
}

// ---------------------------------------------------------------------------
// Sequential scenarios (B: single actor, E: rotating actor). Calls happen
// one at a time with a fixed gap, so there's no write contention -- these
// measure baseline broadcast latency and per-call HTTP overhead.
// ---------------------------------------------------------------------------

async function waitForRevision(user, room, revision, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const hit = user.received.find((m) => m.room === room && m.revision === revision);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
}

async function sequentialScenario(config, users, room, { rounds, gapMs, workMs, pickActor }) {
  const calls = [];
  for (let i = 0; i < rounds; i++) {
    const actor = pickActor(i);
    const observers = users.filter((u) => u !== actor);
    const players = users.map((u) => u.uid);
    const call = await callProbe(config, actor.token, { op: "cmd", room, players, work_ms: workMs });
    const revision = call.json?.revision ?? null;

    const perObserver = [];
    if (revision !== null && call.status === 200) {
      for (const obs of observers) {
        const hit = await waitForRevision(obs, room, revision, 5000);
        perObserver.push({
          player_index: obs.index,
          revision,
          delay_from_send_ms: hit ? hit.recv_epoch_ms - call.request_start_epoch_ms : null,
          delay_from_response_ms: hit ? hit.recv_epoch_ms - call.response_epoch_ms : null,
          delivery_ms: hit ? hit.delivery_ms : null,
          missing: !hit,
        });
      }
    }

    calls.push({
      call_index: i,
      actor_index: actor.index,
      status: call.status,
      revision,
      rtt_ms: call.rtt_ms,
      server_timings: call.json?.timings ?? null,
      server_epoch_done: call.json?.server_epoch_done ?? null,
      response_epoch_ms: call.response_epoch_ms,
      error: call.json?.error ?? call.networkError ?? null,
      networkError: call.networkError,
      body_text_head: call.body_text_head,
      response_headers: call.response_headers,
      observers: perObserver,
    });

    if (i < rounds - 1) await sleep(gapMs);
  }
  return calls;
}

function rttBreakdown(calls, baselineRtts) {
  const overhead = calls
    .filter((c) => c.status === 200 && c.server_timings?.total_ms != null)
    .map((c) => c.rtt_ms - c.server_timings.total_ms);
  const overheadStats = stats(overhead);
  const baselineP50 = stats(baselineRtts).p50;
  const excessP50 =
    overheadStats.p50 != null && baselineP50 != null ? overheadStats.p50 - baselineP50 : null;
  return { ...overheadStats, baseline_p50: baselineP50, excess_over_baseline_p50: excessP50 };
}

function clockSkewStats(calls) {
  const skews = calls
    .filter((c) => c.status === 200 && c.server_epoch_done != null)
    .map((c) => c.response_epoch_ms - c.rtt_ms / 2 - c.server_epoch_done);
  return stats(skews);
}

function correctedDeliveryStats(users, room, skewP50) {
  if (skewP50 == null) return null;
  const values = [];
  for (const u of users) {
    for (const m of u.received) {
      if (m.room === room && m.delivery_ms != null) values.push(m.delivery_ms - skewP50);
    }
  }
  return stats(values);
}

// ---------------------------------------------------------------------------
// Scenario C: concurrent burst, N rounds x 5 simultaneous callers on a room.
// Scenario D reuses the same round logic with 429 retry.
// ---------------------------------------------------------------------------

async function burstRound(config, users, room, workMs, retry) {
  const players = users.map((u) => u.uid);
  const attempts = await Promise.all(
    users.map(async (u) => {
      let attempt = 0;
      let extraDelayMs = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const call = await callProbe(config, u.token, { op: "cmd", room, players, work_ms: workMs });
        attempt += 1;
        if (call.status !== 429 || !retry || attempt > RETRY_MAX_ATTEMPTS) {
          return { player_index: u.index, attempts: attempt, extra_delay_ms: extraDelayMs, ...call };
        }
        const jitter = RETRY_JITTER_MIN_MS + Math.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS);
        extraDelayMs += jitter;
        await sleep(jitter);
      }
    }),
  );
  return attempts;
}

function analyzeBurst(rounds, users, room) {
  const statusCounts = {};
  const successRevisions = [];

  for (const round of rounds) {
    for (const r of round) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      if (r.status === 200 && r.json?.revision != null) successRevisions.push(r.json.revision);
    }
  }
  successRevisions.sort((a, b) => a - b);

  const totalAttempts = rounds.reduce((sum, r) => sum + r.length, 0);
  const rate429 = (statusCounts["429"] ?? statusCounts[429] ?? 0) / totalAttempts;

  const perPlayer = users.map((u) => {
    const own = u.received.filter((m) => m.room === room);
    let inversions = 0;
    let maxSeen = -Infinity;
    for (const m of own) {
      if (m.revision == null) continue;
      if (m.revision < maxSeen) inversions++;
      else maxSeen = m.revision;
    }
    let missing = 0;
    for (const rev of successRevisions) {
      if (!own.some((m) => m.revision === rev)) missing++;
    }
    return { player_index: u.index, inversions, missing_broadcasts: missing, received_count: own.length };
  });

  return {
    status_counts: statusCounts,
    success_count: successRevisions.length,
    final_revision_set: successRevisions,
    rate_429: rate429,
    per_player: perPlayer,
  };
}

async function scenarioC(config, users, room) {
  const rounds = [];
  for (let i = 0; i < BURST_ROUNDS; i++) {
    rounds.push(await burstRound(config, users, room, 20, false));
    if (i < BURST_ROUNDS - 1) await sleep(BURST_GAP_MS);
  }
  return { rounds, analysis: analyzeBurst(rounds, users, room) };
}

async function scenarioD(config, users, room) {
  const rounds = [];
  for (let i = 0; i < BURST_ROUNDS; i++) {
    rounds.push(await burstRound(config, users, room, 20, true));
    if (i < BURST_ROUNDS - 1) await sleep(BURST_GAP_MS);
  }
  const analysis = analyzeBurst(rounds, users, room);
  const finalAttempts = rounds.flat();
  const finalSuccessRate = finalAttempts.filter((a) => a.status === 200).length / finalAttempts.length;
  const extraDelays = finalAttempts.map((a) => a.extra_delay_ms);
  return { rounds, analysis, final_success_rate: finalSuccessRate, retry_extra_delay_ms: stats(extraDelays) };
}

function burstOutcomes(rounds) {
  return rounds.flat().map((a) => ({ status: a.status, revision: a.json?.revision ?? null, networkError: a.networkError }));
}

// ---------------------------------------------------------------------------
// Scenarios F/G/G2: command_id idempotency and expect_revision race safety.
//
// A call is "retryable" exactly when its outcome is unknown or rate-limited:
// 503/504 (the measured self-hosted worker-stall failure mode, which can
// still have committed server-side), a network error (status 0, same
// ambiguity), or 429 (explicit backpressure). The client MUST resend the
// identical body (same command_id) so the server's probe_receipts dedupe can
// recognize a resend of an already-applied command.
// ---------------------------------------------------------------------------

function isRetryableStatus(call) {
  return call.networkError != null || call.status === 0 || call.status === 429 || call.status === 503 || call.status === 504;
}

async function sendWithRetry(config, token, body, maxRetries = IDEMPOTENT_RETRY_MAX_ATTEMPTS) {
  const attempts = [];
  let attempt = 0;
  let extraDelayMs = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const call = await callProbe(config, token, body);
    attempt += 1;
    attempts.push(call);
    if (!isRetryableStatus(call) || attempt > maxRetries) {
      return { finalCall: call, attempts, attempt_count: attempt, extra_delay_ms: extraDelayMs };
    }
    const jitter =
      IDEMPOTENT_RETRY_JITTER_MIN_MS + Math.random() * (IDEMPOTENT_RETRY_JITTER_MAX_MS - IDEMPOTENT_RETRY_JITTER_MIN_MS);
    extraDelayMs += jitter;
    await sleep(jitter);
  }
}

function summarizeSendResult(player_index, role, command_id, r) {
  const { finalCall, attempts, attempt_count, extra_delay_ms } = r;
  return {
    player_index,
    role,
    command_id,
    sent: true,
    attempt_count,
    extra_delay_ms,
    final_status: finalCall.status,
    applied: finalCall.status === 200 && finalCall.json?.skipped !== true && finalCall.json?.duplicate !== true,
    skipped: finalCall.json?.skipped === true,
    duplicate: finalCall.json?.duplicate === true,
    final_revision: finalCall.json?.revision ?? null,
    statuses: attempts.map((a) => a.status),
    networkError: finalCall.networkError,
  };
}

// Per-player broadcast coverage for a room: every crew member's own received
// set (not just the union across all of them) must be exactly {1..n}, once.
function perPlayerRevisionCoverage(users, room, finalRevision) {
  return users.map((u) => {
    const revs = u.received.filter((m) => m.room === room).map((m) => m.revision).filter((r) => r != null);
    const uniqueRevs = new Set(revs);
    const noDuplicates = uniqueRevs.size === revs.length;
    let coversAll = finalRevision != null;
    if (coversAll) {
      for (let r = 1; r <= finalRevision; r++) {
        if (!uniqueRevs.has(r)) {
          coversAll = false;
          break;
        }
      }
    }
    return {
      player_index: u.index,
      received_count: revs.length,
      unique_count: uniqueRevs.size,
      no_duplicates: noDuplicates,
      covers_1_to_n: coversAll,
    };
  });
}

// ---------------------------------------------------------------------------
// Scenario F: idempotent resend under induced 503/504. New room, 15 rounds x
// 4 concurrent actors (the measured 503/504 trigger point), each call with
// its own unique command_id. On a retryable outcome, resend the SAME
// command_id + body. Ground truth: final revision must equal the number of
// distinct commands that ever resolved successfully (double_applied == 0).
// ---------------------------------------------------------------------------

async function scenarioF(config, users) {
  const room = crypto.randomUUID();
  const players = users.map((u) => u.uid);
  const actors = users.slice(0, SCENARIO_F_CONCURRENCY);

  const rounds = [];
  for (let i = 0; i < SCENARIO_F_ROUNDS; i++) {
    const perActor = await Promise.all(
      actors.map(async (u) => {
        const commandId = crypto.randomUUID();
        const body = { op: "cmd", room, players, work_ms: 20, command_id: commandId };
        const r = await sendWithRetry(config, u.token, body);
        return summarizeSendResult(u.index, "actor", commandId, r);
      }),
    );
    rounds.push({ round_index: i, actors: perActor });
    if (i < SCENARIO_F_ROUNDS - 1) await sleep(BURST_GAP_MS);
  }

  console.log(`[harness]   F: 정착 대기 ${SETTLE_GRACE_MS}ms (마지막 재시도 이후 늦게 도착할 수 있는 커밋 대비)...`);
  await sleep(SETTLE_GRACE_MS);

  const peek = await peekRevision(config, users[0].token, room);
  const finalRevision = typeof peek.json?.revision === "number" ? peek.json.revision : null;

  const flatActors = rounds.flatMap((r) => r.actors);
  const uniqueCommandCount = flatActors.length;
  const successfulCommandCount = flatActors.filter((a) => a.final_status === 200).length;
  const duplicateResponseCount = flatActors.filter((a) => a.duplicate).length;
  const retriedActors = flatActors.filter((a) => a.attempt_count > 1);
  const extraDelays = retriedActors.map((a) => a.extra_delay_ms);

  return {
    room,
    rounds,
    unique_command_count: uniqueCommandCount,
    final_revision: finalRevision,
    duplicate_response_count: duplicateResponseCount,
    retried_call_count: retriedActors.length,
    final_success_rate: successfulCommandCount / uniqueCommandCount,
    retry_extra_delay_ms: stats(extraDelays),
    double_applied: finalRevision != null ? finalRevision - successfulCommandCount : null,
    per_player_coverage: perPlayerRevisionCoverage(users, room, finalRevision),
  };
}

// ---------------------------------------------------------------------------
// Scenario G: concurrent expect_revision race (crew "trick pass" style: all
// 5 crew members intend the same state transition at once). Actor 0 seeds
// revision R with one plain cmd. Then for 20 rounds, all 5 send
// {expect_revision: <current R>, command_id: <own uuid>} at once -- exactly
// one per round should apply; the rest must come back skipped (stale
// expect_revision), never duplicate (each command_id here is unique).
// ---------------------------------------------------------------------------

async function scenarioG(config, users) {
  const room = crypto.randomUUID();
  const players = users.map((u) => u.uid);

  const seedCommandId = crypto.randomUUID();
  const seed = await sendWithRetry(config, users[0].token, {
    op: "cmd",
    room,
    players,
    work_ms: 5,
    command_id: seedCommandId,
  });
  const seedRevision = seed.finalCall.json?.revision ?? null;
  if (seedRevision == null) {
    throw new Error("scenario G: seed command did not return a revision");
  }

  let currentRevision = seedRevision;
  const rounds = [];
  for (let i = 0; i < SCENARIO_G_ROUNDS; i++) {
    const expectRevision = currentRevision;
    const perActor = await Promise.all(
      users.map(async (u) => {
        const commandId = crypto.randomUUID();
        const body = { op: "cmd", room, players, work_ms: 5, expect_revision: expectRevision, command_id: commandId };
        const r = await sendWithRetry(config, u.token, body);
        return summarizeSendResult(u.index, "actor", commandId, r);
      }),
    );

    const appliedCount = perActor.filter((a) => a.applied).length;
    const skippedCount = perActor.filter((a) => a.skipped).length;
    const peek = await peekRevision(config, users[0].token, room);
    const revisionAfter = typeof peek.json?.revision === "number" ? peek.json.revision : null;

    rounds.push({
      round_index: i,
      expect_revision: expectRevision,
      applied_count: appliedCount,
      skipped_count: skippedCount,
      revision_after: revisionAfter,
      actors: perActor,
    });

    currentRevision = revisionAfter ?? expectRevision + appliedCount;
    if (i < SCENARIO_G_ROUNDS - 1) await sleep(BURST_GAP_MS);
  }

  const finalRevision = currentRevision;
  const expectedFinalRevision = seedRevision + SCENARIO_G_ROUNDS;

  return {
    room,
    seed_revision: seedRevision,
    rounds,
    applied_count_distribution: rounds.map((r) => r.applied_count),
    exactly_one_applied_every_round: rounds.every((r) => r.applied_count === 1),
    total_skipped: rounds.reduce((sum, r) => sum + r.skipped_count, 0),
    final_revision: finalRevision,
    expected_final_revision: expectedFinalRevision,
    matches_expected_final_revision: finalRevision === expectedFinalRevision,
    per_player_coverage: perPlayerRevisionCoverage(users, room, finalRevision),
  };
}

// ---------------------------------------------------------------------------
// Scenario G2 (reference variant): same race, but only a designated leader
// sends immediately each round; the other 4 wait 1500ms then peek -- if the
// transition still hasn't happened, they send too. Compares request volume
// and 429/5xx rate against G's "everyone sends immediately" strategy.
// ---------------------------------------------------------------------------

async function scenarioG2(config, users) {
  const room = crypto.randomUUID();
  const players = users.map((u) => u.uid);

  const seedCommandId = crypto.randomUUID();
  const seed = await sendWithRetry(config, users[0].token, {
    op: "cmd",
    room,
    players,
    work_ms: 5,
    command_id: seedCommandId,
  });
  const seedRevision = seed.finalCall.json?.revision ?? null;
  if (seedRevision == null) {
    throw new Error("scenario G2: seed command did not return a revision");
  }

  let currentRevision = seedRevision;
  let totalRequestsSent = 0;
  let total429or5xx = 0;
  const rounds = [];

  for (let i = 0; i < SCENARIO_G2_ROUNDS; i++) {
    const expectRevision = currentRevision;
    const leader = users[i % users.length];
    const followers = users.filter((u) => u !== leader);

    const leaderPromise = (async () => {
      const commandId = crypto.randomUUID();
      const body = { op: "cmd", room, players, work_ms: 5, expect_revision: expectRevision, command_id: commandId };
      const r = await sendWithRetry(config, leader.token, body);
      return summarizeSendResult(leader.index, "leader", commandId, r);
    })();

    const followerPromises = followers.map(async (u) => {
      await sleep(SCENARIO_G2_LEADER_WAIT_MS);
      const peek = await peekRevision(config, u.token, room);
      const stillNeeded = typeof peek.json?.revision === "number" ? peek.json.revision === expectRevision : true;
      if (!stillNeeded) {
        return { player_index: u.index, role: "follower", sent: false };
      }
      const commandId = crypto.randomUUID();
      const body = { op: "cmd", room, players, work_ms: 5, expect_revision: expectRevision, command_id: commandId };
      const r = await sendWithRetry(config, u.token, body);
      return summarizeSendResult(u.index, "follower", commandId, r);
    });

    const actors = await Promise.all([leaderPromise, ...followerPromises]);
    for (const a of actors) {
      if (a.sent) {
        totalRequestsSent += a.attempt_count ?? 1;
        total429or5xx += (a.statuses ?? []).filter((s) => s === 429 || s === 503 || s === 504).length;
      }
    }

    const appliedCount = actors.filter((a) => a.applied).length;
    const peek = await peekRevision(config, users[0].token, room);
    const revisionAfter = typeof peek.json?.revision === "number" ? peek.json.revision : null;

    rounds.push({
      round_index: i,
      expect_revision: expectRevision,
      leader_index: leader.index,
      requests_sent: actors.filter((a) => a.sent).length,
      applied_count: appliedCount,
      revision_after: revisionAfter,
      actors,
    });

    currentRevision = revisionAfter ?? expectRevision + appliedCount;
    if (i < SCENARIO_G2_ROUNDS - 1) await sleep(BURST_GAP_MS);
  }

  return {
    room,
    seed_revision: seedRevision,
    rounds,
    total_requests_sent: totalRequestsSent,
    total_429_5xx: total429or5xx,
    applied_count_distribution: rounds.map((r) => r.applied_count),
    exactly_one_applied_every_round: rounds.every((r) => r.applied_count === 1),
    final_revision: currentRevision,
  };
}

// ---------------------------------------------------------------------------
// Console report (Korean)
// ---------------------------------------------------------------------------

function printTable(title, rows) {
  console.log(`\n== ${title} ==`);
  console.table(rows);
}

function summarizeSequential(label, seq) {
  const bRtt = stats(seq.calls.map((c) => c.rtt_ms));
  const bLock = stats(seq.calls.map((c) => c.server_timings?.lock_wait_ms));
  const bCommit = stats(seq.calls.map((c) => c.server_timings?.commit_ms));
  const bEnd = stats(seq.calls.map((c) => c.server_timings?.end_ms));
  const bDelaySend = stats(seq.calls.flatMap((c) => c.observers.map((o) => o.delay_from_send_ms)));
  const bDelayResp = stats(seq.calls.flatMap((c) => c.observers.map((o) => o.delay_from_response_ms)));
  const bDelivery = deliveryStats(seq.users, seq.room);

  printTable(`${label}. HTTP RTT / lock_wait / commit / sql.end / broadcast 지연`, [
    { metric: "http_rtt_ms", ...bRtt },
    { metric: "lock_wait_ms", ...bLock },
    { metric: "commit_ms", ...bCommit },
    { metric: "sql_end_ms", ...bEnd },
    { metric: "broadcast_delay_from_send_ms", ...bDelaySend },
    { metric: "broadcast_delay_from_response_ms", ...bDelayResp },
    { metric: "broadcast_delivery_ms (server_commit->recv)", ...bDelivery },
  ]);

  printTable(`${label}. HTTP RTT 분해 (rtt - server total_ms)`, [
    { metric: "router_worker_network_overhead_ms", ...seq.rttOverhead },
  ]);

  if (seq.clockSkew) {
    printTable(`${label}. 로컬-서버 시계차 추정 및 보정된 broadcast 지연`, [
      { metric: "estimated_clock_skew_ms", ...seq.clockSkew },
      { metric: "corrected_delivery_ms", ...(seq.correctedDelivery ?? {}) },
    ]);
  }

  printTable(`${label}. 무결성 (peek 기반)`, [seq.integrity]);
  if (seq.late_foreign.length > 0) {
    printTable(`${label}. late_foreign (다른 방에서 늦게 도착)`, seq.late_foreign);
  }
}

function summarizeF(f) {
  printTable("F. 멱등 재전송 (동시 4명 x 15라운드, 60개 고유 command)", [
    {
      unique_command_count: f.unique_command_count,
      final_revision: f.final_revision,
      double_applied: f.double_applied,
      duplicate_response_count: f.duplicate_response_count,
      retried_call_count: f.retried_call_count,
      final_success_rate: f.final_success_rate.toFixed(3),
    },
  ]);
  printTable("F. 재시도로 인한 추가 지연 (재시도 발생한 호출만)", [
    { metric: "retry_extra_delay_ms", ...f.retry_extra_delay_ms },
  ]);
  printTable("F. 플레이어별 broadcast 수신 커버리지 (1..N 연속/중복 없음)", f.per_player_coverage);
}

function summarizeG(label, g) {
  printTable(`${label}. 라운드별 적용/스킵 수`, g.rounds.map((r) => ({
    round_index: r.round_index,
    expect_revision: r.expect_revision,
    applied_count: r.applied_count,
    skipped_count: r.skipped_count,
    revision_after: r.revision_after,
  })));
  printTable(`${label}. 요약`, [
    {
      seed_revision: g.seed_revision,
      exactly_one_applied_every_round: g.exactly_one_applied_every_round,
      total_skipped: g.total_skipped,
      final_revision: g.final_revision,
      expected_final_revision: g.expected_final_revision,
      matches_expected_final_revision: g.matches_expected_final_revision,
    },
  ]);
  printTable(`${label}. 플레이어별 broadcast 수신 커버리지`, g.per_player_coverage);
}

function summarizeG2(g2) {
  printTable("G2. 참고: 리더-먼저 전략 라운드별", g2.rounds.map((r) => ({
    round_index: r.round_index,
    leader_index: r.leader_index,
    requests_sent: r.requests_sent,
    applied_count: r.applied_count,
    revision_after: r.revision_after,
  })));
  printTable("G2. 요약 (G 대비 요청 수/429·5xx 비교용)", [
    {
      seed_revision: g2.seed_revision,
      total_requests_sent: g2.total_requests_sent,
      total_429_5xx: g2.total_429_5xx,
      exactly_one_applied_every_round: g2.exactly_one_applied_every_round,
      final_revision: g2.final_revision,
    },
  ]);
}

function summarize(result) {
  console.log("\n===== 결과 요약 (숫자는 ms 기준, p50/p90/max) =====");

  printTable("기준선: /auth/v1/health 왕복시간", [stats(result.baseline_health_rtt_ms)]);

  if (result.scenario_a) {
    printTable("A. diag", [
      {
        status: result.scenario_a.status,
        module_to_handler_ms: result.scenario_a.json?.module_to_handler_ms,
        db_connect_ms: result.scenario_a.json?.db?.connect_ms,
        realtime_send_exists: result.scenario_a.json?.db?.realtime_send_exists,
      },
    ]);
  }

  if (result.scenario_b) summarizeSequential("B. 순차 20회", result.scenario_b);

  if (result.scenario_c) {
    printTable("C. 동시 폭주", [
      {
        rounds: BURST_ROUNDS,
        status_counts: JSON.stringify(result.scenario_c.analysis.status_counts),
        success_count: result.scenario_c.analysis.success_count,
        rate_429: result.scenario_c.analysis.rate_429.toFixed(3),
      },
    ]);
    printTable("C. 플레이어별 순서역전/누락 (해당 room 기준)", result.scenario_c.analysis.per_player);
    printTable("C. broadcast_delivery_ms", [{ metric: "delivery_ms", ...result.scenario_c.delivery_ms }]);
    printTable("C. 무결성 (peek 기반)", [result.scenario_c.integrity]);
    if (result.scenario_c.late_foreign.length > 0) {
      printTable("C. late_foreign", result.scenario_c.late_foreign);
    }
  }

  if (result.scenario_d) {
    printTable("D. 429 재시도 전략", [
      {
        rounds: BURST_ROUNDS,
        final_success_rate: result.scenario_d.final_success_rate.toFixed(3),
        retry_extra_delay_p50: result.scenario_d.retry_extra_delay_ms.p50,
        retry_extra_delay_p90: result.scenario_d.retry_extra_delay_ms.p90,
        retry_extra_delay_max: result.scenario_d.retry_extra_delay_ms.max,
      },
    ]);
    printTable("D. broadcast_delivery_ms", [{ metric: "delivery_ms", ...result.scenario_d.delivery_ms }]);
    printTable("D. 무결성 (peek 기반)", [result.scenario_d.integrity]);
    if (result.scenario_d.late_foreign.length > 0) {
      printTable("D. late_foreign", result.scenario_d.late_foreign);
    }
  }

  if (result.scenario_e) summarizeSequential("E. 순차-교대 30회 (턴 흐름 흉내)", result.scenario_e);

  if (result.scenario_f) summarizeF(result.scenario_f);
  if (result.scenario_g) summarizeG("G. 트릭 넘김 경합", result.scenario_g);
  if (result.scenario_g2) summarizeG2(result.scenario_g2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { config, outPath } = loadConfig();

  console.log(`[harness] 익명 사용자 ${NUM_PLAYERS}명 로그인 중...`);
  const users = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    users.push(await createUser(config, i));
  }

  console.log("[harness] 개인 broadcast 채널 구독 중...");
  const subscribeResults = await Promise.all(users.map((u) => subscribeUser(u, config.project_id)));
  const subscribeSummary = users.map((u) => ({ player_index: u.index, status: u.subscribeStatus }));
  if (subscribeResults.some((ok) => !ok)) {
    console.warn("[harness] 일부 채널이 SUBSCRIBED 상태에 도달하지 못했습니다:", subscribeSummary);
  }

  console.log("[harness] 기준선 측정 (auth health x10)...");
  const baselineRtts = await baselineHealth(config, 10);

  const only = parseProbeOnly();
  console.log(`[harness] 실행할 시나리오: ${[...only].join(", ")}`);

  let scenarioAResult = null;
  if (only.has("A")) {
    console.log("[harness] 시나리오 A: diag");
    scenarioAResult = await scenarioA(config, users[0]);
  }

  // --- B: sequential, single actor -----------------------------------
  let scenarioBResult = null;
  if (only.has("B")) {
    const roomR1 = crypto.randomUUID();
    console.log(`[harness] 시나리오 B: 순차 ${SEQUENTIAL_ROUNDS}회 (room ${roomR1})`);
    const windowStart = nowEpochMs();
    const scenarioBCalls = await sequentialScenario(config, users, roomR1, {
      rounds: SEQUENTIAL_ROUNDS,
      gapMs: SEQUENTIAL_GAP_MS,
      workMs: 5,
      pickActor: () => users[0],
    });
    const bOutcomes = scenarioBCalls.map((c) => ({ status: c.status, revision: c.revision, networkError: c.networkError }));
    await settleIfUnknownOutcome(bOutcomes, "B");
    const bIntegrity = await checkIntegrity(config, users[0].token, users, roomR1, bOutcomes);
    const bClockSkew = clockSkewStats(scenarioBCalls);
    scenarioBResult = {
      room: roomR1,
      calls: scenarioBCalls,
      users,
      rttOverhead: rttBreakdown(scenarioBCalls, baselineRtts),
      clockSkew: bClockSkew,
      correctedDelivery: correctedDeliveryStats(users, roomR1, bClockSkew.p50),
      integrity: bIntegrity,
      late_foreign: lateForeign(users, roomR1, windowStart, nowEpochMs()),
    };
  }

  // --- C: concurrent burst, no retry -----------------------------------
  let scenarioCResult = null;
  if (only.has("C")) {
    const roomR2 = crypto.randomUUID();
    console.log(`[harness] 시나리오 C: 동시 폭주 ${BURST_ROUNDS}라운드 (room ${roomR2})`);
    const windowStart = nowEpochMs();
    const scenarioCRaw = await scenarioC(config, users, roomR2);
    const cOutcomes = burstOutcomes(scenarioCRaw.rounds);
    await settleIfUnknownOutcome(cOutcomes, "C");
    const cIntegrity = await checkIntegrity(config, users[0].token, users, roomR2, cOutcomes);
    scenarioCResult = {
      room: roomR2,
      ...scenarioCRaw,
      delivery_ms: deliveryStats(users, roomR2),
      integrity: cIntegrity,
      late_foreign: lateForeign(users, roomR2, windowStart, nowEpochMs()),
    };
  }

  // --- D: concurrent burst, 429 retry -----------------------------------
  let scenarioDResult = null;
  if (only.has("D")) {
    const roomR3 = crypto.randomUUID();
    console.log(`[harness] 시나리오 D: 429 재시도 ${BURST_ROUNDS}라운드 (room ${roomR3})`);
    const windowStart = nowEpochMs();
    const scenarioDRaw = await scenarioD(config, users, roomR3);
    const dOutcomes = burstOutcomes(scenarioDRaw.rounds);
    await settleIfUnknownOutcome(dOutcomes, "D");
    const dIntegrity = await checkIntegrity(config, users[0].token, users, roomR3, dOutcomes);
    scenarioDResult = {
      room: roomR3,
      ...scenarioDRaw,
      delivery_ms: deliveryStats(users, roomR3),
      integrity: dIntegrity,
      late_foreign: lateForeign(users, roomR3, windowStart, nowEpochMs()),
    };
  }

  // --- E: sequential, rotating actor (turn-flow simulation) -------------
  let scenarioEResult = null;
  if (only.has("E")) {
    const roomR4 = crypto.randomUUID();
    console.log(`[harness] 시나리오 E: 순차-교대 ${ROTATING_ROUNDS}회 (room ${roomR4})`);
    const windowStart = nowEpochMs();
    const scenarioECalls = await sequentialScenario(config, users, roomR4, {
      rounds: ROTATING_ROUNDS,
      gapMs: ROTATING_GAP_MS,
      workMs: 5,
      pickActor: (i) => users[i % NUM_PLAYERS],
    });
    const eOutcomes = scenarioECalls.map((c) => ({ status: c.status, revision: c.revision, networkError: c.networkError }));
    await settleIfUnknownOutcome(eOutcomes, "E");
    const eIntegrity = await checkIntegrity(config, users[0].token, users, roomR4, eOutcomes);
    const eClockSkew = clockSkewStats(scenarioECalls);
    scenarioEResult = {
      room: roomR4,
      calls: scenarioECalls,
      users,
      rttOverhead: rttBreakdown(scenarioECalls, baselineRtts),
      clockSkew: eClockSkew,
      correctedDelivery: correctedDeliveryStats(users, roomR4, eClockSkew.p50),
      integrity: eIntegrity,
      late_foreign: lateForeign(users, roomR4, windowStart, nowEpochMs()),
    };
  }

  // --- F: idempotent resend under induced 503/504 -----------------------
  let scenarioFResult = null;
  if (only.has("F")) {
    console.log(`[harness] 시나리오 F: 멱등 재전송 ${SCENARIO_F_ROUNDS}라운드 x 동시 ${SCENARIO_F_CONCURRENCY}명`);
    scenarioFResult = await scenarioF(config, users);
  }

  // --- G: concurrent expect_revision race (trick-pass style) -------------
  let scenarioGResult = null;
  if (only.has("G")) {
    console.log(`[harness] 시나리오 G: 트릭 넘김 경합 ${SCENARIO_G_ROUNDS}라운드`);
    scenarioGResult = await scenarioG(config, users);
  }

  // --- G2: reference variant, leader-first strategy -----------------------
  let scenarioG2Result = null;
  if (only.has("G2")) {
    console.log(`[harness] 시나리오 G2 (참고): 리더-먼저 전략 ${SCENARIO_G2_ROUNDS}라운드`);
    scenarioG2Result = await scenarioG2(config, users);
  }

  console.log("[harness] 정리 중 (채널 해제)...");
  for (const u of users) {
    try {
      if (u.channel) await u.client.removeChannel(u.channel);
    } catch {
      // best effort cleanup
    }
  }

  const result = {
    generated_at: new Date().toISOString(),
    project_id: config.project_id,
    probe_rounds: BURST_ROUNDS,
    scenarios_run: [...only],
    subscribe_summary: subscribeSummary,
    baseline_health_rtt_ms: baselineRtts,
    scenario_a: scenarioAResult,
    scenario_b: scenarioBResult ? stripUsers(scenarioBResult) : null,
    scenario_c: scenarioCResult,
    scenario_d: scenarioDResult,
    scenario_e: scenarioEResult ? stripUsers(scenarioEResult) : null,
    scenario_f: scenarioFResult,
    scenario_g: scenarioGResult,
    scenario_g2: scenarioG2Result,
    raw_received: users.map((u) => ({ player_index: u.index, received: u.received })),
    channel_status_log: users.map((u) => ({ player_index: u.index, log: u.statusLog })),
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[harness] 결과를 ${outPath} 에 저장했습니다.`);

  summarize({
    ...result,
    scenario_b: result.scenario_b ? { ...result.scenario_b, users } : null,
    scenario_e: result.scenario_e ? { ...result.scenario_e, users } : null,
  });
}

// `users` is only needed transiently (to compute per-scenario stats); don't
// serialize each user's full received[] into every scenario section since
// it's already captured once in `raw_received`.
function stripUsers({ users, ...rest }) {
  return rest;
}

main().catch((err) => {
  console.error("[harness] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
