// Shared types - single source of truth between DB schema, API, and frontend.
// Naming follows brief v5 3.1: "page" = tree-level content unit, "branch" = its placement.

export type Visibility = "inherit" | "public" | "private";
export type BranchRole = "viewer" | "editor"; // branch-level grants are never 'admin' - brief 3.8
export type SpaceRole = "viewer" | "editor" | "admin"; // space-level roles CAN be admin - space-scoped only
export type AccessResult = "none" | "viewer" | "editor" | "admin";
export type TokenType = "share_link" | "api_token";
export type TokenScopeType = "branch" | "space" | "account";
export type TokenPermission = "view" | "edit" | "admin";

/** Everything the permission engine needs to know about the requester. */
export interface UserContext {
  id: string;
  isAdmin: boolean;
  groupIds: string[];
  /** Capabilities inherited from the user's groups (union). Empty for admin (isAdmin grants everything). */
  capabilities: string[];
  /** Space id -> role, from space_members ∪ best role via space_group_permissions. Pre-resolved by the caller. */
  spaceRoles: Record<string, SpaceRole>;
}

/** One branch node as needed by the permission algorithm - see shared/permissions/algorithm.ts */
export interface BranchContext {
  id: string;
  spaceId: string;
  visibility: Visibility;
  isSystem: boolean;
  parentBranchId: string | null;
  /** group_id -> role, populated only for branches with at least one explicit grant. */
  branchGroupPermissions: Record<string, BranchRole>;
}

export interface PageSummary {
  id: string;
  slug: string;
  ownerId: string;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BranchSummary {
  id: string;
  pageId: string;
  parentBranchId: string | null;
  position: number;
  spaceId: string;
  visibility: Visibility;
  isSystem: boolean;
  createdBy: string;
  createdAt: number;
}
