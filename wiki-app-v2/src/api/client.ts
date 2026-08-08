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
};
