import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { files, branches } from "../db/schema.js";

const FILES_ROOT = process.env.FILES_ROOT ?? "./data/files";

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
 * §3.13a - a file is only ever served relative to a SPECIFIC BRANCH the caller
 * has already been permission-checked against (by the route's middleware
 * config). This function is the second half of that check: it verifies the
 * file's page actually matches the branch's page, so a file id can't be reused
 * to view content unrelated to the branch the requester was authorized for.
 */
export async function getFileForBranch(fileId: string, branchId: string) {
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
