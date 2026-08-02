import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemSettings } from "../db/schema.js";
import { encryptSecret, decryptSecret } from "./crypto.service.js";
import { getSettingDef, validateSettingValue, type SettingDef } from "../../shared/settings.js";
import "../../shared/settings-registry.js";

const MASK = "••••••••";

export interface SettingView extends SettingDef {
  value: unknown; // masked to MASK for secrets, else the stored value (or default)
  isSecret: boolean;
  isDefault: boolean;
  updatedAt: string;
}

/**
 * Full view of the settings the admin UI renders: every registered def (with
 * the stored value or the def's default when never written) PLUS any custom
 * keys that exist in the table but have no def (backward-compatible with the
 * raw key/value editor, still editable but untyped).
 */
export async function listSettings(): Promise<SettingView[]> {
  const rows = await db.select().from(systemSettings);
  const stored = new Map(rows.map((r) => [r.key, r]));
  const defs = await import("../../shared/settings.js").then((m) => m.getSettingDefs());

  const views: SettingView[] = defs.map((def) => {
    const row = stored.get(def.key);
    const isSecret = def.type === "secret";
    const hasValue = row !== undefined;
    const value = !hasValue ? def.default : isSecret ? MASK : row!.value;
    return {
      ...def,
      value,
      isSecret,
      isDefault: !hasValue,
      updatedAt: row?.updatedAt.toISOString() ?? "",
    };
  });

  // Custom (unregistered) keys — kept so no stored setting is ever invisible
  // or uneditable after the framework lands.
  for (const [key, row] of stored) {
    if (views.some((v) => v.key === key)) continue;
    views.push({
      key,
      section: "Custom",
      label: key,
      type: "text",
      value: row.isSecret ? MASK : row.value,
      isSecret: row.isSecret,
      isDefault: false,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  return views;
}

/** Internal use only (e.g. auth provider config at boot) - returns the REAL decrypted value. */
export async function getSettingValue(key: string): Promise<unknown | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  if (!row) return null;
  if (!row.isSecret) return row.value;
  return JSON.parse(decryptSecret(row.value as string));
}

export async function setSetting(key: string, value: unknown, isSecret: boolean, updatedBy: string) {
  // Registered secret-typed defs are ALWAYS stored encrypted, even if a caller
  // passes isSecret=false — the registry is the source of truth for whether a
  // key holds a secret, not the write request.
  const def = getSettingDef(key);
  if (def?.type === "secret") isSecret = true;
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
