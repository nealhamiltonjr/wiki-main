import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, files } from "../db/schema.js";
import { exportMarkdown, extractTitle, type ExportMarkdownOptions } from "./markdown.service.js";
import { accessibleBranchIds } from "./branch.service.js";
import type { UserContext, SpaceRole } from "../../shared/types.js";

const FILES_ROOT = process.env.FILES_ROOT ?? "./data/files";

export interface ExportMarkdownFile {
  path: string;
  content: string;
}
export interface ExportAsset {
  path: string;
  data: Buffer;
}

interface ParsedImage {
  src: string;
  branchId: string;
  fileId: string;
}

/**
 * Resolves every image referenced by an exported page to an asset bundle entry.
 * Each src is remapped to `assets/<fileId>-<filename>`; blobs are read from the
 * files store. If the file is gone or doesn't belong to the exported page, the
 * src is left untouched (the markdown keeps the raw API URL rather than being
 * silently broken).
 */
async function resolveImages(
  images: ParsedImage[],
  pageId: string
): Promise<{ srcMap: Map<string, string>; assets: ExportAsset[] }> {
  const srcMap = new Map<string, string>();
  const assets: ExportAsset[] = [];
  const seen = new Set<string>();

  for (const img of images) {
    const [file] = await db.select().from(files).where(eq(files.id, img.fileId));
    if (!file || file.pageId !== pageId) continue;
    if (seen.has(file.id)) continue;
    seen.add(file.id);

    const relPath = `assets/${file.id}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    try {
      const data = await readFile(path.join(FILES_ROOT, file.storagePath));
      srcMap.set(img.src, relPath);
      assets.push({ path: relPath, data });
    } catch {
      // blob missing on disk - keep the raw src
    }
  }
  return { srcMap, assets };
}

function loadDoc(content: unknown): Parameters<typeof exportMarkdown>[0] {
  if (typeof content === "string") {
    try { return JSON.parse(content); } catch { return { type: "doc", content: [] }; }
  }
  return (content ?? { type: "doc", content: [] }) as Parameters<typeof exportMarkdown>[0];
}

function rewriteSrcs(markdown: string, srcMap: Map<string, string>): string {
  let out = markdown;
  for (const [src, rel] of srcMap) out = out.split(src).join(rel);
  return out;
}

function slugify(slug: string): string {
  return (slug || "page").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "page";
}

/**
 * §7.11 SSG export for a single branch's page. The route has already
 * permission-checked the branch; this only decides presentation.
 */
export async function exportPageBundle(
  branchId: string,
  opts: { images: "copy" | "strip" | "raw"; frontmatter: boolean }
): Promise<{ markdownFile: ExportMarkdownFile; assets: ExportAsset[] }> {
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) throw new Error("Branch not found");
  const [page] = await db.select().from(pages).where(eq(pages.id, branch.pageId));
  if (!page) throw new Error("Page not found");

  const doc = loadDoc(page.content);
  const title = extractTitle(doc) ?? page.slug;
  const fm: ExportMarkdownOptions["frontmatter"] = opts.frontmatter
    ? { title, slug: page.slug, date: page.updatedAt?.toISOString() ?? null }
    : undefined;

  const { markdown, images } = exportMarkdown(doc, {
    imageMode: opts.images,
    internalLinkMode: "strip",
    frontmatter: fm,
  });

  const { srcMap, assets } = opts.images === "copy"
    ? await resolveImages(images, page.id)
    : { srcMap: new Map<string, string>(), assets: [] };

  return {
    markdownFile: { path: `${slugify(page.slug)}.md`, content: rewriteSrcs(markdown, srcMap) },
    assets,
  };
}

/**
 * §7.11 SSG export for a whole space. Exports every page the caller can
 * actually read (restricted-ancestor integration: branches the caller has no
 * access to are skipped entirely, so the bundle can't leak restricted pages
 * through a space export). A page placed in multiple branches is exported once.
 */
export async function exportSpaceBundle(
  user: UserContext,
  spaceId: string,
  spaceRole: SpaceRole | null,
  opts: { frontmatter: boolean }
): Promise<{ markdownFiles: ExportMarkdownFile[]; assets: ExportAsset[] }> {
  const accessible = await accessibleBranchIds(user, spaceId, spaceRole);

  const rows = await db
    .select({ branchId: branches.id, pageId: branches.pageId, slug: pages.slug, updatedAt: pages.updatedAt })
    .from(branches)
    .innerJoin(pages, and(eq(pages.id, branches.pageId), isNull(pages.deletedAt)))
    .where(and(eq(branches.spaceId, spaceId), eq(branches.isSystem, false)));

  // Pick one readable placement per page.
  const perPage = new Map<string, { branchId: string; slug: string; updatedAt: Date }>();
  for (const r of rows) {
    if (!accessible.has(r.branchId)) continue;
    if (!perPage.has(r.pageId)) perPage.set(r.pageId, { branchId: r.branchId, slug: r.slug, updatedAt: r.updatedAt });
  }

  const markdownFiles: ExportMarkdownFile[] = [];
  const assets: ExportAsset[] = [];
  const usedSlugs = new Map<string, number>();

  for (const [pageId, meta] of perPage) {
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!page) continue;

    const doc = loadDoc(page.content);
    const title = extractTitle(doc) ?? meta.slug;
    const fm: ExportMarkdownOptions["frontmatter"] = opts.frontmatter
      ? { title, slug: meta.slug, date: page.updatedAt?.toISOString() ?? null }
      : undefined;

    const { markdown, images } = exportMarkdown(doc, { imageMode: "copy", internalLinkMode: "strip", frontmatter: fm });
    const { srcMap, assets: pageAssets } = await resolveImages(images, pageId);
    assets.push(...pageAssets);

    let filename = slugify(meta.slug);
    const count = usedSlugs.get(filename) ?? 0;
    usedSlugs.set(filename, count + 1);
    if (count > 0) filename = `${filename}-${count + 1}`;

    markdownFiles.push({ path: `pages/${filename}.md`, content: rewriteSrcs(markdown, srcMap) });
  }

  return { markdownFiles, assets };
}
