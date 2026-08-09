import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { files, branches } from "../db/schema.js";

// Resolve relative to the project root, mirroring db/index.ts (services/ ->
// server/ -> src/ -> root is 3 hops).
const projectRoot = path.resolve(path.dirname(new URL(".", import.meta.url).pathname), "../../..");
export const FILES_ROOT = process.env.FILES_ROOT
  ? path.resolve(projectRoot, process.env.FILES_ROOT)
  : path.resolve(projectRoot, "data/files");

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

export async function storeFile(opts: {
  pageId: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy: string;
}) {
  const id = crypto.randomUUID();
  const storagePath = path.join(opts.pageId, `${id}-${sanitize(opts.filename)}`);
  const fullPath = path.join(FILES_ROOT, storagePath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, opts.data);

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

  const data = await readFile(path.join(FILES_ROOT, file.storagePath));
  return { file, data };
}

function sanitize(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}
