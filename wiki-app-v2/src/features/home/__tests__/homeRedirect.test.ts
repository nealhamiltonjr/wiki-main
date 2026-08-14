import { describe, it, expect } from "vitest";
import { homeRedirectTarget } from "../homeRedirect";
import type { SpaceSummary, TreeNode } from "@/api/client";

/**
 * Slice-47 — home redirect helper. The behavior is constrained: a fresh-
 * install first admin (with exactly the Welcome space the bootstrap
 * seeded) should land inside that space without seeing the slice-1
 * "Knowledge Base" stub.
 */

const welcomeSpace: SpaceSummary = { id: "s-welcome", name: "Welcome" };
const secondSpace: SpaceSummary = { id: "s-second", name: "Second" };
const welcomeTree: TreeNode[] = [
  { id: "b-welcome", pageId: "p-welcome", slug: "welcome", icon: "🏠", children: [] },
];
const multiTree: TreeNode[] = [
  { id: "b-1", pageId: "p-1", slug: "one", children: [] },
  { id: "b-2", pageId: "p-2", slug: "two", children: [] },
];

describe("homeRedirectTarget (slice-47)", () => {
  it("redirects to the first branch when the user has exactly one space with a tree", () => {
    expect(homeRedirectTarget([welcomeSpace], welcomeTree)).toEqual({
      branchId: "b-welcome",
    });
  });

  it("does not redirect with zero spaces (shows empty state)", () => {
    expect(homeRedirectTarget([], welcomeTree)).toBeNull();
    expect(homeRedirectTarget(null, welcomeTree)).toBeNull();
    expect(homeRedirectTarget(undefined, welcomeTree)).toBeNull();
  });

  it("does not redirect with 2+ spaces (shows the list)", () => {
    expect(homeRedirectTarget([welcomeSpace, secondSpace], welcomeTree)).toBeNull();
  });

  it("does not redirect when the only space has an empty tree (avoids 404)", () => {
    expect(homeRedirectTarget([welcomeSpace], [])).toBeNull();
    expect(homeRedirectTarget([welcomeSpace], null)).toBeNull();
  });

  it("returns the FIRST top-level branch of the tree, not the last", () => {
    expect(homeRedirectTarget([welcomeSpace], multiTree)).toEqual({
      branchId: "b-1",
    });
  });

  it("treats undefined spaces the same as no spaces (loading state)", () => {
    expect(homeRedirectTarget(undefined, undefined)).toBeNull();
  });
});