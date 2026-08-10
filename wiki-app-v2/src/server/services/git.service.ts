import { simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import { mkdir, writeFile, access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, spaces, users } from "../db/schema.js";
import { tiptapToMarkdown, frontmatterToMarkdown } from "./markdown.service.js";

const REPO_ROOT = process.env.GIT_REPO_ROOT ?? "./data/repo";
let git: SimpleGit | undefined;

export async function initGitRepo() {
  await mkdir(REPO_ROOT, { recursive: true });
  // Check if REPO_ROOT itself has a .git directory — simple-git's
  // checkIsRepo() traverses upward to parent repos, which would falsely report
  // the workspace repo as "already initialized".
  let isRepo = false;
  try { await access(path.join(REPO_ROOT, ".git")); isRepo = true; } catch { /* not a repo yet */ }
  git = simpleGit(REPO_ROOT);
  if (!isRepo) {
    await git.init();
  }
  // Always ensure a local ident, even for a repo that already exists: a repo
  // initialized externally (or by a boot that crashed between init and config)
  // would otherwise fail every commit with "Please tell me who you are".
  await git.addConfig("user.name", "wiki-app");
  await git.addConfig("user.email", "wiki-app@localhost");
}

/**
 * Auto-save commit path. Writes the ACTUAL page content converted to Markdown
 * (brief §8 step 10 — real content, not a placeholder) mirroring the
 * space/tree path on disk, with YAML frontmatter so title changes are visible
 * in git history. Binary files are never written here — they live in a
 * separate append-only directory referenced by the `files` table.
 */
export async function commitPageChange(pageId: string, branchId: string) {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  const { db } = getDb();
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`commitPageChange: page ${pageId} not found`);

  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) throw new Error(`commitPageChange: branch ${branchId} not found`);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, branch.spaceId));
  const spaceSlug = slugify(space?.name ?? "space");

  // YAML frontmatter makes title changes visible in git history.
  const frontmatter = frontmatterToMarkdown({ title: page.title, slug: page.slug, date: page.updatedAt?.toISOString() ?? null });
  const markdown = frontmatter + "\n" + tiptapToMarkdown(page.content as never);
  const relPath = path.join(spaceSlug, `${page.slug}.md`);
  const fullPath = path.join(REPO_ROOT, relPath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, markdown, "utf-8");

  await git.add(relPath);
  // Commit scoped to THIS file: an unrelated file left staged by a previously
  // failed job must never ride along inside another page's commit.
  await git.commit(`page:${page.id}: Update - ${page.slug}`, [relPath]);
}

/**
 * Manual snapshot path — distinct from autosave commits. Written to a flat
 * snapshot path with a user-provided message, so it's easy to find in
 * `git log` as a deliberate checkpoint rather than routine history noise.
 */
export async function commitManualSnapshot(pageId: string, message: string, userId: string) {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  const { db } = getDb();
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`commitManualSnapshot: page ${pageId} not found`);

  const frontmatter = frontmatterToMarkdown({ title: page.title, slug: page.slug, date: new Date().toISOString() });
  const markdown = frontmatter + "\n" + tiptapToMarkdown(page.content as never);
  const relPath = path.join("_snapshots", `${page.id}.md`);
  const fullPath = path.join(REPO_ROOT, relPath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, markdown, "utf-8");

  // git requires "Name <email>", not a bare id — build a valid ident.
  const [author] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  const authorString = author ? `${author.name} <${author.email}>` : `Unknown <${userId}@local>`;

  await git.add(relPath);
  await git.commit(`Snapshot: page:${pageId}: ${message}`, [relPath], { "--author": authorString });
}

/**
 * Retrieves the Markdown content of a page's file at a specific commit.
 * Used by the restore endpoint to read historical content back into the
 * editor. Reads the file the commit ACTUALLY modified (via diff-tree): once a
 * snapshot exists, `_snapshots/<pageId>.md` is present in every later commit's
 * tree too, so naively reading it for an autosave commit would return the
 * stale snapshot content instead of that commit's real content.
 */
export async function getFileContentAtCommit(pageId: string, commitHash: string): Promise<string> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  const { db } = getDb();
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`getFileContentAtCommit: page ${pageId} not found`);

  // `--root` makes diff-tree diff a root commit (the repo's first commit) against
  // the empty tree; without it, the very first commit reports no files at all.
  const filesOut = await git.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commitHash]);
  const files = filesOut.trim().split("\n").filter(Boolean);
  const snapshotPath = `_snapshots/${pageId}.md`;
  const pageFile = files.find((f) => f === snapshotPath) ?? files.find((f) => f.endsWith(`${page.slug}.md`));
  if (!pageFile) throw new Error(`File not found in commit ${commitHash} for page ${pageId}`);
  return await git.show([`${commitHash}:${pageFile}`]);
}

/** Lists commit history for a page's file - powers the history/snapshot UI. */
export async function getPageHistory(pageId: string): Promise<{ hash: string; message: string; date: string }[]> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const log = await git.log({ "--all": null }).catch(() => ({ all: [] as unknown[] }));
  const entries = log.all as { message: string; hash: string; date: string }[];
  return entries
    .filter((entry) => entry.message.includes(`page:${pageId}:`)) // present in BOTH autosave and snapshot commit messages
    .map((entry) => ({ hash: entry.hash, message: entry.message, date: entry.date }));
}

export interface RepoStatus {
  branch: string;
  headHash: string;
  headMessage: string;
  dirty: number;
  lastCommit: string | null;
  sizeBytes: number;
}

/** Local repo status — remote config (push/pull) lands with the settings slice. */
export async function getRepoStatus(): Promise<RepoStatus> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  let status: StatusResult;
  try {
    status = await git.status();
  } catch {
    return { branch: "none", headHash: "", headMessage: "", dirty: 0, lastCommit: null, sizeBytes: 0 };
  }

  const total = await dirSize(REPO_ROOT);
  const last = (await git.log({ maxCount: 1 }).catch(() => ({ latest: null }))).latest as unknown as
    | { hash: string; message: string; date: string }
    | null
    | undefined;

  return {
    branch: status.current ?? "none",
    headHash: last?.hash ?? "",
    headMessage: last?.message ?? "",
    dirty: status.files.length,
    lastCommit: last?.date ?? null,
    sizeBytes: total,
  };
}

export async function getRepoLog(limit = 25): Promise<{ hash: string; message: string; date: string; author: string }[]> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const logResult = await git.log({ maxCount: limit });
  return logResult.all.map((e) => ({ hash: e.hash, message: e.message, date: e.date, author: e.author_name }));
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as never[]);
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
