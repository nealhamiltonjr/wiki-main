import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";

// The declarative settings framework (§7.10b): the shared registry drives
// both the admin UI and server-side validation. These tests cover the
// registry itself, typed validation, and the def-driven list view.
import {
  registerSetting,
  getSettingDef,
  getSettingDefs,
  getSettingSections,
  validateSettingValue,
} from "../../../shared/settings.js";
import "../../../shared/settings-registry.js";

const TEST_DB_PATH = "./data/test-settings-framework.db";
process.env.DB_PATH = TEST_DB_PATH;
process.env.SETTINGS_ENCRYPTION_KEY = "framework-test-key-only";

let listSettings: typeof import("../settings.service.js").listSettings;
let setSetting: typeof import("../settings.service.js").setSetting;
let users: typeof import("../../db/schema.js").users;
let db: typeof import("../../db/index.js").db;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });

  ({ listSettings, setSetting } = await import("../settings.service.js"));
  ({ users } = await import("../../db/schema.js"));
  ({ db } = await import("../../db/index.js"));

  await db.insert(users).values({ id: "admin-1", email: "admin@example.com", name: "Admin", isAdmin: true, emailVerified: true });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
  }
});

describe("settings registry", () => {
  it("registers the built-in settings across expected sections", () => {
    const defs = getSettingDefs();
    const keys = defs.map((d) => d.key);
    expect(keys).toContain("site.name");
    expect(keys).toContain("smtp_pass");
    expect(keys).toContain("git_remote_url");
    expect(keys).toContain("sync_target_url");
    expect(keys).toContain("general.defaultTheme");
  });

  it("groups defs by section in registration order", () => {
    const sections = getSettingSections();
    const sectionNames = sections.map((s) => s.section);
    expect(sectionNames[0]).toBe("General");
    expect(sectionNames).toContain("Email");
    expect(sectionNames).toContain("Git");
    expect(sectionNames).toContain("Sync");
    expect(sectionNames).toContain("Security");
  });

  it("rejects duplicate registration", () => {
    expect(() =>
      registerSetting({ key: "site.name", section: "General", label: "Site name", type: "text" }),
    ).toThrow(/duplicate key/);
  });

  it("looks up a single def by key", () => {
    const def = getSettingDef("smtp_port");
    expect(def?.type).toBe("number");
    expect(def?.default).toBe(587);
    expect(getSettingDef("nope.missing")).toBeUndefined();
  });
});

describe("setting value validation", () => {
  it("accepts valid select values", () => {
    expect(validateSettingValue("general.defaultTheme", "dark")).toBeNull();
  });

  it("rejects select values outside the option list", () => {
    expect(validateSettingValue("general.defaultTheme", "neon")).toMatch(/not a valid option/);
  });

  it("requires booleans to be actual booleans", () => {
    expect(validateSettingValue("general.allowSignup", true)).toBeNull();
    expect(validateSettingValue("general.allowSignup", "yes")).toMatch(/Expected true\/false/);
  });

  it("requires numbers to be finite", () => {
    expect(validateSettingValue("smtp_port", 465)).toBeNull();
    expect(validateSettingValue("smtp_port", "abc")).toMatch(/Expected a number/);
  });

  it("requires text types to be strings", () => {
    expect(validateSettingValue("site.name", "My Wiki")).toBeNull();
    expect(validateSettingValue("site.name", 42)).toMatch(/Expected text/);
  });

  it("allows unknown keys without validation (backward compatible)", () => {
    expect(validateSettingValue("custom.anything", { nested: true })).toBeNull();
  });
});

describe("def-driven list view", () => {
  it("lists every registered def with its default when never written", async () => {
    const list = await listSettings();
    const site = list.find((s) => s.key === "site.name")!;
    expect(site.value).toBe("Wiki"); // def default, not yet written
    expect(site.isDefault).toBe(true);
    expect(site.section).toBe("General");
    expect(site.type).toBe("text");
  });

  it("shows stored values for written settings", async () => {
    await setSetting("site.name", "Home Lab", false, "admin-1");
    const list = await listSettings();
    const site = list.find((s) => s.key === "site.name")!;
    expect(site.value).toBe("Home Lab");
    expect(site.isDefault).toBe(false);
  });

  it("masks secret-typed defs even when written via a non-secret flag", async () => {
    // Registry is the source of truth for secrecy: a caller passing
    // isSecret=false for a secret-typed key must still be masked in the list.
    await setSetting("smtp_pass", "sup3rs3cret", false, "admin-1");
    const list = await listSettings();
    const entry = list.find((s) => s.key === "smtp_pass")!;
    expect(entry.isSecret).toBe(true);
    expect(entry.value).toBe("••••••••");
  });

  it("keeps stored value in the view for non-secret textarea defs", async () => {
    await setSetting("security.trustedOrigins", "https://a.example,https://b.example", false, "admin-1");
    const list = await listSettings();
    const entry = list.find((s) => s.key === "security.trustedOrigins")!;
    expect(entry.value).toContain("https://b.example");
    expect(entry.type).toBe("textarea");
  });
});
