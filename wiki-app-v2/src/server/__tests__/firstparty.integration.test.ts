import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { buildApp } from "../app.js";
import { getDb, closeDb } from "../db/index.js";
import { resetAuth } from "../auth/config.js";
import { users, identities, spaces, spaceMembers, pages, branches } from "../db/schema.js";
import { installPluginFromZip, getEnabledPluginNodeTypes, getEnabledPluginMarkTypes } from "../services/plugin.service.js";
import { validateContent } from "../../shared/blockIds.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_SECRET = "test-firstparty-0123456789abcdef0123456789abcdef";
const DB_PATH = `data/test-firstparty-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-firstparty-repo-${randomBytes(4).toString("hex")}`;
const TEST_EMAIL = `firstparty-${randomBytes(4).toString("hex")}@test.local`;

const WEBCLIPPER_ZIP = path.resolve(__dirname, "../../../test-fixtures/web-clipper-plugin.zip");
const DRAWIO_ZIP = path.resolve(__dirname, "../../../test-fixtures/drawio-embed-plugin.zip");

let app: Awaited<ReturnType<typeof buildApp>>;
let rootBranchId: string;
let sessionCookie: string;
let fixtureServer: Server;
let fixtureBase: string;

const DRAWIO_DOC = {
  type: "doc",
  content: [
    { type: "drawioEmbed", attrs: { title: "Network map", xml: "<mxfile><diagram/></mxfile>" } },
    { type: "paragraph", content: [{ type: "text", text: "below the diagram" }] },
  ],
};

beforeAll(async () => {
  closeDb();
  resetAuth();
  try { rmSync(DB_PATH, { force: true }); } catch {}
  try { rmSync(`${DB_PATH}-wal`, { force: true }); } catch {}
  try { rmSync(`${DB_PATH}-shm`, { force: true }); } catch {}
  try { rmSync(REPO_PATH, { recursive: true, force: true }); } catch {}
  // The web-clipper fetch targets the local fixture server (127.0.0.1), which
  // the SSRF guard blocks by default — allow it for the success path; the
  // guard's own tests temporarily unset the env.
  process.env.ALLOW_PRIVATE_CLIP_HOSTS = "1";
  process.env.DB_PATH = DB_PATH;
  process.env.GIT_REPO_ROOT = REPO_PATH;
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
    "/sign-up/*": false,
    "/sign-in/*": false,
  });

  // Seed the user FIRST — auditLog has an FK to users.id (foreign_keys=ON),
  // and the web-clipper plugin install below writes an audit row for the
  // actor. The plugin is INSTALLED BEFORE the app boots: Fastify refuses to
  // add routes after ready(), so boot-time registration (gated by a
  // per-request enabled-check) is the only way its server route exists at all
  // in-process. This mirrors a restart-after-install in production.
  const { db } = getDb();
  const seedUserId = crypto.randomUUID();
  await db.insert(users).values({
    id: seedUserId, name: "First-Party Tester", email: TEST_EMAIL, emailVerified: true,
  });
  await db.insert(identities).values({
    id: crypto.randomUUID(), accountId: seedUserId, providerId: "credential", userId: seedUserId,
    password: await hashPassword("TestPass-1234"),
  });
  await db.update(users).set({ isAdmin: true }).where(eq(users.email, TEST_EMAIL));

  await installPluginFromZip(readFileSync(WEBCLIPPER_ZIP), seedUserId);

  app = await buildApp();

  const spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "First-Party Space", createdBy: seedUserId });
  await db.insert(spaceMembers).values({ spaceId, userId: seedUserId, role: "admin" });

  const pageId = crypto.randomUUID();
  rootBranchId = crypto.randomUUID();
  await db.insert(pages).values({
    id: pageId, slug: "test-root", title: "Test Root", ownerId: seedUserId,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world!" }] }] },
  });
  await db.insert(branches).values({
    id: rootBranchId, pageId, spaceId, createdBy: seedUserId, parentBranchId: null, position: 0,
  });

  const signInRes = await app.inject({
    method: "POST", url: "/api/auth/sign-in/email",
    payload: { email: TEST_EMAIL, password: "TestPass-1234" },
  });
  const raw = signInRes.headers["set-cookie"];
  sessionCookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  expect(sessionCookie).toBeTruthy();

  // Local fixture server the web-clipper fetches in the success test.
  fixtureServer = http.createServer((req, res) => {
    if (req.url === "/article") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><head>" +
          '<title>Test Article</title>' +
          '<meta name="description" content="A test excerpt.">' +
          '<meta property="og:site_name" content="Fixture Site">' +
          "</head><body><p>Body text that should NOT appear in the clip metadata.</p></body></html>"
      );
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const addr = fixtureServer.address();
  fixtureBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  await app.close();
  closeDb();
  resetAuth();
  try { rmSync(DB_PATH, { force: true }); } catch {}
  try { rmSync(`${DB_PATH}-wal`, { force: true }); } catch {}
  try { rmSync(`${DB_PATH}-shm`, { force: true }); } catch {}
  try { rmSync(REPO_PATH, { recursive: true, force: true }); } catch {}
  rmSync(path.resolve(__dirname, "../../../data/plugins/web-clipper"), { recursive: true, force: true });
  rmSync(path.resolve(__dirname, "../../../data/plugins/drawio-embed"), { recursive: true, force: true });
});

function clip(payload: unknown, cookie?: string) {
  return app.inject({
    method: "POST",
    url: "/api/plugins/web-clipper/clip",
    headers: cookie ? { cookie, "content-type": "application/json" } : { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}

function setPluginEnabled(id: string, enabled: boolean) {
  return app.inject({
    method: "PUT",
    url: `/api/plugins/${id}/enabled`,
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    payload: JSON.stringify({ enabled }),
  });
}

function multipartUpload(zipData: Buffer, filename: string) {
  const boundary = `----test-${randomBytes(4).toString("hex")}`;
  return app.inject({
    method: "POST",
    url: "/api/plugins",
    headers: { cookie: sessionCookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
      zipData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

describe("first-party plugins (slice-13)", () => {
  it("web-clipper route exists at boot but 404s while the plugin is disabled (guard)", async () => {
    const res = await clip({ url: fixtureBase + "/article" }, sessionCookie);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toBe("Plugin not found");
  });

  it("enables the pre-installed web-clipper", async () => {
    const res = await setPluginEnabled("web-clipper", true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).enabled).toBe(true);
  });

  it("clips a real page and returns extracted metadata", async () => {
    const res = await clip({ url: fixtureBase + "/article" }, sessionCookie);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.title).toBe("Test Article");
    expect(body.siteName).toBe("Fixture Site");
    expect(body.description).toBe("A test excerpt.");
    expect(body.url).toBe(fixtureBase + "/article");
  });

  it("rejects non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/x"]) {
      const res = await clip({ url }, sessionCookie);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toMatch(/http/i);
    }
  });

  it("rejects an unauthenticated clip request", async () => {
    const res = await clip({ url: fixtureBase + "/article" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects private/link-local targets when the SSRF guard is on", async () => {
    delete process.env.ALLOW_PRIVATE_CLIP_HOSTS;
    try {
      const linkLocal = await clip({ url: "http://169.254.169.254/latest/meta-data/" }, sessionCookie);
      expect(linkLocal.statusCode).toBe(400);
      expect(JSON.parse(linkLocal.payload).error).toMatch(/SSRF/i);

      const loopback = await clip({ url: fixtureBase + "/article" }, sessionCookie);
      expect(loopback.statusCode).toBe(400);
      expect(JSON.parse(loopback.payload).error).toMatch(/SSRF/i);
    } finally {
      process.env.ALLOW_PRIVATE_CLIP_HOSTS = "1";
    }
  });

  it("web-clipper route 404s again after disable (guard flips both ways)", async () => {
    await setPluginEnabled("web-clipper", false);
    const res = await clip({ url: fixtureBase + "/article" }, sessionCookie);
    expect(res.statusCode).toBe(404);
  });

  it("installs the drawio-embed plugin through the real upload UI", async () => {
    const res = await multipartUpload(readFileSync(DRAWIO_ZIP), "drawio-embed-plugin.zip");
    expect(res.statusCode).toBe(201);
    const info = JSON.parse(res.payload) as { id: string; nodeTypes: string[]; enabled: boolean };
    expect(info.id).toBe("drawio-embed");
    expect(info.nodeTypes).toEqual(["drawioEmbed"]);
    expect(info.enabled).toBe(false);
  });

  it("rejects a drawioEmbed doc while the plugin is disabled (content model follows enabled plugins)", async () => {
    // Save via the real OCC route — validation runs against getEnabledPluginNodeTypes().
    const pageRes = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`, headers: { cookie: sessionCookie },
    });
    const page = JSON.parse(pageRes.payload);
    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/branches/${rootBranchId}/page/content`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: JSON.stringify({ content: DRAWIO_DOC, expectedUpdatedAt: page.updatedAt }),
    });
    expect(saveRes.statusCode).toBe(422);
    expect(JSON.parse(saveRes.payload).details.join(" ")).toContain("unknown node type");
  });

  it("accepts a drawioEmbed doc once the plugin is enabled (server-side node type contract)", async () => {
    const enabled = await setPluginEnabled("drawio-embed", true);
    expect(enabled.statusCode).toBe(200);

    const extraNodes = getEnabledPluginNodeTypes();
    const extraMarks = getEnabledPluginMarkTypes();
    expect(extraNodes.has("drawioEmbed")).toBe(true);

    const pageRes = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`, headers: { cookie: sessionCookie },
    });
    const page = JSON.parse(pageRes.payload);
    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/branches/${rootBranchId}/page/content`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: JSON.stringify({ content: DRAWIO_DOC, expectedUpdatedAt: page.updatedAt }),
    });
    expect(saveRes.statusCode).toBe(200);

    // And the validator itself accepts the node with the plugin enabled.
    const { doc, errors } = validateContent(DRAWIO_DOC, { extraNodeTypes: extraNodes, extraMarkTypes: extraMarks });
    expect(errors.filter((e) => e.includes("unknown node type"))).toEqual([]);
    expect((doc as { type: string }).type).toBe("doc");
  });

  it("rejects the drawioEmbed doc again after the plugin is disabled", async () => {
    await setPluginEnabled("drawio-embed", false);
    const pageRes = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`, headers: { cookie: sessionCookie },
    });
    const page = JSON.parse(pageRes.payload);
    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/branches/${rootBranchId}/page/content`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: JSON.stringify({ content: DRAWIO_DOC, expectedUpdatedAt: page.updatedAt }),
    });
    expect(saveRes.statusCode).toBe(422);
  });
});
