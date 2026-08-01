import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { userSettings } from "../db/schema.js";

export async function listUserSettings(userId: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setUserSetting(userId: string, key: string, value: unknown) {
  await db
    .insert(userSettings)
    .values({ userId, key, value: value as any })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.key],
      set: { value: value as any },
    });
}
