import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * The app-level encryption key lives in an environment variable, never in the
 * database - brief §3.9's explicit requirement for any secret in
 * `system_settings` (OAuth client secrets, email API keys, Git tokens).
 */
function getKey(): Buffer {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY is not set - required to store or read encrypted settings. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  // scrypt to derive a proper 32-byte key regardless of the raw secret's length/format.
  return scryptSync(secret, "wiki-app-settings-salt", 32);
}

/**
 * Checked eagerly at server startup (buildApp), not just lazily on first use -
 * found in testing that without this, saving the first secret setting produced
 * a confusing bare 500 deep in a request handler instead of a clear boot-time
 * failure. Same pattern better-auth already uses for BETTER_AUTH_SECRET.
 */
export function assertEncryptionKeyConfigured(): void {
  getKey();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decryptSecret(ciphertext: string): string {
  const [ivHex, authTagHex, dataHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !dataHex) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf-8");
}
