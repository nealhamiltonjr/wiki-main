import { describe, it, expect } from "vitest";
import { resolveAccess } from "../algorithm.js";
import type { BranchContext, UserContext, BranchRole } from "../../types.js";

const branch = (over: Partial<BranchContext>): BranchContext => ({
  id: "b",
  spaceId: "s",
  visibility: "inherit",
  isSystem: false,
  parentBranchId: null,
  branchGroupPermissions: {},
  ...over,
});

const user = (over: Partial<UserContext> = {}): UserContext => ({
  id: "u",
  isAdmin: false,
  groupIds: [],
  spaceRoles: {},
  ...over,
});

describe("resolveAccess - visibility resolution", () => {
  it("a page's own explicit visibility wins over an ancestor's (the original bug)", () => {
    // A page explicitly marked 'private', sitting under a space root that's 'public'.
    const target = branch({ id: "page", visibility: "private" });
    const spaceRoot = branch({ id: "root", visibility: "public" });
    const chain = [target, spaceRoot]; // nearest-first

    expect(resolveAccess(user(), chain, null)).toBe("none");
    expect(resolveAccess(null, chain, null)).toBe("none");
  });

  it("inherits from the nearest ancestor with an explicit setting when the target itself is 'inherit'", () => {
    const target = branch({ id: "page", visibility: "inherit" });
    const spaceRoot = branch({ id: "root", visibility: "public" });
    expect(resolveAccess(null, [target, spaceRoot], null)).toBe("viewer");
  });
});

describe("resolveAccess - local boundaries (group_permissions)", () => {
  it("denies a non-matching group at a local boundary even under a public space (the second original bug)", () => {
    const hrGroupOnly: Record<string, BranchRole> = { "hr-group": "viewer" };
    const target = branch({ id: "hr-page", visibility: "inherit", branchGroupPermissions: hrGroupOnly });
    const spaceRoot = branch({ id: "root", visibility: "public" });
    const chain = [target, spaceRoot];

    expect(resolveAccess(user({ groupIds: ["tech-group"] }), chain, null)).toBe("none");
  });

  it("grants a matching group at that same boundary", () => {
    const hrGroupOnly: Record<string, BranchRole> = { "hr-group": "viewer" };
    const target = branch({ id: "hr-page", visibility: "inherit", branchGroupPermissions: hrGroupOnly });
    const spaceRoot = branch({ id: "root", visibility: "public" });
    const chain = [target, spaceRoot];

    expect(resolveAccess(user({ groupIds: ["hr-group"] }), chain, null)).toBe("viewer");
  });

  it("still lets an unauthenticated visitor read via public visibility - the boundary only governs authenticated users' groups", () => {
    const hrGroupOnly: Record<string, BranchRole> = { "hr-group": "viewer" };
    const target = branch({ id: "hr-page", visibility: "inherit", branchGroupPermissions: hrGroupOnly });
    const spaceRoot = branch({ id: "root", visibility: "public" });
    expect(resolveAccess(null, [target, spaceRoot], null)).toBe("viewer");
  });
});

describe("resolveAccess - system branch guard", () => {
  it("denies non-admins anywhere under a system (trash) branch", () => {
    const trash = branch({ id: "trash", isSystem: true });
    const page = branch({ id: "p", parentBranchId: "trash" });
    expect(resolveAccess(user(), [page, trash], "admin")).toBe("none");
  });

  it("still lets admins through", () => {
    const trash = branch({ id: "trash", isSystem: true });
    const page = branch({ id: "p", parentBranchId: "trash" });
    expect(resolveAccess(user({ isAdmin: true }), [page, trash], null)).toBe("admin");
  });
});

describe("resolveAccess - space fallback", () => {
  it("uses the space role when no branch-level override exists", () => {
    const chain = [branch({ id: "x", visibility: "inherit" })];
    expect(resolveAccess(user(), chain, "editor")).toBe("editor");
  });

  it("denies with no space role and private visibility", () => {
    const chain = [branch({ id: "x", visibility: "inherit" })];
    expect(resolveAccess(user(), chain, null)).toBe("none");
  });
});

describe("resolveAccess - cloning across spaces", () => {
  it("resolves each clone's placement independently", () => {
    const privateClone = [branch({ id: "b1", spaceId: "hr-space", visibility: "private" })];
    const publicClone = [branch({ id: "b2", spaceId: "public-space", visibility: "public" })];
    const outsider = user();

    expect(resolveAccess(outsider, privateClone, null)).toBe("none");
    expect(resolveAccess(outsider, publicClone, null)).toBe("viewer");
  });
});
