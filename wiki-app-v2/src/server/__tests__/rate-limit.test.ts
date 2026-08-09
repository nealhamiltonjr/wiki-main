import { describe, it, expect } from "vitest";
import { InMemoryRateLimiter } from "../lib/rate-limit.js";

describe("InMemoryRateLimiter", () => {
  it("allows requests up to the max and rejects beyond it", () => {
    const limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.check("key-a")).toBe(true);
    expect(limiter.check("key-a")).toBe(true);
    expect(limiter.check("key-a")).toBe(true);
    expect(limiter.check("key-a")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 1 });

    expect(limiter.check("first")).toBe(true);
    expect(limiter.check("first")).toBe(false);
    expect(limiter.check("second")).toBe(true);
  });

  it("resets the window after it elapses", () => {
    // A wide window keeps the test deterministic: with a 1ms window, the
    // matcher's own overhead between the two synchronous calls can exceed the
    // window and spuriously pass the second check (flaky under load).
    const limiter = new InMemoryRateLimiter({ windowMs: 100, max: 1 });

    expect(limiter.check("key")).toBe(true);
    expect(limiter.check("key")).toBe(false);

    // The window is 100ms; after a 250ms wait it has definitely expired.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(limiter.check("key")).toBe(true);
        resolve();
      }, 250);
    });
  });

  it("sweep removes expired entries", () => {
    const limiter = new InMemoryRateLimiter({ windowMs: 100, max: 5 });
    limiter.check("expired-key");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        limiter.sweep();
        expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(0);
        resolve();
      }, 250);
    });
  });
});
