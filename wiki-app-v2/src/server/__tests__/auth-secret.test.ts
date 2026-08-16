import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("BETTER_AUTH_SECRET fail-closed behavior", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origSecret = process.env.BETTER_AUTH_SECRET;
  beforeEach(() => { delete process.env.BETTER_AUTH_SECRET; });
  afterEach(() => { if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv; else delete process.env.NODE_ENV; if (origSecret !== undefined) process.env.BETTER_AUTH_SECRET = origSecret; });

  it("does not throw with env var set in production", async () => {
    process.env.BETTER_AUTH_SECRET = "a-real-secret"; process.env.NODE_ENV = "production";
    const { getAuth, resetAuth } = await import("../auth/config.js"); resetAuth();
    expect(() => getAuth()).not.toThrow(); resetAuth();
  });
  it("throws in production when unset", async () => {
    process.env.NODE_ENV = "production"; delete process.env.BETTER_AUTH_SECRET;
    const { getAuth, resetAuth } = await import("../auth/config.js"); resetAuth();
    expect(() => getAuth()).toThrow(/BETTER_AUTH_SECRET must be set/); resetAuth();
  });
  it("does not throw in dev", async () => {
    process.env.NODE_ENV = "development"; delete process.env.BETTER_AUTH_SECRET;
    const { getAuth, resetAuth } = await import("../auth/config.js"); resetAuth();
    expect(() => getAuth()).not.toThrow(); resetAuth();
  });
});
