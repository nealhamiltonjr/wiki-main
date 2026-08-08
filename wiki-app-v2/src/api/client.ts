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

export const api = {
  listSpaces: () => request<SpaceSummary[]>("/api/spaces"),
  createSpace: (name: string) => request<{ id: string; name: string }>("/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  }),
  getSpaceTree: (spaceId: string) => request<TreeNode[]>(`/api/spaces/${spaceId}/tree`),
};
