import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value correctly", async () => {
    const { encryptSecret, decryptSecret } = await import("../crypto.service.js");
    const plaintext = "sk-real-looking-secret-abc123";
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext); // never store it in a recognizable form
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", async () => {
    const { encryptSecret } = await import("../crypto.service.js");
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
  });

  it("throws on a tampered ciphertext rather than silently returning garbage", async () => {
    const { encryptSecret, decryptSecret } = await import("../crypto.service.js");
    const encrypted = encryptSecret("some-secret");
    const [iv, tag, data] = encrypted.split(":");
    const tampered = [iv, tag, data!.slice(0, -2) + "ff"].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws a clear error if the encryption key isn't configured", async () => {
    const original = process.env.SETTINGS_ENCRYPTION_KEY;
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    const { encryptSecret } = await import("../crypto.service.js");
    expect(() => encryptSecret("x")).toThrow(/SETTINGS_ENCRYPTION_KEY/);
    process.env.SETTINGS_ENCRYPTION_KEY = original;
  });
});
