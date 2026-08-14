import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { buildApp } from "../app.js";
import { getDb, closeDb } from "../db/index.js";
import { resetAuth } from "../auth/config.js";
import { users, identities, spaces, spaceMembers } from "../db/schema.js";

// §13.6 code pages: a page whose whole content is a plain source/config
// string rather than a Tiptap doc. Exercises the API contract end-to-end —
// create (pageType/language), read (string content), save (string-only
// validation), and search (raw text is indexed).
const TEST_SECRET = "test-code-pages-0123456789abcdef0123456789ab";
const DB_PATH = `data/test-code-pages-${randomBytes(4).toString("hex")}.db`;
const TEST_EMAIL = `codepages-${randomBytes(4).toString("hex")}@test.local`;

let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let spaceId: string;
let sessionCookie: string;

beforeAll(async () => {
  closeDb();
  resetAuth();

  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}

  process.env.DB_PATH = DB_PATH;
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";

  app = await buildApp();
  const { db } = getDb();

  userId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, name: "Code Page Tester", email: TEST_EMAIL, emailVerified: true });
  await db.insert(identities).values({
    id: crypto.randomUUID(), accountId: userId, providerId: "credential", userId,
    password: await hashPassword("TestPass-1234"),
  });

  spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "Code Page Test Space", createdBy: userId });
  await db.insert(spaceMembers).values({ spaceId, userId, role: "admin" });

  const signInRes = await app.inject({
    method: "POST", url: "/api/auth/sign-in/email",
    payload: { email: TEST_EMAIL, password: "TestPass-1234" },
  });
  const raw = signInRes.headers["set-cookie"];
  sessionCookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
});

afterAll(async () => {
  await app.close();
  closeDb();
  resetAuth();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}
});

async function createCodePage(slug: string, language: string, title?: string) {
  const res = await app.inject({
    method: "POST", url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie: sessionCookie },
    payload: { slug, title, pageType: "code", language },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { branchId: string; pageId: string };
}

describe("§13.6 code pages", () => {
  it("creates a code page with pageType + language and reads back a string body", async () => {
    const { branchId } = await createCodePage("deploy-script", "bash", "Deploy Script");

    const res = await app.inject({
      method: "GET", url: `/api/branches/${branchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pageType).toBe("code");
    expect(body.language).toBe("bash");
    expect(body.content).toBe("");
  });

  it("saves a string body and persists it verbatim", async () => {
    const { branchId } = await createCodePage("config", "yaml", "Config");
    const load = await app.inject({
      method: "GET", url: `/api/branches/${branchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const { updatedAt } = load.json();

    const code = "version: 1\nname: demo\n";
    const save = await app.inject({
      method: "PUT", url: `/api/branches/${branchId}/page/content`,
      headers: { cookie: sessionCookie },
      payload: { content: code, expectedUpdatedAt: updatedAt },
    });
    expect(save.statusCode).toBe(200);

    const reload = await app.inject({
      method: "GET", url: `/api/branches/${branchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(reload.json().content).toBe(code);
  });

  it("rejects a non-string body for a code page (422)", async () => {
    const { branchId } = await createCodePage("bad-code", "python", "Bad Code");
    const load = await app.inject({
      method: "GET", url: `/api/branches/${branchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const { updatedAt } = load.json();

    const save = await app.inject({
      method: "PUT", url: `/api/branches/${branchId}/page/content`,
      headers: { cookie: sessionCookie },
      payload: { content: { type: "doc", content: [{ type: "paragraph" }] }, expectedUpdatedAt: updatedAt },
    });
    expect(save.statusCode).toBe(422);
    expect(save.json().error).toBe("Invalid content");
  });

  it("indexes raw code text for search", async () => {
    const { branchId } = await createCodePage("searchable-script", "bash", "Searchable");
    const load = await app.inject({
      method: "GET", url: `/api/branches/${branchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const { updatedAt } = load.json();

    await app.inject({
      method: "PUT", url: `/api/branches/${branchId}/page/content`,
      headers: { cookie: sessionCookie },
      payload: { content: "#!/bin/bash\necho kraken-release\n", expectedUpdatedAt: updatedAt },
    });

    const search = await app.inject({
      method: "GET", url: "/api/search?q=kraken-release",
      headers: { cookie: sessionCookie },
    });
    expect(search.statusCode).toBe(200);
    const results = (search.json() as { results: { slug: string }[] }).results;
    expect(results.some((r) => r.slug === "searchable-script")).toBe(true);
  });
});
