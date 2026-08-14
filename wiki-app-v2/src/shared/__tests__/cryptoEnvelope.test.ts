import { describe, it, expect } from "vitest";
import {
  createEnvelope,
  unlockEnvelope,
  sealContent,
  validateEnvelope,
  EncryptionUnlockError,
  type CryptoEnvelope,
} from "../cryptoEnvelope.js";

describe("cryptoEnvelope", () => {
  it("round-trips an object body through protect → unlock", async () => {
    const body = { type: "doc", content: [{ type: "paragraph" }] };
    const envelope = await createEnvelope(body, "correct horse battery staple");
    validateEnvelope(envelope);

    const { plaintext } = await unlockEnvelope(envelope, "correct horse battery staple");
    expect(plaintext).toEqual(body);
  });

  it("round-trips a string body (code pages)", async () => {
    const envelope = await createEnvelope("echo hello\n", "p@ss");
    const { plaintext } = await unlockEnvelope(envelope, "p@ss");
    expect(plaintext).toBe("echo hello\n");
  });

  it("rejects a wrong passphrase with a typed error", async () => {
    const envelope = await createEnvelope({ secret: 1 }, "right");
    await expect(unlockEnvelope(envelope, "wrong")).rejects.toBeInstanceOf(EncryptionUnlockError);
  });

  it("re-seals new content with the same DEK (edits do not re-derive the KEK)", async () => {
    const envelope = await createEnvelope({ v1: "a" }, "pass");
    const { dek } = await unlockEnvelope(envelope, "pass");

    const newContent = await sealContent({ v2: "b" }, dek);
    const reSealed: CryptoEnvelope = { ...envelope, content: newContent };

    // The wrapped DEK + KDF are unchanged; only the body changed.
    expect(reSealed.dek).toEqual(envelope.dek);
    expect(reSealed.kdf).toEqual(envelope.kdf);
    const { plaintext } = await unlockEnvelope(reSealed, "pass");
    expect(plaintext).toEqual({ v2: "b" });
  });

  it("validateEnvelope rejects malformed envelopes", () => {
    expect(() => validateEnvelope(null)).toThrow();
    expect(() => validateEnvelope({ v: 2 })).toThrow();
    expect(() => validateEnvelope({ v: 1, kdf: { alg: "X", salt: "AAAA", iterations: 100_000 }, dek: { iv: "AAAA", data: "AAAA" }, content: { iv: "AAAA", data: "AAAA" } })).toThrow();
  });
});
