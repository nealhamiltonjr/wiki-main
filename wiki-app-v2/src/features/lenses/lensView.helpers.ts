import type { LensHit, LensHitAttribute } from "../../api/client.js";

/**
 * Derive the union of promoted-attribute names across all hits,
 * sorted alphabetically. This becomes the table column order
 * (and the board-group dropdown's option list).
 *
 * Hidden "noise" attributes — anything starting with `#` or `_` —
 * are skipped. The product convention (mirrored in the server-side
 * `attributes` table) is that internal/system attributes use those
 * prefixes so users never accidentally promote them into a column.
 */
export function deriveColumns(hits: LensHit[]): string[] {
  const names = new Set<string>();
  for (const hit of hits) {
    for (const a of hit.promotedAttributes ?? []) {
      if (a.name.startsWith("#") || a.name.startsWith("_")) continue;
      names.add(a.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Lookup a single attribute on a hit by name. */
export function findAttr(hit: LensHit, name: string): LensHitAttribute | undefined {
  return hit.promotedAttributes?.find((a) => a.name === name);
}

/**
 * Sort hits by a chosen column. Hits missing the column are sorted
 * to the end (stable) — they appear last regardless of direction.
 * Empty string is treated as missing too.
 */
export function sortHits(
  hits: LensHit[],
  column: string | null,
  direction: "asc" | "desc",
): LensHit[] {
  if (!column) return hits;
  const dir = direction === "asc" ? 1 : -1;
  const has = (h: LensHit): boolean => {
    const v = findAttr(h, column)?.value ?? "";
    return v.length > 0;
  };
  return [...hits].sort((a, b) => {
    const aHas = has(a), bHas = has(b);
    if (aHas !== bHas) return aHas ? -1 : 1;
    const av = findAttr(a, column)?.value ?? "";
    const bv = findAttr(b, column)?.value ?? "";
    return av.localeCompare(bv) * dir;
  });
}

/**
 * Group hits by the value of a chosen attribute. The `__none__`
 * bucket catches hits that don't have a value for that attribute
 * (or have an empty value).
 */
export function groupHits(hits: LensHit[], column: string): Map<string, LensHit[]> {
  const groups = new Map<string, LensHit[]>();
  for (const hit of hits) {
    const v = findAttr(hit, column)?.value ?? "";
    const key = v.length > 0 ? v : "__none__";
    const list = groups.get(key);
    if (list) list.push(hit);
    else groups.set(key, [hit]);
  }
  // Stable column ordering: by group key alphabetical; "__none__" last.
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    return a.localeCompare(b);
  });
  return new Map(sorted);
}