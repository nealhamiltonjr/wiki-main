import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const DEV_KEY_MATERIAL = "wiki-app-dev-encryption-key-not-for-production";
const SALT = "wiki-app-settings-salt-v2";

function getKey(): Buffer {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) {
    const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
    if (nodeEnv === "production") {
      throw new Error(
        "SETTINGS_ENCRYPTION_KEY is not set. Required in production to encrypt " +
          "system_settings secrets. Generate one with: " +
          "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    if (nodeEnv !== "test") {
      console.warn("[crypto] SETTINGS_ENCRYPTION_KEY not set — using dev key.");
    }
    return scryptSync(DEV_KEY_MATERIAL, SALT, 32);
  }
  return scryptSync(secret, SALT, 32);
}

export function assertEncryptionKeyConfigured(): void { getKey(); }

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted value");
  const [ivHex, authTagHex, dataHex] = parts;
  if (!ivHex || !authTagHex || !dataHex) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf-8");
}

export function looksEncrypted(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[0-9a-f]+$/i.test(p));
}
