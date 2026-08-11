export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    // Only declare a JSON body when one exists — Fastify 400s on
    // Content-Type: application/json with an empty body (e.g. POST toggles).
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...init?.headers },
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
export interface TreeNode { id: string; pageId: string; slug: string; icon?: string | null; children: TreeNode[] }

export interface PageAttribute { id: string; pageId: string; name: string; value: string; isPromoted: boolean; position: number }
export interface PagePlacement { id: string; slug: string }
export interface BacklinkEntry { sourceBranchId: string; sourceSlug: string; sourceTitle: string | null; targetBlockId: string | null }

export interface PageData {
  id: string;
  slug: string;
  title: string;
  content: unknown;
  updatedAt: string;
  branchId: string;
  access?: string;
  attributes: PageAttribute[];
  placements: PagePlacement[];
  backlinks: BacklinkEntry[];
}

export interface TrashEntry { branchId: string; pageId: string; slug: string; title: string; deletedAt: string }

export interface CommentThread {
  id: string;
  pageId: string;
  blockId: string | null;
  rangeFrom: number;
  rangeTo: number;
  selection: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdBy: string;
  authorName?: string | null;
  resolvedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  comments: CommentItem[];
}

export interface CommentItem {
  id: string;
  threadId: string;
  body: string;
  userId: string;
  authorName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FavoriteEntry { id: string; branchId: string; slug: string; title: string }
export interface PageHistoryEntry { hash: string; message: string; date: string }

export interface NotificationEntry {
  id: string;
  userId: string;
  kind: "mention" | "system" | "share_warning";
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export const api = {
  listSpaces: () => request<SpaceSummary[]>("/api/spaces"),
  createSpace: (name: string) => request<{ id: string; name: string }>("/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  }),
  getSpaceTree: (spaceId: string) => request<TreeNode[]>(`/api/spaces/${spaceId}/tree`),
  getPage: (branchId: string) => request<PageData>(`/api/branches/${branchId}/page`),
  savePageContent: (branchId: string, body: {
    content: unknown;
    title?: string;
    titleProvided?: boolean;
    expectedUpdatedAt: Date;
  }) => request<{ ok: true; updatedAt?: string; title?: string }>(
    `/api/branches/${branchId}/page/content`,
    { method: "PUT", body: JSON.stringify(body) }
  ),
  createPage: (spaceId: string, body: { slug: string; title?: string; parentBranchId?: string | null }) =>
    request<{ branchId: string; pageId: string }>(`/api/spaces/${spaceId}/pages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deletePage: (branchId: string) =>
    request<{ ok: true }>(`/api/branches/${branchId}/page`, { method: "DELETE" }),
  listTrash: (spaceId: string) => request<TrashEntry[]>(`/api/spaces/${spaceId}/trash`),
  restorePage: (spaceId: string, pageId: string) =>
    request<{ ok: true }>(`/api/spaces/${spaceId}/trash/restore`, {
      method: "POST",
      body: JSON.stringify({ pageId }),
    }),
  purgePage: (spaceId: string, pageId: string) =>
    request<{ ok: true }>(`/api/spaces/${spaceId}/trash/purge`, {
      method: "POST",
      body: JSON.stringify({ pageId }),
    }),
  listComments: (branchId: string) => request<CommentThread[]>(`/api/branches/${branchId}/comments`),
  createCommentThread: (branchId: string, body: { rangeFrom: number; rangeTo: number; blockId?: string; selection?: string; body: string }) =>
    request<{ threadId: string }>(`/api/branches/${branchId}/comments`, { method: "POST", body: JSON.stringify(body) }),
  replyToThread: (branchId: string, threadId: string, body: string) =>
    request<CommentItem>(`/api/branches/${branchId}/comments/${threadId}`, { method: "POST", body: JSON.stringify({ body }) }),
  resolveThread: (threadId: string) =>
    request<{ resolved: boolean }>(`/api/comment-threads/${threadId}/resolve`, { method: "PUT" }),
  listFavorites: () => request<FavoriteEntry[]>("/api/favorites"),
  toggleFavorite: (branchId: string) => request<{ favorited: boolean }>(`/api/favorites/${branchId}`, { method: "POST" }),
  getPageHistory: (pageId: string, branchId: string) =>
    request<PageHistoryEntry[]>(`/api/pages/${pageId}/branches/${branchId}/history`),
  createSnapshot: (pageId: string, branchId: string, message: string) =>
    request<{ queued: true }>(`/api/pages/${pageId}/branches/${branchId}/snapshot`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  restorePageVersion: (pageId: string, branchId: string, commitHash: string) =>
    request<{ ok: true }>(`/api/pages/${pageId}/branches/${branchId}/restore`, {
      method: "POST",
      body: JSON.stringify({ commitHash }),
    }),
  listNotifications: () => request<{ items: NotificationEntry[]; unread: number }>("/api/notifications"),
  unreadCount: () => request<{ unread: number }>("/api/notifications/unread-count"),
  markNotificationRead: (id: string) => request<{ ok: true }>(`/api/notifications/${id}/read`, { method: "PUT" }),
  markAllNotificationsRead: () => request<{ ok: true }>("/api/notifications/read-all", { method: "PUT" }),
};
