import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, files, spaces as spacesTable } from "../db/schema.js";
import { exportMarkdown } from "./markdown.service.js";
import { accessibleBranchIds, resolveSpaceRole } from "./branch.service.js";
import type { UserContext } from "../../shared/types.js";
import * as fflate from "fflate";

const FILES_ROOT = process.env.FILES_ROOT ?? "./data/files";

export interface ExportFile { path: string; content: string; }
export interface ExportAsset { path: string; data: Uint8Array; }

function slugify(s: string): string { return (s || "page").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "page"; }

export async function exportBranch(branchId: string, opts: { includeImages?: boolean } = {}): Promise<{ files: ExportFile[]; assets: ExportAsset[] }> {
  const { db } = getDb();
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) throw new Error("Branch not found");
  const [page] = await db.select().from(pages).where(and(eq(pages.id, branch.pageId), isNull(pages.deletedAt)));
  if (!page) throw new Error("Page not found");
  const [space] = await db.select().from(spacesTable).where(eq(spacesTable.id, branch.spaceId));
  const spaceSlug = slugify(space?.name ?? "space");
  const pageSlug = slugify(page.slug);
  const { markdown, images } = exportMarkdown(page.content as never, { imageMode: opts.includeImages !== false ? "copy" : "raw" });
  const frontmatter = `---\ntitle: ${JSON.stringify(page.title)}\nslug: ${JSON.stringify(page.slug)}\ndate: ${page.updatedAt?.toISOString() ?? ""}\n---\n\n`;
  const body = frontmatter + (page.title ? `# ${page.title}\n\n` : "") + markdown;
  const exportFiles: ExportFile[] = [{ path: `${spaceSlug}/${pageSlug}.md`, content: body }];
  const assets: ExportAsset[] = [];
  if (opts.includeImages !== false) {
    for (const img of images) {
      const fileRows = await db.select().from(files).where(eq(files.id, img.fileId));
      const file = fileRows[0];
      if (!file || file.pageId !== page.id) continue;
      try { const data = await readFile(path.join(FILES_ROOT, file.storagePath)); const assetPath = `${spaceSlug}/assets/${file.id}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`; assets.push({ path: assetPath, data: new Uint8Array(data) }); } catch { /* */ }
    }
  }
  return { files: exportFiles, assets };
}

export async function exportSpace(spaceId: string, user: UserContext, opts: { includeImages?: boolean } = {}): Promise<{ files: ExportFile[]; assets: ExportAsset[] }> {
  const { db } = getDb();
  const [space] = await db.select().from(spacesTable).where(eq(spacesTable.id, spaceId));
  if (!space) throw new Error("Space not found");
  const spaceRole = await resolveSpaceRole(user.id, spaceId, user.groupIds);
  const branchIds = await accessibleBranchIds(user, spaceId, spaceRole);
  if (branchIds.size === 0) return { files: [], assets: [] };
  const allFiles: ExportFile[] = []; const allAssets: ExportAsset[] = [];
  for (const branchId of branchIds) { try { const r = await exportBranch(branchId, opts); allFiles.push(...r.files); allAssets.push(...r.assets); } catch { /* */ } }
  return { files: allFiles, assets: allAssets };
}

export function buildZip(files: ExportFile[], assets: ExportAsset[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.path] = new TextEncoder().encode(f.content);
  for (const a of assets) entries[a.path] = a.data;
  return fflate.zipSync(entries, { level: 6 });
}
