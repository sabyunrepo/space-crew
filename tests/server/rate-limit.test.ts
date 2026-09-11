import { describe, expect, it } from "vitest";
import { IpRateLimiter, TokenBucket } from "../../server/rate-limit.ts";

describe("TokenBucket", () => {
  it("allows up to its capacity immediately, then rejects until it refills", () => {
    const bucket = new TokenBucket(3, 1, 0); // 1 token/ms refill, starts full at t=0
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(false);
    expect(bucket.tryConsume(2)).toBe(true); // 2ms elapsed -> +2 tokens
  });
});

describe("IpRateLimiter", () => {
  it("tracks buckets per IP independently (burst then blocked, refills over time)", () => {
    const limiter = new IpRateLimiter(5, 10, 10 * 60 * 1000); // capacity 5, 10/min refill
    let now = 0;
    for (let i = 0; i < 5; i++) expect(limiter.allow("1.1.1.1", now)).toBe(true);
    expect(limiter.allow("1.1.1.1", now)).toBe(false);
    // A different IP has its own independent bucket.
    expect(limiter.allow("2.2.2.2", now)).toBe(true);
    // After enough time for one refill (10/min == 1 per 6000ms) the blocked IP recovers.
    now += 6000;
    expect(limiter.allow("1.1.1.1", now)).toBe(true);
  });

  it("evicts idle IP entries so the map does not grow without bound", () => {
    const limiter = new IpRateLimiter(5, 10, 1000);
    limiter.allow("3.3.3.3", 0);
    expect(limiter.size).toBe(1);
    limiter.allow("4.4.4.4", 5000); // sweep runs on this call; 3.3.3.3 is stale (>1000ms idle)
    expect(limiter.size).toBe(1);
  });
});
