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

/** Brief §13.3: a direct template reference (relation attribute with
 *  name="template"). The banner shown above the page header is built
 *  from these. */
export interface TemplateRef {
  pageId: string;
  title: string;
  branchId: string | null;
  position: number;
}

/** An attribute inherited from a template page (not the page's own).
 *  `templatePageId` + `depth` give the UI everything it needs to
 *  render "Inherited from <Template>". */
export interface InheritedAttribute {
  id: string;
  pageId: string;
  name: string;
  value: string;
  valuePageId: string | null;
  isPromoted: boolean;
  position: number;
  templatePageId: string;
  templateTitle: string;
  depth: number;
}

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
  /** Brief §13.3: direct template refs (relation attributes with
   *  name="template"). Empty when the page has no templates. */
  templates?: TemplateRef[];
  /** Attributes inherited from any template in the chain. Page's own
   *  attributes are returned in `attributes` and *not* repeated here. */
  inheritedAttributes?: InheritedAttribute[];
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

export interface PageSearchHit {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  snippet: string;
  spaceId: string;
  spaceName: string;
}

export interface PageSearchResponse {
  results: PageSearchHit[];
  spaces: Array<{ id: string; name: string; pageCount: number }>;
  count: number;
}

export interface OwnedRelation {
  id: string;
  type: string;
  position: number;
  createdAt: string;
  target: { id: string; title: string; branchId: string | null } | null;
}

export interface IncomingRelation {
  id: string;
  type: string;
  position: number;
  createdAt: string;
  source: { id: string; title: string; branchId: string | null } | null;
}

export interface GraphNode {
  id: string;
  title: string;
  branchId: string | null;
  isCenter: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "backlink" | "relation";
  label: string | null;
  direction: "out" | "in";
}

export interface PageGraphResponse {
  center: string;
  hops: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Lenses — brief §13.4
// ---------------------------------------------------------------------------

/** A saved lens as returned by GET /api/lenses (summary list). */
export interface LensSummary {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  visibility: "private" | "unlisted" | "public";
  shareToken: string | null;
  createdAt: string;
}

/** A lens's stored criteria. Mirrors the server-side `LensCriteria`. */
export interface LensCriteria {
  tags?: string[];
  properties?: Array<{ name: string; value: string }>;
  titleRegex?: string;
  ownerScope?: "self" | "anyone" | { kind: "group"; groupId: string };
  spaceIds?: string[];
  includeTrash?: boolean;
}

/** A lens detail (criteria parsed). */
export interface LensDetail extends LensSummary {
  criteria: LensCriteria;
}

/** One promoted attribute on a lens hit, with provenance. */
export interface LensHitAttribute {
  name: string;
  value: string;
  own: boolean;
  fromTitle?: string;
}

/** A page that matched a lens. The `promotedAttributes` field is
 *  present only when the request used `?include=attributes`. */
export interface LensHit {
  pageId: string;
  title: string;
  slug: string;
  spaceId: string;
  spaceName: string;
  ownerId: string | null;
  branchId: string;
  isTrashed: boolean;
  promotedAttributes?: LensHitAttribute[];
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
  searchPages: (q: string, opts: { spaceId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.spaceId) params.set("spaceId", opts.spaceId);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    return request<PageSearchResponse>(`/api/search?${params.toString()}`);
  },
  listOwnedRelations: (pageId: string) =>
    request<{ owned: OwnedRelation[] }>(`/api/pages/${pageId}/relations`),
  listIncomingRelations: (pageId: string) =>
    request<{ incoming: IncomingRelation[] }>(`/api/pages/${pageId}/relations/incoming`),
  addRelation: (pageId: string, body: { type: string; toPageId: string; position?: number }) =>
    request<OwnedRelation>(`/api/pages/${pageId}/relations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeRelation: (pageId: string, attributeId: string) =>
    request<void>(`/api/pages/${pageId}/relations/${attributeId}`, { method: "DELETE" }),

  // Brief §13.2: graph view of a page's local neighborhood.
  getPageGraph: (pageId: string, opts: { hops?: number } = {}) => {
    const q = opts.hops === undefined ? "" : `?hops=${Math.min(Math.max(opts.hops, 1), 3)}`;
    return request<PageGraphResponse>(`/api/pages/${pageId}/graph${q}`);
  },

  // Brief §13.4: lenses with table & board views.
  listLenses: () => request<LensSummary[]>("/api/lenses"),
  getLens: (lensId: string) => request<LensDetail>(`/api/lenses/${lensId}`),
  runLens: (lensId: string, opts: { includeAttributes?: boolean } = {}) =>
    request<{ lens: LensDetail; hits: LensHit[] }>(
      `/api/lenses/${lensId}/results${opts.includeAttributes ? "?include=attributes" : ""}`,
    ),
  runLensByToken: (token: string, opts: { includeAttributes?: boolean } = {}) =>
    request<{ lens: LensDetail; hits: LensHit[] }>(
      `/api/lenses/by-token/${token}/results${opts.includeAttributes ? "?include=attributes" : ""}`,
    ),
};
