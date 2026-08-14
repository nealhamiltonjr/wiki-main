import { describe, it, expect } from "vitest";
import { deriveColumns, findAttr, sortHits, groupHits } from "../lensView.helpers";
import type { LensHit } from "../../../api/client";

const H = (
  pageId: string,
  title: string,
  promotedAttributes: Array<{ name: string; value: string; own: boolean; fromTitle?: string }> = [],
): LensHit => ({
  pageId,
  title,
  slug: title.toLowerCase().replace(/\s+/g, "-"),
  spaceId: "s1",
  spaceName: "Space",
  ownerId: null,
  branchId: `b-${pageId}`,
  isTrashed: false,
  promotedAttributes,
});

describe("lensView.helpers (slice-29, brief §13.4)", () => {
  describe("deriveColumns", () => {
    it("returns the union of promoted-attribute names sorted alphabetically", () => {
      const hits = [
        H("1", "a", [{ name: "callsign", value: "W1", own: true }, { name: "band", value: "20m", own: true }]),
        H("2", "b", [{ name: "callsign", value: "K2", own: true }, { name: "mode", value: "SSB", own: true }]),
      ];
      expect(deriveColumns(hits)).toEqual(["band", "callsign", "mode"]);
    });

    it("skips noise attributes starting with # or _", () => {
      const hits = [
        H("1", "a", [
          { name: "callsign", value: "W1", own: true },
          { name: "#internal", value: "x", own: true },
          { name: "_system", value: "y", own: true },
        ]),
      ];
      expect(deriveColumns(hits)).toEqual(["callsign"]);
    });

    it("returns an empty list when no hits have promoted attributes", () => {
      expect(deriveColumns([])).toEqual([]);
      expect(deriveColumns([H("1", "a")])).toEqual([]);
    });
  });

  describe("findAttr", () => {
    it("returns the attribute when present", () => {
      const hit = H("1", "a", [{ name: "band", value: "20m", own: true }]);
      expect(findAttr(hit, "band")?.value).toBe("20m");
      expect(findAttr(hit, "missing")).toBeUndefined();
    });
  });

  describe("sortHits", () => {
    const hits = [
      H("1", "z", [{ name: "band", value: "40m", own: true }]),
      H("2", "a", [{ name: "band", value: "20m", own: true }]),
      H("3", "m", [{ name: "band", value: "30m", own: true }]),
    ];

    it("sorts ascending by default", () => {
      const out = sortHits(hits, "band", "asc").map((h) => h.pageId);
      expect(out).toEqual(["2", "3", "1"]);
    });

    it("sorts descending", () => {
      const out = sortHits(hits, "band", "desc").map((h) => h.pageId);
      expect(out).toEqual(["1", "3", "2"]);
    });

    it("places hits missing the column at the end (asc)", () => {
      const withMissing = [...hits, H("4", "x")];
      const out = sortHits(withMissing, "band", "asc").map((h) => h.pageId);
      expect(out).toEqual(["2", "3", "1", "4"]);
    });

    it("returns the original order when sortColumn is null", () => {
      expect(sortHits(hits, null, "asc").map((h) => h.pageId)).toEqual(["1", "2", "3"]);
    });
  });

  describe("groupHits", () => {
    it("groups by attribute value with one bucket per distinct value", () => {
      const hits = [
        H("1", "a", [{ name: "status", value: "draft", own: true }]),
        H("2", "b", [{ name: "status", value: "published", own: true }]),
        H("3", "c", [{ name: "status", value: "draft", own: true }]),
        H("4", "d", [{ name: "status", value: "published", own: true }]),
      ];
      const groups = groupHits(hits, "status");
      expect([...groups.keys()]).toEqual(["draft", "published"]);
      expect(groups.get("draft")?.length).toBe(2);
      expect(groups.get("published")?.length).toBe(2);
    });

    it("puts hits missing the column into a __none__ bucket sorted last", () => {
      const hits = [
        H("1", "a", [{ name: "status", value: "draft", own: true }]),
        H("2", "b"),
      ];
      const groups = groupHits(hits, "status");
      expect([...groups.keys()]).toEqual(["draft", "__none__"]);
    });

    it("returns a single empty bucket when there are no hits", () => {
      expect([...groupHits([], "status").keys()]).toEqual([]);
    });
  });
});