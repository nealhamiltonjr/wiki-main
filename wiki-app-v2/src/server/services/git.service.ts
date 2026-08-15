import { simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import { mkdir, writeFile, access, readdir, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getDbPath } from "../db/index.js";
import { pages, branches, spaces, users } from "../db/schema.js";
import { tiptapToMarkdown, frontmatterToMarkdown } from "./markdown.service.js";
import { codeLanguageExtension } from "../../shared/codeLanguages.js";

const REPO_ROOT = process.env.GIT_REPO_ROOT ?? "./data/repo";
let git: SimpleGit | undefined;

/** Resolve the repo root the same way the rest of the app does (relative to
 *  the project root, not the CWD). Exposed so file.service can write blobs
 *  into the same git-tracked content store. */
export function getRepoRoot(): string {
  return REPO_ROOT;
}

// Serialize all git mutations. simple-git does NOT serialize concurrent
// operations internally: a file-upload commit racing a page-save commit can
// collide on `.git/index.lock` or fold one operation's staged files into the
// other's commit. Every mutating entry point below goes through this lock.
let gitLock: Promise<unknown> = Promise.resolve();
export function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitLock.then(fn, fn);
  gitLock = run.catch(() => {});
  return run;
}

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

/** Commit a single content-addressable file blob to the repo. Called after a
 *  successful write; content-addressing means identical content is only ever
 *  written/committed once (the second upload is a no-op commit). */
export async function commitFileBlob(relPath: string): Promise<void> {
  if (!git) return; // not initialized (e.g. unit test without initGitRepo) — best-effort
  return withGitLock(async () => {
    await git!.add(relPath);
    const staged = await git!.raw(["diff", "--cached", "--name-only", "--", relPath]);
    if (!staged.trim()) return; // already committed (dedup)
    await git!.commit(`file: ${relPath}`, [relPath]);
    await recordSuccessfulGitFlush();
  });
}

/** Remove a file blob from the repo (called before a file row is deleted). */
export async function removeFileBlob(relPath: string): Promise<void> {
  if (!git) return; // not initialized — best-effort
  return withGitLock(async () => {
    try { await git!.rm([relPath]); } catch { /* may not be committed yet */ }
    const staged = await git!.raw(["diff", "--cached", "--name-only", "--", relPath]);
    if (!staged.trim()) return;
    await git!.commit(`file-rm: ${relPath}`, [relPath]);
    await recordSuccessfulGitFlush();
  });
}

/**
 * Auto-save commit path. Writes the ACTUAL page content converted to Markdown
 * (brief §8 step 10 — real content, not a placeholder) mirroring the
 * space/tree path on disk, with YAML frontmatter so title changes are visible
 * in git history. Binary files are never written here — they live in a
 * separate append-only directory referenced by the `files` table.
 */
export async function commitPageChange(pageId: string, branchId: string, oldSlug?: string) {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const g = git;
  return withGitLock(async () => {
    const { db } = getDb();
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!page) throw new Error(`commitPageChange: page ${pageId} not found`);

  // §13.7: encrypted pages are never exported to g. The plaintext never
  // reaches the server, so any commit would have to write the ciphertext
  // envelope (unreadable diffs) or fail on the envelope-as-doc conversion.
  // Defensive: the encrypted save path never enqueues a git_commit job.
  if (page.isEncrypted) throw new Error(`commitPageChange: page ${pageId} is encrypted`);

  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) throw new Error(`commitPageChange: branch ${branchId} not found`);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, branch.spaceId));
  // A space name like "!!!" slugifies to "" — fall back so the page file never
  // lands bare at the repo root or starts a path with a leading dash.
  const spaceSlug = slugify(space?.name ?? "space") || "space";

  // §13.6: code pages are written as raw source files (readable git diffs, no
  // YAML frontmatter cluttering a config/script). Wiki pages keep markdown +
  // frontmatter so title changes stay visible in history.
  const isCode = page.pageType === "code";
  const ext = isCode ? codeLanguageExtension(page.language) : "md";
  const body = isCode
    ? (typeof page.content === "string" ? page.content : "")
    : frontmatterToMarkdown({ title: page.title, slug: page.slug, date: page.updatedAt?.toISOString() ?? null }) + "\n" + tiptapToMarkdown(page.content as never);

  const relPath = path.join(spaceSlug, `${page.slug}.${ext}`);
  const fullPath = path.join(REPO_ROOT, relPath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body, "utf-8");

  await g.add(relPath);
  // A rename must also drop the previous <slug>.<ext>, or the tree keeps a
  // stale copy of the page under its old name forever (space slugs never
  // change, so the old path lives in the same directory).
  const commitPaths = [relPath];
  if (oldSlug && oldSlug !== page.slug) {
    const oldRelPath = path.join(spaceSlug, `${oldSlug}.${ext}`);
    try {
      await g.rm([oldRelPath]);
      commitPaths.push(oldRelPath);
    } catch {
      // The old file may never have been committed (rename before first flush).
    }
  }
  // Nothing staged for this page's paths → skip the commit instead of letting
  // `git commit` exit 1 ("nothing to commit") and fail the job after retries.
  // Reachable with no-op title saves (title path doesn't bump updatedAt),
  // saves within the same millisecond, and restores that reproduce the current
  // content exactly.
  const staged = await g.raw(["diff", "--cached", "--name-only", "--", ...commitPaths]);
  if (!staged.trim()) return;

  // Commit scoped to THESE paths: an unrelated file left staged by a previously
  // failed job must never ride along inside another page's commit.
  await g.commit(`page:${page.id}: Update - ${page.slug}`, commitPaths);
  await recordSuccessfulGitFlush();
  });
}

/**
 * Manual snapshot path — distinct from autosave commits. Written to a flat
 * snapshot path with a user-provided message, so it's easy to find in
 * `git log` as a deliberate checkpoint rather than routine history noise.
 */
export async function commitManualSnapshot(pageId: string, message: string, userId: string) {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const g = git;
  return withGitLock(async () => {
  const { db } = getDb();
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error(`commitManualSnapshot: page ${pageId} not found`);

  // §13.7: snapshotting would write either the ciphertext envelope or a broken
  // markdown conversion; encrypted pages intentionally have no git history.
  if (page.isEncrypted) throw new Error(`commitManualSnapshot: page ${pageId} is encrypted`);

  const isCode = page.pageType === "code";
  const ext = isCode ? codeLanguageExtension(page.language) : "md";
  const body = isCode
    ? (typeof page.content === "string" ? page.content : "")
    : frontmatterToMarkdown({ title: page.title, slug: page.slug, date: new Date().toISOString() }) + "\n" + tiptapToMarkdown(page.content as never);
  const relPath = path.join("_snapshots", `${page.id}.${ext}`);
  const fullPath = path.join(REPO_ROOT, relPath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body, "utf-8");

  // git requires "Name <email>", not a bare id — build a valid ident.
  const [author] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  const authorString = author ? `${author.name} <${author.email}>` : `Unknown <${userId}@local>`;

  await g.add(relPath);
  // Two snapshots of identical content within the same millisecond produce an
  // identical file — skip the commit rather than fail the job on git's
  // "nothing to commit" (exit 1).
  const staged = await g.raw(["diff", "--cached", "--name-only", "--", relPath]);
  if (!staged.trim()) return;
  await g.commit(`Snapshot: page:${pageId}: ${message}`, [relPath], { "--author": authorString });
  await recordSuccessfulGitFlush();
  });
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
  // §13.6: snapshot files use the page's language extension (.md for wiki,
  // .sh/.py/... for code), so match by the pageId prefix rather than a fixed
  // extension.
  const snapshotFile = files.find((f) => f.startsWith(`_snapshots/${pageId}.`));
  if (snapshotFile) return await git.show([`${commitHash}:${snapshotFile}`]);

  // Autosave commits write <spaceSlug>/<pageSlug>.<ext> where pageSlug is the
  // slug AT COMMIT TIME — the page may have been renamed since, so the
  // current page.slug may not match. Autosave messages are
  // "page:<id>: Update - <slug>", so derive the commit-time slug from them.
  const commitSlug = await git.raw(["show", "-s", "--format=%s", commitHash]).then(
    (msg) => /^page:[^:]+: Update - (.+)$/.exec(msg.trim())?.[1],
    () => undefined,
  );
  const basename = `${commitSlug ?? page.slug}.`;
  const pageFile = files.find((f) => !f.startsWith("_snapshots/") && path.basename(f).startsWith(basename));
  if (!pageFile) throw new Error(`File not found in commit ${commitHash} for page ${pageId}`);
  return await git.show([`${commitHash}:${pageFile}`]);
}

/** Lists commit history for a page's file - powers the history/snapshot UI. */
export async function getPageHistory(pageId: string): Promise<{ hash: string; message: string; date: string }[]> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  // Grep in git so we never parse thousands of unrelated commits. `page:<id>:`
  // is present in BOTH autosave and snapshot commit messages. pageId is a UUID
  // (hex + dashes), so the pattern is literal regex — no escaping needed.
  const log = await git.log({ "--all": null, "--grep": `page:${pageId}:` }).catch(() => ({ all: [] as unknown[] }));
  const entries = log.all as { message: string; hash: string; date: string }[];
  return entries.map((entry) => ({ hash: entry.hash, message: entry.message, date: entry.date }));
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

// ---------------------------------------------------------------------------
// §DB snapshot (Slice B) — the whole SQLite DB copied into `_db/wiki.db` and
// committed. Powers the periodic + manual snapshot surface and restore.
// ---------------------------------------------------------------------------

const DB_SNAPSHOT_DIR = "_db";
const DB_SNAPSHOT_REL = path.join(DB_SNAPSHOT_DIR, "wiki.db");

export async function commitDatabaseSnapshot(opts: {
  trigger: "manual" | "scheduled";
  message?: string;
  userId?: string;
}): Promise<{ hash: string; message: string }> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const g = git;
  return withGitLock(async () => {
    const dbPath = getDbPath();
    const fullPath = path.join(REPO_ROOT, DB_SNAPSHOT_REL);
    await mkdir(path.dirname(fullPath), { recursive: true });

    // Copy the DB file via better-sqlite3's online backup instead of a raw
    // file copy — WAL mode means the live file may not contain the latest
    // committed writes, and a naive copyFile can capture a torn page.
    try {
      const { sqlite } = getDb();
      // better-sqlite3 `backup(destination)` performs a consistent online
      // backup of the CURRENT connection into a new file.
      await new Promise<void>((resolve, reject) => {
        try {
          sqlite.backup(fullPath);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    } catch (err) {
      // Fall back to a plain copy (e.g. if backup API is unavailable in this
      // better-sqlite3 version). Still consistent enough for a snapshot.
      console.warn("[git] sqlite.backup failed, falling back to copyFile:", err);
      await copyFile(dbPath, fullPath);
    }

    await g.add(DB_SNAPSHOT_REL);
    const staged = await g.raw(["diff", "--cached", "--name-only", "--", DB_SNAPSHOT_REL]);
    if (!staged.trim()) return { hash: "", message: "unchanged" };

    const message = `db-snapshot: ${opts.trigger}${opts.message ? ` — ${opts.message}` : ""}`;
    await g.commit(message, [DB_SNAPSHOT_REL]);
    await recordSuccessfulGitFlush();
    const head = await g.log({ maxCount: 1 });
    return { hash: head.latest?.hash ?? "", message };
  });
}

export interface SnapshotEntry {
  hash: string;
  message: string;
  date: string;
}

export async function listSnapshots(limit = 20): Promise<SnapshotEntry[]> {
  if (!git) return [];
  const log = await git.log({ maxCount: limit * 3, "--grep": "db-snapshot:" }).catch(() => ({ all: [] as unknown[] }));
  return (log.all as { hash: string; message: string; date: string }[])
    .slice(0, limit)
    .map((e) => ({ hash: e.hash, message: e.message, date: e.date }));
}

export async function restoreSnapshot(commitHash: string): Promise<void> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");

  // Backup current state FIRST (the brief requires "current state is committed
  // as a snapshot before restore").
  await commitDatabaseSnapshot({ trigger: "manual", message: "pre-restore backup" });

  return withGitLock(async () => {
    const dbPath = getDbPath();
    const tmp = `${dbPath}.restore-${Date.now()}`;
    try {
      // Extract the snapshot DB from git into a temp file, then restore it into
      // the live connection via better-sqlite3 online backup (source → live).
      const snapshotContent = await git!.show([`${commitHash}:${DB_SNAPSHOT_REL}`]);
      await writeFile(tmp, snapshotContent as never, "binary");

      // `Database.backup(destination)` copies FROM the open db. To restore INTO
      // the live db, open the snapshot as a separate read-only connection and
      // backup INTO the live path.
      const { default: Database } = await import("better-sqlite3");
      const source = new Database(tmp, { readonly: true });
      try {
        source.backup(dbPath);
      } finally {
        source.close();
      }
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(tmp, { force: true }).catch(() => {}));
    }
  });
}

// ---------------------------------------------------------------------------
// §Git remote (Slice D) — push/pull/gc + remote config.
// ---------------------------------------------------------------------------

export interface GitRemoteConfig {
  url: string;
  branch: string;
}

export async function getGitRemoteConfig(): Promise<GitRemoteConfig> {
  const { db } = getDb();
  const { systemSettings } = await import("../db/schema.js");
  const rows = await db.select().from(systemSettings);
  const valueOf = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    url: typeof valueOf("git.remoteUrl") === "string" ? (valueOf("git.remoteUrl") as string) : "",
    branch: typeof valueOf("git.remoteBranch") === "string" ? (valueOf("git.remoteBranch") as string) : "main",
  };
}

async function ensureRemote(remote: GitRemoteConfig): Promise<void> {
  if (!git) throw new Error("git repo not initialized");
  if (!remote.url) throw new Error("No remote configured");
  const remotes = await git.getRemotes(true);
  if (!remotes.some((r) => r.name === "origin")) {
    await git.addRemote("origin", remote.url);
  } else {
    // Update URL if it changed (simple-git has no set-url; remove + re-add).
    const current = remotes.find((r) => r.name === "origin");
    if (current?.refs?.fetch !== remote.url && current?.refs?.push !== remote.url) {
      await git.removeRemote("origin");
      await git.addRemote("origin", remote.url);
    }
  }
  await git.fetch("origin", remote.branch).catch(() => {});
}

export async function pushToRemote(): Promise<{ ahead: number; behind: number }> {
  if (!git) throw new Error("git repo not initialized");
  const g = git;
  const remote = await getGitRemoteConfig();
  if (!remote.url) throw new Error("No remote configured");
  return withGitLock(async () => {
    await ensureRemote(remote);
    await g.push("origin", remote.branch);
    return await aheadBehind(remote.branch);
  });
}

export async function pullFromRemote(): Promise<{ ahead: number; behind: number }> {
  if (!git) throw new Error("git repo not initialized");
  const g = git;
  const remote = await getGitRemoteConfig();
  if (!remote.url) throw new Error("No remote configured");
  return withGitLock(async () => {
    await ensureRemote(remote);
    await g.pull("origin", remote.branch, { "--rebase": "true" });
    return await aheadBehind(remote.branch);
  });
}

async function aheadBehind(branch: string): Promise<{ ahead: number; behind: number }> {
  if (!git) return { ahead: 0, behind: 0 };
  await git.fetch("origin", branch).catch(() => {});
  const status = await git.status().catch(() => null);
  return { ahead: status?.ahead ?? 0, behind: status?.behind ?? 0 };
}

export async function runGitGc(): Promise<{ ok: true }> {
  if (!git) throw new Error("git repo not initialized");
  const g = git;
  return withGitLock(async () => {
    await g.raw(["gc", "--auto", "--prune=now"]);
    await recordSuccessfulGitFlush();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// §Fresh install (Slice E) — clone a remote repo and/or restore the DB from a
// repo snapshot.
// ---------------------------------------------------------------------------

export async function cloneFromRemote(url: string, branch: string): Promise<{ ok: true }> {
  if (!git) throw new Error("git repo not initialized");
  return withGitLock(async () => {
    // Only clone into an empty repo — refuse to destroy existing state.
    const log = await git!.log({ maxCount: 1 }).catch(() => ({ latest: null }));
    if (log.latest) throw new Error("Repository already has commits; clone aborted");
    const { rm } = await import("node:fs/promises");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(REPO_ROOT).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === ".git") continue;
      await rm(path.join(REPO_ROOT, entry), { recursive: true, force: true });
    }
    await git!.clone(url, ".", ["--branch", branch, "--single-branch"]);
    return { ok: true };
  });
}

export async function restoreDbFromRepo(): Promise<{ ok: true }> {
  if (!git) throw new Error("git repo not initialized");
  const snapshotPath = path.join(REPO_ROOT, DB_SNAPSHOT_REL);
  let exists = false;
  try { await access(snapshotPath); exists = true; } catch { /* missing */ }
  if (!exists) throw new Error("No database snapshot found in repository");

  const dbPath = getDbPath();
  const { default: Database } = await import("better-sqlite3");
  const source = new Database(snapshotPath, { readonly: true });
  try {
    source.backup(dbPath);
  } finally {
    source.close();
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §11.4 — last-successful-git-flush bookkeeping
// ---------------------------------------------------------------------------

/**
 * Stamp the system-settings key the admin System Health page reads.
 * Called from both `commitPageChange` (auto-save) and
 * `commitManualSnapshot` so any successful commit updates the
 * "last git-flush time" badge. Idempotent and best-effort — the
 * commit itself is the source of truth, this is just a summary.
 */
async function recordSuccessfulGitFlush(): Promise<void> {
  try {
    const { db } = getDb();
    const { systemSettings } = await import("../db/schema.js");
    await db
      .insert(systemSettings)
      .values({
        key: "last_git_flush_at",
        value: new Date().toISOString(),
        isSecret: false,
        updatedBy: null,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[git] failed to record last_git_flush_at:", err);
  }
}
