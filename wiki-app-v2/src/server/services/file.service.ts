import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { files, branches } from "../db/schema.js";
import { getRepoRoot, commitFileBlob } from "./git.service.js";

// Legacy FILES_ROOT retained for reading rows written before the git-backed
// content store (Slice A). New uploads are content-addressed blobs under the
// git repo (`data/repo/_files/<sha256>`); old rows still point at
// `data/files/...` and are served from there until migrated.
const projectRoot = resolveProjectRoot();
function resolveProjectRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return path.resolve(here, "../../..");
}
export const FILES_ROOT = process.env.FILES_ROOT
  ? path.resolve(projectRoot, process.env.FILES_ROOT)
  : path.resolve(projectRoot, "data/files");

const GIT_FILES_DIR = "_files";

// ---------------------------------------------------------------------------
// File-serving hardening (brief §3.2): an inline-safe MIME allowlist. Raster
// images only — SVG is deliberately excluded because it can carry active
// scripts. Anything NOT on this list is served with
// `Content-Disposition: attachment` so the browser downloads it instead of
// rendering it in the page's origin. `nosniff` is applied globally to every
// response (security.ts) and set explicitly on file responses too.
// ---------------------------------------------------------------------------
export const INLINE_SAFE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
]);

export function isInlineSafeMime(mimeType: string): boolean {
  return INLINE_SAFE_MIME_TYPES.has(mimeType.toLowerCase());
}

/** Content hash used as the storage key — identical bytes dedupe to one blob. */
export function hashContent(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Resolve a `files.storagePath` to an on-disk path, handling both the new
 *  git-backed `_files/<hash>` form and the legacy `data/files/...` form. */
function resolveStoragePath(storagePath: string): string {
  if (storagePath.startsWith(GIT_FILES_DIR + "/")) {
    return path.join(getRepoRoot(), storagePath);
  }
  return path.join(FILES_ROOT, storagePath);
}

export async function storeFile(opts: {
  pageId: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy: string;
}) {
  const id = crypto.randomUUID();
  // Content-addressable: the path is the SHA-256 of the payload. Uploading the
  // same bytes twice produces the same blob path → automatic dedup and a no-op
  // second commit.
  const hash = hashContent(opts.data);
  const storagePath = path.join(GIT_FILES_DIR, hash);
  const fullPath = resolveStoragePath(storagePath);

  let exists = false;
  try { await access(fullPath); exists = true; } catch { /* not written yet */ }
  if (!exists) {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, opts.data);
  }

  const { db } = getDb();
  await db.insert(files).values({
    id,
    pageId: opts.pageId,
    filename: opts.filename,
    mimeType: opts.mimeType,
    sizeBytes: opts.data.byteLength,
    storagePath,
    uploadedBy: opts.uploadedBy,
  });

  // Track the blob in git (dedup: same hash never commits twice).
  try {
    await commitFileBlob(storagePath);
  } catch (err) {
    // A git failure must not fail the upload itself — the blob is already on
    // disk and in the DB; the next page save will pick it up if we retry the
    // commit. Log and move on so the user gets their file.
    console.error("[file] failed to commit blob to git:", err);
  }

  return id;
}

/**
 * §3.13a — a file is only ever served relative to a SPECIFIC BRANCH the caller
 * has already been permission-checked against (by the route's middleware
 * config). This function is the second half of that check: it verifies the
 * file's page actually matches the branch's page, so a file id can't be reused
 * to view content unrelated to the branch the requester was authorized for.
 */
export async function getFileForBranch(fileId: string, branchId: string) {
  const { db } = getDb();
  const [file] = await db.select().from(files).where(eq(files.id, fileId));
  if (!file) return null;

  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) return null;

  if (file.pageId !== branch.pageId) return null; // the actual security check

  const data = await readFile(resolveStoragePath(file.storagePath));
  return { file, data };
}
