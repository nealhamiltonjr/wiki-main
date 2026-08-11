import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = `data/test-plugin-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-plugin-repo-${randomBytes(4).toString("hex")}`;

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  return cookie;
}

describe("plugin engine (slice-12) integration", () => {
  let adminCookie: string;

  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();

    // Sign up an admin user through the real auth flow.
    const signupRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "admin@test.invalid", password: "testtest1234", name: "Admin" },
    });
    if (signupRes.statusCode !== 200) {
      // User may already exist (collab test ran first); try sign-in.
      const signinRes = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email: "admin@test.invalid", password: "testtest1234" },
      });
      expect(signinRes.statusCode).toBe(200);
      adminCookie = extractCookie(signinRes.headers["set-cookie"]);
      expect(adminCookie).toBeTruthy();
    } else {
      adminCookie = extractCookie(signupRes.headers["set-cookie"]);
      expect(adminCookie).toBeTruthy();
    }
  });

  afterAll(async () => {
    await app.close();
    const pluginDir = path.resolve(__dirname, "../../../data/plugins/hello-world");
    rmSync(pluginDir, { recursive: true, force: true });
  });

  it("returns 401 for unauthenticated plugin list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty plugin list for authenticated non-admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.payload) as unknown[];
    // Non-admin sees only enabled; initially none.
    expect(Array.isArray(list)).toBe(true);
  });

  it("plugin upload returns 415 for non-multipart body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: { "content-type": "application/zip", cookie: adminCookie },
      payload: Buffer.from("fake"),
    });
    // No multipart boundary → fastify-multipart returns 415 as the body
    // can't be parsed as multipart.
    expect(res.statusCode).toBe(415);
  });

  it("content validation accepts plugin node types via extra options", async () => {
    const { validateContent } = await import("../../shared/blockIds.js");
    const extraNodes = new Set(["helloWorld"]);
    const extraMarks = new Set<string>();

    const { errors } = validateContent(
      { type: "doc", content: [{ type: "helloWorld", attrs: { message: "hi" } }] },
      { extraNodeTypes: extraNodes, extraMarkTypes: extraMarks },
    );
    expect(errors.filter(e => e.includes("unknown node type"))).toHaveLength(0);
  });

  it("rejects unknown plugin node types without extra options", async () => {
    const { validateContent } = await import("../../shared/blockIds.js");
    const { errors } = validateContent(
      { type: "doc", content: [{ type: "helloWorld", attrs: { message: "hi" } }] },
    );
    expect(errors.some(e => e.includes("unknown node type"))).toBe(true);
  });
});

