import { simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import { mkdir, writeFile, access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, spaces, users } from "../db/schema.js";
import { tiptapToMarkdown, markdownToTiptap, frontmatterToMarkdown, stripFrontmatter } from "./markdown.service.js";
import { getSettingValue } from "./settings.service.js";
import { log } from "./log.service.js";
import { ensureBlockIds, type JSONBlock } from "../../shared/blockIds.js";

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

  // UI overhaul A4: YAML frontmatter makes title changes visible in git history.
  const frontmatter = frontmatterToMarkdown({ title: page.title, slug: page.slug, date: page.updatedAt?.toISOString() ?? null });
  const markdown = frontmatter + "\n" + tiptapToMarkdown(page.content as any);
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

  // UI overhaul A4: YAML frontmatter makes the title visible in snapshot files.
  const frontmatter = frontmatterToMarkdown({ title: page.title, slug: page.slug, date: new Date().toISOString() });
  const markdown = frontmatter + "\n" + tiptapToMarkdown(page.content as any);
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

// ---------------------------------------------------------------------------
// Remote push/pull/status (§7.10c/d). All long-running operations run as queue
// jobs; settings are read at job-run time (never cached) so changing the
// remote or its auth never requires a restart.
// ---------------------------------------------------------------------------

export interface RepoStatus {
  branch: string;
  headHash: string;
  headMessage: string;
  dirty: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  sizeBytes: number;
  remoteUrl: string | null;
  remoteBranch: string;
}

/** Reads remote config from settings; never includes the token in the URL. */
async function getRemoteConfig() {
  const url = await getSettingValue("git_remote_url") as string | null;
  const token = await getSettingValue("git_remote_token") as string | null;
  const remoteBranch = (await getSettingValue("git_remote_branch") as string | null) ?? "main";
  return { url, token, remoteBranch };
}

/** Builds an auth-embedded URL for git operations only (never stored/logged). */
function authUrl(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(token);
    return u.toString();
  } catch {
    // Non-parseable URL (e.g. SSH scp-like syntax) — append via credential
    // prompting is impossible headless, so SSH URLs must carry their own auth.
    return url;
  }
}

export async function getRepoStatus(): Promise<RepoStatus> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const { url, token, remoteBranch } = await getRemoteConfig();

  let status: StatusResult;
  try {
    status = await git.status();
  } catch {
    return {
      branch: "none", headHash: "", headMessage: "", dirty: 0, ahead: 0, behind: 0,
      lastCommit: null, sizeBytes: 0, remoteUrl: url, remoteBranch,
    };
  }

  let ahead = 0;
  let behind = 0;
  if (url) {
    try {
      await git.fetch([authUrl(url, token)]);
      const tracking = status.tracking ?? `origin/${remoteBranch}`;
      const counts = await git.raw(["rev-list", "--left-right", "--count", `${tracking}...HEAD`]).catch(() => "");
      const [l, r] = counts.trim().split(/\s+/).map(Number);
      ahead = r ?? 0;
      behind = l ?? 0;
    } catch {
      // Remote unreachable — report the configured remote without counts.
    }
  }

  const total = await dirSize(REPO_ROOT);
  const last = (await git.log({ maxCount: 1 }).catch(() => ({ latest: null }))).latest as any;

  return {
    branch: status.current ?? "none",
    headHash: last?.hash ?? "",
    headMessage: last?.message ?? "",
    dirty: status.files.length,
    ahead,
    behind,
    lastCommit: last?.date ?? null,
    sizeBytes: total,
    remoteUrl: url,
    remoteBranch,
  };
}

export async function getRepoLog(limit = 25): Promise<{ hash: string; message: string; date: string; author: string }[]> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const logResult = await git.log({ maxCount: limit });
  return logResult.all.map((e) => ({ hash: e.hash, message: e.message, date: e.date, author: e.author_name }));
}

/** Verifies the configured remote is reachable and the token authenticates. */
export async function testRemote(): Promise<{ ok: true; reachable: boolean; message: string }> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const { url, token, remoteBranch } = await getRemoteConfig();
  if (!url) return { ok: true, reachable: false, message: "No remote URL configured" };
  try {
    const out = await git.raw(["ls-remote", "--heads", authUrl(url, token)]);
    const branch = out.split("\n").map((l) => l.split(/\s+/).pop()).find((b) => b === `refs/heads/${remoteBranch}`);
    return {
      ok: true,
      reachable: true,
      message: branch ? `Reachable — remote branch ${remoteBranch} exists` : "Reachable — but the configured branch does not exist yet",
    };
  } catch (err) {
    return { ok: true, reachable: false, message: `Unreachable: ${(err as Error).message}` };
  }
}

/**
 * Pushes the current content branch to the configured remote. A "never
 * auto-push" default is enforced by the caller (§7.10c safeguard) — this
 * function only ever runs from an explicit admin action.
 */
export async function pushToRemote(opts: { force?: boolean } = {}): Promise<{ pushed: boolean; message: string }> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const { url, token, remoteBranch } = await getRemoteConfig();
  if (!url) throw new Error("No git remote URL configured");

  const localBranch = (await git.status()).current ?? "main";
  // Source is the LOCAL branch name, dest is the configured remote branch —
  // they differ whenever the local default (master) isn't the remote's (main).
  const targetRef = `refs/heads/${localBranch}:refs/heads/${remoteBranch}`;
  const args = ["push", authUrl(url, token), targetRef];
  if (opts.force) args.push("--force");
  await git.raw(args);
  log("info", "git", `Pushed ${localBranch} -> ${remoteBranch} to remote`);
  return { pushed: true, message: `Pushed ${localBranch} -> ${remoteBranch}` };
}

/**
 * Pulls the remote content branch into a SHADOW checkout (never the live
 * working tree), then imports the Markdown back into the DB as a restore/
 * merge operation. Last-write-wins per page, with a backup commit before any
 * import so nothing is lost.
 */
export async function pullFromRemote(): Promise<{ imported: number; skipped: number; message: string }> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const { url, token, remoteBranch } = await getRemoteConfig();
  if (!url) throw new Error("No git remote URL configured");

  const shadowRoot = path.join(REPO_ROOT, "..", "repo-shadow");
  await mkdir(shadowRoot, { recursive: true });
  const shadowGit = simpleGit(shadowRoot);
  let shadowIsRepo = false;
  try { await access(path.join(shadowRoot, ".git")); shadowIsRepo = true; } catch { /* not yet */ }
  if (!shadowIsRepo) {
    await shadowGit.init();
    await shadowGit.raw(["fetch", authUrl(url, token), remoteBranch]);
    await shadowGit.checkout(["-b", remoteBranch, `FETCH_HEAD`]);
  } else {
    await shadowGit.fetch([authUrl(url, token), remoteBranch]);
    await shadowGit.reset(["--hard", `FETCH_HEAD`]);
  }

  // Walk the shadow tree and import every .md file.
  const mdFiles = await collectMdFiles(shadowRoot);
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const rel of mdFiles) {
    const parts = rel.split(path.sep);
    if (parts[0] === "_snapshots") { skipped++; continue; } // manual snapshot dir
    if (parts.length < 2 || !rel.endsWith(".md")) { skipped++; continue; }
    const spaceSlug = parts[0]!;
    const pageSlug = parts.slice(1).join("/").replace(/\.md$/, "");

    try {
      const raw = await readFile(path.join(shadowRoot, rel), "utf-8");
      const importedMarkdown = await importMarkdownPage(spaceSlug, pageSlug, raw);
      if (importedMarkdown) imported++;
      else skipped++;
    } catch (err) {
      errors.push(`${rel}: ${(err as Error).message}`);
    }
  }

  // If anything changed, snapshot the current DB content into git first so the
  // import is always reversible.
  if (imported > 0) {
    await exportAllPagesToRepo();
    await git.add(".");
    await git.commit("pull-import: pre-import snapshot before DB merge");
  }

  log("info", "git", `Pull import: ${imported} imported, ${skipped} skipped from ${url}`);
  return {
    imported,
    skipped,
    message: errors.length
      ? `Imported ${imported}, skipped ${skipped}, ${errors.length} error(s): ${errors.slice(0, 3).join("; ")}`
      : `Imported ${imported} page(s), skipped ${skipped}`,
  };
}

/** Writes every page in the DB out to its space/slug.md path (used pre-import). */
async function exportAllPagesToRepo(): Promise<void> {
  if (!git) throw new Error("git repo not initialized - call initGitRepo() first");
  const rows = await db
    .select({ id: pages.id, slug: pages.slug, content: pages.content, spaceId: branches.spaceId })
    .from(pages)
    .innerJoin(branches, eq(branches.pageId, pages.id))
    .where(isNull(pages.deletedAt));
  const seen = new Set<string>();
  for (const row of rows) {
    const [space] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, row.spaceId));
    const spaceSlug = slugify(space?.name ?? "space");
    const key = `${spaceSlug}/${row.slug}`;
    if (seen.has(key)) continue; // multiple placements of one page — write once
    seen.add(key);
    const md = tiptapToMarkdown(row.content as any);
    const relPath = path.join(spaceSlug, `${row.slug}.md`);
    const fullPath = path.join(REPO_ROOT, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, md, "utf-8");
    await git.add(relPath);
  }
}

/**
 * Upserts a page from an imported Markdown file. Returns true when a page was
 * created or updated. Reuses the same markdown→Tiptap path as restore (§7.4)
 * so block IDs are backfilled server-side.
 */
async function importMarkdownPage(spaceSlug: string, pageSlug: string, markdown: string): Promise<boolean> {
  // Find the space by slugified name (mirrors how commitPageChange writes).
  const spaceRows = await db.select({ id: spaces.id, name: spaces.name }).from(spaces);
  const space = spaceRows.find((s) => slugify(s.name) === spaceSlug);
  if (!space) return false; // no matching space — skip (creating spaces on pull is out of scope)

  const tiptap = ensureBlockIds(markdownToTiptap(stripFrontmatter(markdown)) as unknown as JSONBlock);

  const [existing] = await db
    .select({ id: pages.id, updatedAt: pages.updatedAt })
    .from(pages)
    .innerJoin(branches, eq(branches.pageId, pages.id))
    .where(and(eq(branches.spaceId, space.id), eq(pages.slug, pageSlug), isNull(pages.deletedAt)))
    .limit(1);

  if (!existing) {
    // New page at the space root.
    const pageId = crypto.randomUUID();
    const branchId = crypto.randomUUID();
    await db.insert(pages).values({ id: pageId, slug: pageSlug, ownerId: "system-import", content: tiptap as any });
    await db.insert(branches).values({
      id: branchId, pageId, parentBranchId: null, spaceId: space.id,
      visibility: "inherit", isSystem: false, createdBy: "system-import",
    });
    return true;
  }

  await db.update(pages).set({ content: tiptap as any, updatedAt: new Date() }).where(eq(pages.id, existing.id));
  return true;
}

async function collectMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMdFiles(full)).map((f) => path.join(entry.name, f)));
    } else if (entry.name.endsWith(".md")) {
      out.push(entry.name);
    }
  }
  return out;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
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
