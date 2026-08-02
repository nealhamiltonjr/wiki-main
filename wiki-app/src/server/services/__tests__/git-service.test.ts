import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Git remote push/pull/status/import (§7.10c/d). Uses a local "remote" repo
// (a bare repo on disk) so no network is required. The git service reads
// remote config from settings at call time, so tests write settings first.

const TEST_DB_PATH = "./data/test-git-service.db";
const TEST_REPO = "./data/test-git-service-repo";
const TEST_REMOTE = "./data/test-git-service-remote.git";
const TEST_SHADOW = "./data/repo-shadow";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO;
process.env.SETTINGS_ENCRYPTION_KEY = "git-service-test-key-only";

let initGitRepo: typeof import("../git.service.js").initGitRepo;
let commitPageChange: typeof import("../git.service.js").commitPageChange;
let getRepoStatus: typeof import("../git.service.js").getRepoStatus;
let getRepoLog: typeof import("../git.service.js").getRepoLog;
let testRemote: typeof import("../git.service.js").testRemote;
let pushToRemote: typeof import("../git.service.js").pushToRemote;
let pullFromRemote: typeof import("../git.service.js").pullFromRemote;
let setSetting: typeof import("../settings.service.js").setSetting;
let db: typeof import("../../db/index.js").db;
let users: typeof import("../../db/schema.js").users;
let spaces: typeof import("../../db/schema.js").spaces;
let branches: typeof import("../../db/schema.js").branches;
let pages: typeof import("../../db/schema.js").pages;

beforeAll(async () => {
  for (const p of [TEST_DB_PATH, TEST_REPO, TEST_REMOTE, TEST_SHADOW]) {
    rmSync(p, { recursive: true, force: true });
  }
  mkdirSync("./data", { recursive: true });
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });

  ({ initGitRepo, commitPageChange, getRepoStatus, getRepoLog, testRemote, pushToRemote, pullFromRemote } = await import("../git.service.js"));
  ({ setSetting } = await import("../settings.service.js"));
  ({ db } = await import("../../db/index.js"));
  ({ users, spaces, branches, pages } = await import("../../db/schema.js"));

  await db.insert(users).values({ id: "u1", email: "u1@example.com", name: "U1", isAdmin: true, emailVerified: true });
  await db.insert(spaces).values({ id: "s1", name: "Home Lab", createdBy: "u1" });

  // Set up a bare "remote" so push/pull targets exist.
  mkdirSync(TEST_REMOTE, { recursive: true });
  execSync("git init --bare --initial-branch=main", { cwd: TEST_REMOTE, stdio: "pipe" });

  await initGitRepo();
  // Remote config lives in settings so it can change without a restart.
  // Use an absolute path: relative URLs resolve against the repo cwd, not CWD.
  await setSetting("git_remote_url", path.resolve(TEST_REMOTE), false, "u1");
  await setSetting("git_remote_branch", "main", false, "u1");
});

afterAll(() => {
  for (const p of [TEST_DB_PATH, TEST_REPO, TEST_REMOTE, TEST_SHADOW]) {
    rmSync(p, { recursive: true, force: true });
    rmSync(p + "-wal", { force: true });
    rmSync(p + "-shm", { force: true });
  }
});

async function createPage(pageId: string, slug: string, content: unknown) {
  await db.insert(pages).values({ id: pageId, slug, ownerId: "u1", content: content as any });
  const branchId = `b-${pageId}`;
  await db.insert(branches).values({
    id: branchId, pageId, parentBranchId: null, spaceId: "s1", visibility: "inherit", isSystem: false, createdBy: "u1",
  });
  return branchId;
}

const simpleDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("git service remote operations", () => {
  it("reports repo status with branch, clean tree, and remote config", async () => {
    await commitPageChange("p1", await createPage("p1", "home", simpleDoc("Hello world")));
    const status = await getRepoStatus();
    expect(status.branch).toBe("master");
    expect(status.dirty).toBe(0);
    expect(status.remoteUrl).toBe(path.resolve(TEST_REMOTE));
    expect(status.remoteBranch).toBe("main");
    expect(status.headHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pushes the local branch to the configured remote", async () => {
    const res = await pushToRemote();
    expect(res.pushed).toBe(true);
    // The bare remote now has our commit on main.
    const remoteLog = execSync("git log --oneline main", { cwd: TEST_REMOTE, encoding: "utf-8" });
    expect(remoteLog).toContain("page:p1");
  });

  it("testRemote reports reachable when the configured branch exists on the remote", async () => {
    const result = await testRemote();
    expect(result.reachable).toBe(true);
    expect(result.message).toMatch(/exists/);
  });

  it("logs recent commits with authors", async () => {
    const log = await getRepoLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]?.message).toContain("page:p1");
    expect(log[0]?.author).toBeTruthy();
  });
});
