/**
 * Small in-memory fixed-window rate limiter (brief §3.2: the public share-link
 * password-check endpoint gets its own limiter on top of better-auth's). Not
 * a replacement for a distributed limiter — this app is single-process.
 * Per-process state is fine here; a restart resets counters, which is safe
 * for brute-force protection purposes (an attacker gains nothing from the
 * reset).
 */

type Entry = { count: number; resetAt: number };

export class InMemoryRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly buckets = new Map<string, Entry>();

  constructor(opts: { windowMs: number; max: number }) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
  }

  /** Returns true when the key is allowed, false when it exceeds the limit. */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    entry.count += 1;
    if (entry.count > this.max) return false;
    return true;
  }

  /** Removes expired entries so the map can't grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(key);
    }
  }
}
