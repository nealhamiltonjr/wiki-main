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
  pageId: string; branchId: string; slug: string; content: unknown; updatedAt: string; access: string;
}
export interface HistoryEntry { hash: string; message: string; date: string }
export interface FileUploadResult { id: string; filename: string }
export interface ShareLinkResult { id: string; token: string }
export interface CommentThread {
  id: string; pageId: string; rangeFrom: number; rangeTo: number;
  resolvedAt: string | null; resolvedBy: string | null; createdBy: string;
  createdAt: string; comments: Comment[];
}
export interface Comment {
  id: string; threadId: string; body: string; userId: string;
  createdAt: string; updatedAt: string;
}

export const api = {
  getUserSettings: () => request<Record<string, unknown>>("/api/user-settings"),
  setUserSetting: (key: string, value: unknown) =>
    request<void>(`/api/user-settings/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }),
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
  // Comments (§7.6)
  getComments: (branchId: string) => request<CommentThread[]>(`/api/branches/${branchId}/comments`),
  createCommentThread: (branchId: string, rangeFrom: number, rangeTo: number, body: string) =>
    request<{ threadId: string }>(`/api/branches/${branchId}/comments`, {
      method: "POST",
      body: JSON.stringify({ rangeFrom, rangeTo, body }),
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
};
