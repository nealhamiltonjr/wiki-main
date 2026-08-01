import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemSettings } from "../db/schema.js";
import { encryptSecret, decryptSecret } from "./crypto.service.js";

const MASK = "••••••••";

export interface SettingView {
  key: string;
  value: unknown; // masked to MASK for secrets
  isSecret: boolean;
  updatedAt: string;
}

export async function listSettings(): Promise<SettingView[]> {
  const rows = await db.select().from(systemSettings);
  return rows.map((r) => ({
    key: r.key,
    value: r.isSecret ? MASK : r.value,
    isSecret: r.isSecret,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Internal use only (e.g. auth provider config at boot) - returns the REAL decrypted value. */
export async function getSettingValue(key: string): Promise<unknown | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  if (!row) return null;
  if (!row.isSecret) return row.value;
  return JSON.parse(decryptSecret(row.value as string));
}

export async function setSetting(key: string, value: unknown, isSecret: boolean, updatedBy: string) {
  const storedValue = isSecret ? encryptSecret(JSON.stringify(value)) : (value as any);
  await db
    .insert(systemSettings)
    .values({ key, value: storedValue, isSecret, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: storedValue, isSecret, updatedBy, updatedAt: new Date() },
    });
}

export async function deleteSetting(key: string) {
  await db.delete(systemSettings).where(eq(systemSettings.key, key));
}
