import { describe, it, expect } from "vitest";
import { computeLineDiff, splitFrontmatter } from "../diff.service.js";
import { stripFrontmatter } from "../markdown.service.js";

describe("diff.service helpers", () => {
  it("splitFrontmatter returns null title when there's no frontmatter", () => {
    const { title, body } = splitFrontmatter("just a body\nwith two lines\n");
    expect(title).toBeNull();
    expect(body).toBe("just a body\nwith two lines\n");
  });

  it("splitFrontmatter extracts the title from simple frontmatter", () => {
    const fm = '---\ntitle: "Hello"\n---\nbody line\n';
    const { title, body } = splitFrontmatter(fm);
    expect(title).toBe("Hello");
    expect(body).toBe("body line\n");
  });

  it("splitFrontmatter handles unquoted titles", () => {
    const fm = '---\ntitle: World\n---\nrest\n';
    const { title, body } = splitFrontmatter(fm);
    expect(title).toBe("World");
    expect(body).toBe("rest\n");
  });

  it("stripFrontmatter drops everything before the body delimiter", () => {
    expect(stripFrontmatter("---\ntitle: X\n---\nactual\n")).toBe("actual\n");
  });

  it("computeLineDiff flags added/removed/context correctly", () => {
    const lines = computeLineDiff(["a", "b", "c"], ["a", "B", "c", "d"]);
    const added = lines.filter((l) => l.type === "added").map((l) => l.text);
    const removed = lines.filter((l) => l.type === "removed").map((l) => l.text);
    const context = lines.filter((l) => l.type === "context").map((l) => l.text);
    expect(added).toContain("B");
    expect(added).toContain("d");
    expect(removed).toContain("b");
    expect(context).toContain("a");
    expect(context).toContain("c");
  });

  it("computeLineDiff returns all-context for identical inputs", () => {
    const lines = computeLineDiff(["x", "y"], ["x", "y"]);
    expect(lines.every((l) => l.type === "context")).toBe(true);
  });

  it("computeLineDiff returns all-added for empty from", () => {
    const lines = computeLineDiff([], ["x", "y"]);
    expect(lines.every((l) => l.type === "added")).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(["x", "y"]);
  });

  it("computeLineDiff returns all-removed for empty to", () => {
    const lines = computeLineDiff(["x", "y"], []);
    expect(lines.every((l) => l.type === "removed")).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(["x", "y"]);
  });
});
