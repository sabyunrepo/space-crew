/**
 * Minimal in-memory token bucket, used to throttle abuse-prone endpoints
 * (room creation, joins, WS auth attempts) without a new dependency.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private capacity: number,
    private refillPerMs: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  tryConsume(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Per-IP token buckets. Idle entries are swept opportunistically on access
 * so an attacker rotating through many source IPs can't grow this map
 * without bound.
 */
export class IpRateLimiter {
  private buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();

  constructor(
    private capacity: number,
    private refillPerMinute: number,
    private idleEvictMs = 10 * 60 * 1000,
  ) {}

  allow(ip: string, now = Date.now()): boolean {
    this.sweep(now);
    let entry = this.buckets.get(ip);
    if (!entry) {
      entry = {
        bucket: new TokenBucket(this.capacity, this.refillPerMinute / 60_000, now),
        lastSeen: now,
      };
      this.buckets.set(ip, entry);
    }
    entry.lastSeen = now;
    return entry.bucket.tryConsume(now);
  }

  private sweep(now: number): void {
    for (const [ip, entry] of this.buckets)
      if (now - entry.lastSeen > this.idleEvictMs) this.buckets.delete(ip);
  }

  get size(): number {
    return this.buckets.size;
  }
}
