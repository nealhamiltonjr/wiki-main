import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret, looksEncrypted, assertEncryptionKeyConfigured } from "../crypto.service.js";

describe("crypto.service", () => {
  const origKey = process.env.SETTINGS_ENCRYPTION_KEY;
  const origNodeEnv = process.env.NODE_ENV;
  beforeEach(() => { process.env.SETTINGS_ENCRYPTION_KEY = "test-key-with-sufficient-entropy-aaaaaaaa"; delete process.env.NODE_ENV; });
  afterEach(() => { if (origKey !== undefined) process.env.SETTINGS_ENCRYPTION_KEY = origKey; else delete process.env.SETTINGS_ENCRYPTION_KEY; if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv; else delete process.env.NODE_ENV; });

  it("round-trips", () => { const p = "secret123"; const e = encryptSecret(p); expect(e).not.toBe(p); expect(decryptSecret(e)).toBe(p); });
  it("different IV each time", () => { const a = encryptSecret("x"); const b = encryptSecret("x"); expect(a).not.toBe(b); });
  it("throws on malformed", () => { expect(() => decryptSecret("bad")).toThrow(/Malformed/); });
  it("throws on tampered ciphertext", () => { const e = encryptSecret("s"); const [iv, tag] = e.split(":"); expect(() => decryptSecret([iv, tag, "00"].join(":"))).toThrow(); });
  it("looksEncrypted", () => { expect(looksEncrypted(null)).toBe(false); expect(looksEncrypted("plain")).toBe(false); expect(looksEncrypted(encryptSecret("x"))).toBe(true); });
  it("fail-closed in prod", () => { delete process.env.SETTINGS_ENCRYPTION_KEY; process.env.NODE_ENV = "production"; expect(() => assertEncryptionKeyConfigured()).toThrow(/SETTINGS_ENCRYPTION_KEY/); });
});
