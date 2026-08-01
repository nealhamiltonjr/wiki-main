import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";

const TEST_DB_PATH = "./data/test-settings.db";
process.env.DB_PATH = TEST_DB_PATH;
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";

let listSettings: typeof import("../settings.service.js").listSettings;
let getSettingValue: typeof import("../settings.service.js").getSettingValue;
let setSetting: typeof import("../settings.service.js").setSetting;
let deleteSetting: typeof import("../settings.service.js").deleteSetting;
let users: typeof import("../../db/schema.js").users;
let db: typeof import("../../db/index.js").db;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });

  ({ listSettings, getSettingValue, setSetting, deleteSetting } = await import("../settings.service.js"));
  ({ users } = await import("../../db/schema.js"));
  ({ db } = await import("../../db/index.js"));

  await db.insert(users).values({ id: "admin-1", email: "admin@example.com", name: "Admin", isAdmin: true, emailVerified: true });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
  }
});

describe("settings service", () => {
  it("stores and retrieves a plain (non-secret) setting", async () => {
    await setSetting("theme.default", "dark", false, "admin-1");
    expect(await getSettingValue("theme.default")).toBe("dark");
  });

  it("encrypts a secret setting at rest and decrypts it correctly on internal read", async () => {
    await setSetting("email.apiKey", "re_live_abc123", true, "admin-1");
    const raw = await db.select().from((await import("../../db/schema.js")).systemSettings);
    const row = raw.find((r) => r.key === "email.apiKey")!;
    expect(row.value).not.toContain("re_live_abc123"); // never stored in plaintext
    expect(await getSettingValue("email.apiKey")).toBe("re_live_abc123"); // but decrypts correctly for internal use
  });

  it("masks secret values in the list view, never leaking them even to the admin UI", async () => {
    const list = await listSettings();
    const secretEntry = list.find((s) => s.key === "email.apiKey")!;
    expect(secretEntry.value).toBe("••••••••");
    expect(JSON.stringify(secretEntry.value)).not.toContain("re_live");
  });

  it("upserts on repeated writes rather than erroring on a duplicate key", async () => {
    await setSetting("theme.default", "light", false, "admin-1");
    expect(await getSettingValue("theme.default")).toBe("light");
  });

  it("deletes a setting", async () => {
    await setSetting("temp.value", 123, false, "admin-1");
    await deleteSetting("temp.value");
    expect(await getSettingValue("temp.value")).toBeNull();
  });
});
