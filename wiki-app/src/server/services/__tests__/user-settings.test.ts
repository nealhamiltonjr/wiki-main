import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";

const TEST_DB_PATH = "./data/test-user-settings.db";
process.env.DB_PATH = TEST_DB_PATH;

let listUserSettings: typeof import("../user-settings.service.js").listUserSettings;
let setUserSetting: typeof import("../user-settings.service.js").setUserSetting;
let users: typeof import("../../db/schema.js").users;
let db: typeof import("../../db/index.js").db;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });

  ({ listUserSettings, setUserSetting } = await import("../user-settings.service.js"));
  ({ users } = await import("../../db/schema.js"));
  ({ db } = await import("../../db/index.js"));

  await db.insert(users).values({ id: "u1", email: "u1@example.com", name: "U1", isAdmin: false, emailVerified: true });
  await db.insert(users).values({ id: "u2", email: "u2@example.com", name: "U2", isAdmin: false, emailVerified: true });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
  }
});

describe("user settings service", () => {
  it("stores and retrieves a setting for a user", async () => {
    await setUserSetting("u1", "editor.width", "full");
    const settings = await listUserSettings("u1");
    expect(settings["editor.width"]).toBe("full");
  });

  it("upserts on repeated writes for the same key", async () => {
    await setUserSetting("u1", "editor.width", "narrow");
    const settings = await listUserSettings("u1");
    expect(settings["editor.width"]).toBe("narrow");
  });

  it("keeps settings isolated per user - one user's settings never leak into another's", async () => {
    await setUserSetting("u2", "editor.width", "full");
    const u1Settings = await listUserSettings("u1");
    const u2Settings = await listUserSettings("u2");
    expect(u1Settings["editor.width"]).toBe("narrow");
    expect(u2Settings["editor.width"]).toBe("full");
  });

  it("supports multiple distinct keys per user", async () => {
    await setUserSetting("u1", "editor.defaultEditMode", false);
    const settings = await listUserSettings("u1");
    expect(settings["editor.width"]).toBe("narrow");
    expect(settings["editor.defaultEditMode"]).toBe(false);
  });
});
