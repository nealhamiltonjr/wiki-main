import { simpleGit, type SimpleGit } from "simple-git";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, spaces, users } from "../db/schema.js";
import { tiptapToMarkdown } from "./markdown.service.js";

const REPO_ROOT = process.env.GIT_REPO_ROOT ?? "./data/repo";
let git: SimpleGit | undefined;

export async function initGitRepo() {
  await mkdir(REPO_ROOT, { recursive: true });
  // Check if REPO_ROOT itself has a .git directory — simple-git's
  // checkIsRepo() traverses upward to parent repos, which would
  // falsely report the workspace repo as "already initialized".
  let isRepo = false;
  try { await access(path.join(REPO_ROOT, ".git")); isRepo = true; } catch { /* not a repo yet */ }
  git = simpleGit(REPO_ROOT);
  if (!isRepo) {
    await git.init();
    await git.addConfig("user.name", "wiki-app");
    await git.addConfig("user.email", "wiki-app@localhost");
  }
}

/**
 * Auto-save commit path. Writes the ACTUAL page content converted to Markdown
 * (brief §3.18 - the reviewed handoff's version wrote a placeholder heading
 * instead of real content; that gap is closed here) mirroring the space/tree
 * path on disk. Binary files are never written here - they live in a separate
 * append-only directory referenced by the `files` table (brief §3.13a).
 */
export async function commitPageChange(pageId: string, branchId: string) {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`commitPageChange: page ${pageId} not found`);

  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) throw new Error(`commitPageChange: branch ${branchId} not found`);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, branch.spaceId));
  const spaceSlug = slugify(space?.name ?? "space");

  const markdown = tiptapToMarkdown(page.content as any);
  const relPath = path.join(spaceSlug, `${page.slug}.md`);
  const fullPath = path.join(REPO_ROOT, relPath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, markdown, "utf-8");

  await git.add(relPath);
  await git.commit(`page:${page.id}: Update - ${page.slug}`);
}

/**
 * Manual snapshot path - distinct from autosave commits (adopted from the other
 * session, brief §3.18/3.2). Written to a flat snapshot path with a
 * user-provided message, so it's easy to find in `git log` as a deliberate
 * checkpoint rather than routine history noise.
 */
export async function commitManualSnapshot(pageId: string, message: string, userId: string) {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`commitManualSnapshot: page ${pageId} not found`);

  const markdown = tiptapToMarkdown(page.content as any);
  const relPath = path.join("_snapshots", `${page.id}.md`);
  const fullPath = path.join(REPO_ROOT, relPath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, markdown, "utf-8");

  // Found failing on every snapshot: `<${userId}>` is not a valid git ident
  // (git requires "Name <email>", not a bare id in brackets) - "empty ident
  // name" errors meant no manual snapshot was ever actually committing.
  const [author] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  const authorString = author ? `${author.name} <${author.email}>` : `Unknown <${userId}@local>`;

  await git.add(relPath);
  await git.commit(`Snapshot: page:${pageId}: ${message}`, undefined, { "--author": authorString });
}

/**
 * Retrieves the Markdown content of a page's file at a specific commit.
 * Used by the restore endpoint (§7.4) to read historical content back
 * into the editor. Tries the snapshot path first, then falls back to
 * using diff-tree to discover the space-path filename.
 */
export async function getFileContentAtCommit(pageId: string, commitHash: string): Promise<string> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`getFileContentAtCommit: page ${pageId} not found`);

  const snapshotPath = `_snapshots/${pageId}.md`;

  try {
    return await git.show([`${commitHash}:${snapshotPath}`]);
  } catch {
    // Not a snapshot commit — find the space-path file via diff-tree
    const filesOut = await git.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash]);
    const files = filesOut.trim().split("\n").filter(Boolean);
    const pageFile = files.find((f) => f.endsWith(`${page.slug}.md`));
    if (!pageFile) throw new Error(`File not found in commit ${commitHash} for page ${pageId}`);
    return await git.show([`${commitHash}:${pageFile}`]);
  }
}

/** Lists commit history for a page's file - powers the history/snapshot UI. */
export async function getPageHistory(pageId: string): Promise<{ hash: string; message: string; date: string }[]> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const log = await git.log({ "--all": null }).catch(() => ({ all: [] as any[] }));
  return log.all
    .filter((entry: any) => entry.message.includes(`page:${pageId}:`)) // now present in BOTH autosave and snapshot commit messages
    .map((entry: any) => ({ hash: entry.hash, message: entry.message, date: entry.date }));
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
