import { getFileContentAtCommit } from "./git.service.js";
import { stripFrontmatter } from "./markdown.service.js";

export type DiffLineType = "context" | "added" | "removed";

export interface DiffLine {
  type: DiffLineType;
  /** 1-indexed line number on the `from` side, or null for added lines. */
  fromLine: number | null;
  /** 1-indexed line number on the `to` side, or null for removed lines. */
  toLine: number | null;
  text: string;
}

export interface RevisionDiff {
  pageId: string;
  fromHash: string;
  toHash: string;
  generatedAt: Date;
  /** Title diff derived from the YAML frontmatter. Null when the revision
   * has no frontmatter (older commits before §7.12 shipped). */
  titleChanged: boolean;
  fromTitle: string | null;
  toTitle: string | null;
  lines: DiffLine[];
  /** Counts for quick summary chips in the UI. */
  summary: { added: number; removed: number; context: number };
}

/**
 * Computes a unified-style diff between two revisions of a page (brief §12.3).
 *
 * Implementation notes:
 * - Reads both revisions from the git repo via `getFileContentAtCommit`
 *   (which already handles the "snapshot file vs autosave file" case from
 *   git.service.ts:120 — that distinction matters because once a snapshot
 *   exists, `_snapshots/<pageId>.md` appears in every later commit's tree,
 *   so naively reading it for an autosave commit would return stale snapshot
 *   content instead of that commit's real content).
 * - Strips YAML frontmatter before diffing: the body is what changed in the
 *   meaningful sense; the frontmatter is bookkeeping. Title changes are
 *   surfaced separately as `titleChanged` / `fromTitle` / `toTitle` so the
 *   UI can call them out without crowding the line diff.
 * - Line-level diff using a hand-rolled LCS (no extra dependency — `diff`
 *   is currently only available transitively via vitest, and the personal-
 *   wiki scope doesn't justify adding a runtime dep for this). Paragraph-
 *   level alignment isn't strictly preserved, but markdown is line-oriented
 *   enough that adjacent added/removed runs are visually obvious.
 */
export async function diffRevisions(
  pageId: string,
  fromHash: string,
  toHash: string,
): Promise<RevisionDiff> {
  const fromMarkdown = await getFileContentAtCommit(pageId, fromHash);
  const toMarkdown = await getFileContentAtCommit(pageId, toHash);

  const { body: fromBody, title: fromTitle } = splitFrontmatter(fromMarkdown);
  const { body: toBody, title: toTitle } = splitFrontmatter(toMarkdown);

  const fromLines = fromBody.split("\n");
  const toLines = toBody.split("\n");

  const lines = computeLineDiff(fromLines, toLines);

  return {
    pageId,
    fromHash,
    toHash,
    generatedAt: new Date(),
    titleChanged: fromTitle !== toTitle,
    fromTitle,
    toTitle,
    lines,
    summary: {
      added: lines.filter((l) => l.type === "added").length,
      removed: lines.filter((l) => l.type === "removed").length,
      context: lines.filter((l) => l.type === "context").length,
    },
  };
}

/** Split a markdown document's frontmatter from its body, also returning
 * the parsed title (or null when the document has no frontmatter). The
 * body is the post-frontmatter content with leading blank lines trimmed. */
export function splitFrontmatter(markdown: string): { body: string; title: string | null } {
  if (!markdown.startsWith("---")) return { body: markdown, title: null };
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: markdown, title: null };
  const fm = m[1] ?? "";
  const body = (m[2] ?? "").replace(/^\n+/, "");
  const titleMatch = fm.match(/^title:\s*(.*)$/m);
  const title = titleMatch ? unquoteYaml(titleMatch[1] ?? "") : null;
  return { body, title };
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/** Standard LCS-based line diff. O(N*M) memory; fine for page-sized files
 * (a personal-wiki page rarely exceeds a few hundred lines). */
export function computeLineDiff(from: string[], to: string[]): DiffLine[] {
  const m = from.length;
  const n = to.length;

  // `dp[i][j]` = LCS length of from[0..i) and to[0..j).
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    const fi = from[i - 1];
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (fi === to[j - 1]) {
        row[j] = prev[j - 1]! + 1;
      } else {
        const up = prev[j]!;
        const left = row[j - 1]!;
        row[j] = up > left ? up : left;
      }
    }
  }

  // Walk the matrix back-to-front, emitting diff lines.
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (from[i - 1] === to[j - 1]) {
      out.push({ type: "context", fromLine: i, toLine: j, text: from[i - 1] ?? "" });
      i--;
      j--;
    } else if ((dp[i - 1]?.[j] ?? 0) >= (dp[i]?.[j - 1] ?? 0)) {
      out.push({ type: "removed", fromLine: i, toLine: null, text: from[i - 1] ?? "" });
      i--;
    } else {
      out.push({ type: "added", fromLine: null, toLine: j, text: to[j - 1] ?? "" });
      j--;
    }
  }
  while (i > 0) {
    out.push({ type: "removed", fromLine: i, toLine: null, text: from[i - 1] ?? "" });
    i--;
  }
  while (j > 0) {
    out.push({ type: "added", fromLine: null, toLine: j, text: to[j - 1] ?? "" });
    j--;
  }
  out.reverse();
  return out;
}

/** Re-export `stripFrontmatter` so callers don't need to import markdown
 * service directly when they want the raw body without diffing. */
export { stripFrontmatter };