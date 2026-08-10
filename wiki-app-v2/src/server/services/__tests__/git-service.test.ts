import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";

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

  it("getFileContentAtCommit reads an autosave's OWN content, not a stale snapshot, when a snapshot exists", async () => {
    const pageId = "p-stale";
    const branchId = await createPage(pageId, "stale", simpleDoc("v1 autosave"));
    await commitPageChange(pageId, branchId); // commit 1: v1

    await db.update(pages).set({ content: simpleDoc("v2 content") }).where(eq(pages.id, pageId));
    await commitPageChange(pageId, branchId); // commit 2: v2 autosave

    await commitManualSnapshot(pageId, "mid snapshot", "u1"); // commit 3: snapshot of v2

    await db.update(pages).set({ content: simpleDoc("v3 content") }).where(eq(pages.id, pageId));
    await commitPageChange(pageId, branchId); // commit 4: v3 autosave

    const history = await getPageHistory(pageId);
    const latest = history[0]!; // git log is newest-first → commit 4
    const md = await getFileContentAtCommit(pageId, latest.hash);
    expect(md).toContain("v3 content");
    expect(md).not.toContain("v2 content"); // would be the stale snapshot content under the old path

    // The snapshot commit itself still returns the snapshot's content.
    const snapshot = history.find((h) => h.message.includes("Snapshot:"));
    if (!snapshot) throw new Error("expected a snapshot commit");
    expect(await getFileContentAtCommit(pageId, snapshot.hash)).toContain("v2 content");
  });

  it("getFileContentAtCommit works for the repo's root commit (the first commit ever)", async () => {
    // The first test in this file made p1's commit the repo's root commit.
    const rootHash = execSync("git rev-list --max-parents=0 HEAD", { cwd: TEST_REPO, encoding: "utf-8" }).trim();
    const md = await getFileContentAtCommit("p1", rootHash);
    expect(md).toContain("Hello world");
  });

  it("re-flushing unchanged content does not create a duplicate commit", async () => {
    const pageId = "p-noop";
    await commitPageChange(pageId, await createPage(pageId, "noop", simpleDoc("Stable content")));
    const before = Number(execSync("git rev-list --count HEAD", { cwd: TEST_REPO, encoding: "utf-8" }).trim());

    // Same DB content → same exported markdown → git has nothing to commit.
    await commitPageChange(pageId, `b-${pageId}`);
    const after = Number(execSync("git rev-list --count HEAD", { cwd: TEST_REPO, encoding: "utf-8" }).trim());
    expect(after).toBe(before);
  });

  it("scopes each commit to its own file (a stale staged file never rides along)", async () => {
    // Commit page A, then dirty + stage its file manually, simulating a job
    // that failed between git.add and git.commit.
    await commitPageChange("p-a", await createPage("p-a", "alpha", simpleDoc("Alpha")));
    execSync("git add home-lab/alpha.md && echo dirty > home-lab/alpha.md && git add home-lab/alpha.md", {
      cwd: TEST_REPO,
      encoding: "utf-8",
    });

    // Commit page B with fresh content.
    await commitPageChange("p-b", await createPage("p-b", "bravo", simpleDoc("Bravo")));

    // The new HEAD commit must touch ONLY bravo's file, not the stale alpha.
    const headFiles = execSync("git show --name-only --format= HEAD", { cwd: TEST_REPO, encoding: "utf-8" });
    expect(headFiles).toContain("home-lab/bravo.md");
    expect(headFiles).not.toContain("home-lab/alpha.md");
  });
});
