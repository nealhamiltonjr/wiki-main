export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no body */ }
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface SpaceSummary { id: string; name: string }
export interface TreeNode { id: string; pageId: string; slug: string; children: TreeNode[] }
export interface PageContent {
  pageId: string; branchId: string; slug: string; title: string; content: unknown; updatedAt: string; access: string;
}
export interface HistoryEntry { hash: string; message: string; date: string }
export interface FileUploadResult { id: string; filename: string }
export interface ShareLinkResult { id: string; token: string }
export interface CommentThread {
  id: string; pageId: string;
  blockId: string | null;
  rangeFrom: number; rangeTo: number;
  selection: string | null;
  resolvedAt: string | null; resolvedBy: string | null; createdBy: string;
  createdAt: string; comments: Comment[];
  authorName?: string | null; resolvedByName?: string | null;
}
export interface Comment {
  id: string; threadId: string; body: string; userId: string;
  createdAt: string; updatedAt: string;
  authorName?: string | null;
}

export interface AdminSettingView {
  key: string;
  section: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "secret" | "textarea";
  default?: unknown;
  options?: { value: string; label: string }[];
  help?: string;
  value: unknown;
  isSecret: boolean;
  isDefault: boolean;
  updatedAt: string;
}

export interface RepoStatus {
  branch: string;
  headHash: string;
  headMessage: string;
  dirty: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  sizeBytes: number;
  remoteUrl: string | null;
  remoteBranch: string;
}

export interface RepoLogEntry { hash: string; message: string; date: string; author: string }

export interface BranchGrant { groupId: string; groupName: string; role: "viewer" | "editor" }
export interface BranchPermissions {
  grants: BranchGrant[];
  groups: { id: string; name: string }[];
}

export const api = {
  getUserSettings: () => request<Record<string, unknown>>("/api/user-settings"),
  setUserSetting: (key: string, value: unknown) =>
    request<void>(`/api/user-settings/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  listSettings: () => request<AdminSettingView[]>("/api/settings"),
  setSetting: (key: string, value: unknown) =>
    request<void>(`/api/settings/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  deleteSetting: (key: string) =>
    request<void>(`/api/settings/${encodeURIComponent(key)}`, { method: "DELETE" }),
  getRepoStatus: () => request<RepoStatus>("/api/git/status"),
  gitPush: (opts?: { force?: boolean }) =>
    request<{ queued: true }>("/api/git/push", { method: "POST", body: JSON.stringify(opts ?? {}) }),
  gitPull: () => request<{ queued: true }>("/api/git/pull", { method: "POST" }),
  getRepoLog: (limit?: number) =>
    request<RepoLogEntry[]>(`/api/git/log${limit ? `?limit=${limit}` : ""}`),
  testGitRemote: () => request<{ ok: true; reachable: boolean; message: string }>("/api/git/test-remote", { method: "POST" }),
  listGroups: () => request<{ id: string; name: string }[]>("/api/groups"),
  createGroup: (name: string) => request<{ id: string; name: string }>("/api/groups", { method: "POST", body: JSON.stringify({ name }) }),
  deleteGroup: (id: string) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),
  listGroupMembers: (groupId: string) => request<{ userId: string; email: string; name: string }[]>(`/api/groups/${groupId}/members`),
  addGroupMember: (groupId: string, userId: string) =>
    request<void>(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId }) }),
  removeGroupMember: (groupId: string, userId: string) =>
    request<void>(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
  getBranchPermissions: (branchId: string) =>
    request<BranchPermissions>(`/api/branches/${branchId}/permissions`),
  setBranchPermissions: (branchId: string, grants: { groupId: string; role: "viewer" | "editor" }[]) =>
    request<void>(`/api/branches/${branchId}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ grants }),
    }),
  removeBranchPermission: (branchId: string, groupId: string) =>
    request<void>(`/api/branches/${branchId}/permissions/${groupId}`, { method: "DELETE" }),
  listAdminUsers: () => request<{ id: string; email: string; name: string; isAdmin: boolean }[]>("/api/admin/users"),
  listSpaces: () => request<SpaceSummary[]>("/api/spaces"),
  createSpace: (name: string) => request<SpaceSummary>("/api/spaces", { method: "POST", body: JSON.stringify({ name }) }),
  getSpaceTree: (spaceId: string) => request<TreeNode[]>(`/api/spaces/${spaceId}/tree`),
  getPage: (branchId: string) => request<PageContent>(`/api/branches/${branchId}/page`),
  createPage: (opts: { slug: string; spaceId: string; parentBranchId: string | null; templateId?: string }) =>
    request<{ pageId: string; branchId: string }>("/api/pages", { method: "POST", body: JSON.stringify(opts) }),
  savePage: (pageId: string, branchId: string, content: unknown, expectedUpdatedAt: string) =>
    request<{ ok: true }>(`/api/pages/${pageId}/branches/${branchId}`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedUpdatedAt }),
    }),
  snapshot: (pageId: string, branchId: string, message: string) =>
    request<{ queued: true }>(`/api/pages/${pageId}/branches/${branchId}/snapshot`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  getHistory: (pageId: string, branchId: string) =>
    request<HistoryEntry[]>(`/api/pages/${pageId}/branches/${branchId}/history`),
  restoreHistory: (pageId: string, branchId: string, commitHash: string) =>
    request<{ ok: true }>(`/api/pages/${pageId}/branches/${branchId}/restore`, {
      method: "POST",
      body: JSON.stringify({ commitHash }),
    }),
  uploadFile: async (branchId: string, file: File): Promise<FileUploadResult> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/branches/${branchId}/files`, { method: "POST", body: form, credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  },
  createShareLink: (branchId: string, opts: { permission: "view" | "edit"; expiresAt: string | null; password?: string }) =>
    request<ShareLinkResult>(`/api/branches/${branchId}/share-links`, {
      method: "POST",
      body: JSON.stringify({ scopeType: "branch", scopeId: branchId, ...opts }),
    }),
  // Page/branch management (§7.1)
  renamePage: (pageId: string, branchId: string, slug: string) =>
    request<{ ok: true; slug: string }>(`/api/pages/${pageId}/branches/${branchId}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug }),
    }),
  cloneBranch: (branchId: string, opts: { targetSpaceId: string; targetParentBranchId: string | null }) =>
    request<{ branchId: string; pageId: string }>(`/api/branches/${branchId}/clone`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),
  moveBranch: (branchId: string, newParentBranchId: string | null) =>
    request<{ ok: true }>(`/api/branches/${branchId}/move`, {
      method: "PUT",
      body: JSON.stringify({ newParentBranchId }),
    }),
  removePlacement: (branchId: string) =>
    request<{ ok: true }>(`/api/branches/${branchId}`, { method: "DELETE" }),
  deletePageEverywhere: (pageId: string, branchId: string) =>
    request<{ ok: true }>(`/api/pages/${pageId}?branchId=${encodeURIComponent(branchId)}`, { method: "DELETE" }),
  // Comments (§7.6)
  getComments: (branchId: string) => request<CommentThread[]>(`/api/branches/${branchId}/comments`),
  createCommentThread: (branchId: string, rangeFrom: number, rangeTo: number, body: string, opts?: { selection?: string; blockId?: string }) =>
    request<{ threadId: string }>(`/api/branches/${branchId}/comments`, {
      method: "POST",
      body: JSON.stringify({ rangeFrom, rangeTo, body, ...opts }),
    }),
  addCommentReply: (branchId: string, threadId: string, body: string) =>
    request<Comment>(`/api/branches/${branchId}/comments/${threadId}`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  editComment: (commentId: string, body: string) =>
    request<{ ok: true }>(`/api/comments/${commentId}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    }),
  deleteComment: (commentId: string) =>
    request<{ ok: true }>(`/api/comments/${commentId}`, { method: "DELETE" }),
  resolveCommentThread: (threadId: string) =>
    request<{ resolved: boolean }>(`/api/comment-threads/${threadId}/resolve`, { method: "PUT" }),
  /** Search wiki pages via FTS5 (§7.12d.2). */
  search: (q: string) => request<{ results: unknown[] }>(`/api/search?q=${encodeURIComponent(q)}`),

  /** Notifications (§7.12d.4). */
  getNotifications: () => request<{ items: unknown[]; unread: number }>("/api/notifications"),
  markNotificationRead: (id: string) => request<{ ok: true }>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "PUT" }),
  markAllNotificationsRead: () => request<{ ok: true }>("/api/notifications/read-all", { method: "PUT" }),
  getUnreadNotificationCount: () => request<{ unread: number }>("/api/notifications/unread-count"),

  /** Favorites (§7.12d.7). */
  getFavorites: () => request<{ id: string; branchId: string; slug: string }[]>("/api/favorites"),
  toggleFavorite: (branchId: string) => request<{ favorited: boolean }>(`/api/favorites/${encodeURIComponent(branchId)}`, { method: "POST" }),
};
