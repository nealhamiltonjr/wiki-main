import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";

// Git flush pipeline (§8 step 10): autosave commits write real Markdown content
// to the content repo with the page's id in the commit message (the slice gate),
// manual snapshots carry a user-supplied message with a valid git ident, and the
// history read API serves both back through getPageHistory.

const TEST_DB_PATH = `data/test-git-service-${process.pid}.db`;
const TEST_REPO = `data/test-git-service-repo-${process.pid}`;
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO;

let initGitRepo: typeof import("../git.service.js").initGitRepo;
let commitPageChange: typeof import("../git.service.js").commitPageChange;
let commitManualSnapshot: typeof import("../git.service.js").commitManualSnapshot;
let getPageHistory: typeof import("../git.service.js").getPageHistory;
let getFileContentAtCommit: typeof import("../git.service.js").getFileContentAtCommit;
let getRepoStatus: typeof import("../git.service.js").getRepoStatus;
let getRepoLog: typeof import("../git.service.js").getRepoLog;
let db: ReturnType<typeof import("../../db/index.js").getDb>["db"];
let users: typeof import("../../db/schema.js").users;
let spaces: typeof import("../../db/schema.js").spaces;
let branches: typeof import("../../db/schema.js").branches;
let pages: typeof import("../../db/schema.js").pages;

beforeAll(async () => {
  for (const p of [TEST_DB_PATH, TEST_REPO]) {
    rmSync(p, { recursive: true, force: true });
  }
  mkdirSync("./data", { recursive: true });

  ({ initGitRepo, commitPageChange, commitManualSnapshot, getPageHistory, getFileContentAtCommit, getRepoStatus, getRepoLog } = await import("../git.service.js"));
  const { getDb } = await import("../../db/index.js");
  db = getDb().db;
  ({ users, spaces, branches, pages } = await import("../../db/schema.js"));

  await db.insert(users).values({ id: "u1", name: "U1", email: "u1@example.com", isAdmin: true });
  await db.insert(spaces).values({ id: "s1", name: "Home Lab", createdBy: "u1" });

  await initGitRepo();
});

afterAll(() => {
  for (const p of [TEST_DB_PATH, TEST_REPO]) {
    rmSync(p, { recursive: true, force: true });
    rmSync(p + "-wal", { force: true });
    rmSync(p + "-shm", { force: true });
  }
});

async function createPage(pageId: string, slug: string, content: unknown) {
  await db.insert(pages).values({ id: pageId, slug, title: slug, ownerId: "u1", content: content as never });
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

describe("git flush pipeline", () => {
  it("commits REAL content with the page id in the commit message (slice gate)", async () => {
    await commitPageChange("p1", await createPage("p1", "home", simpleDoc("Hello world")));

    // The gate: `git log` on the content repo shows a real commit with the
    // page's id in the message.
    const log = execSync("git log --oneline", { cwd: TEST_REPO, encoding: "utf-8" });
    expect(log).toContain("page:p1");

    // The exported file exists and contains the ACTUAL content, plus frontmatter.
    const file = execSync("git show HEAD:home-lab/home.md", { cwd: TEST_REPO, encoding: "utf-8" });
    expect(file).toContain("Hello world");
    expect(file).toContain("title: \"home\"");
  });

  it("getPageHistory lists both autosave and manual snapshot commits for a page", async () => {
    const branchId = await createPage("p2", "server", simpleDoc("Serve stuff"));
    await commitPageChange("p2", branchId);
    await commitManualSnapshot("p2", "pre-upgrade backup", "u1");

    const history = await getPageHistory("p2");
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((h) => h.message.includes("Snapshot: page:p2:"))).toBe(true);
    expect(history.some((h) => h.message.includes("Update - server"))).toBe(true);
  });

  it("getFileContentAtCommit returns the Markdown for an autosave commit", async () => {
    const branchId = await createPage("p3", "network", simpleDoc("Bridge config"));
    await commitPageChange("p3", branchId);
    const [latest] = await getPageHistory("p3");
    if (!latest) throw new Error("expected at least one commit for p3");

    const md = await getFileContentAtCommit("p3", latest.hash);
    expect(md).toContain("Bridge config");
    expect(md).toContain("title: \"network\"");
  });

  it("reports repo status and log with real commits", async () => {
    await commitPageChange("p4", await createPage("p4", "vms", simpleDoc("Nodes")));
    const status = await getRepoStatus();
    expect(status.branch).toBe("master");
    expect(status.dirty).toBe(0);
    expect(status.headHash).toMatch(/^[0-9a-f]{40}$/);
    expect(status.sizeBytes).toBeGreaterThan(0);

    const log = await getRepoLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]?.message).toContain("page:p4");
    expect(log[0]?.author).toBeTruthy();
  });

  it("history is empty for a page with no commits (repo inited, page never flushed)", async () => {
    const history = await getPageHistory("does-not-exist");
    expect(history).toEqual([]);
  });
});
