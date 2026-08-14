import type { SpaceSummary, TreeNode } from "@/api/client";

/**
 * Decides where the authenticated home page (`/`) should send the user.
 *
 * Rules — locked in by slice-47 so a fresh-install first user lands inside
 * the Welcome space the bootstrap seeds (§11.6 + slice-18), instead of on
 * the slice-1 "Knowledge Base" placeholder that previously greeted them.
 *
 *   - 0 spaces → render the empty state ("create your first space").
 *   - 1 space  → redirect to the first branch of that space's tree (the
 *                seed's Welcome page, by default). If that single space
 *                somehow has an empty tree, fall back to the list view
 *                instead of bouncing to a 404.
 *   - 2+ spaces → render the list and let the user choose.
 *
 * Returns `null` for "stay on this page". Returns a branchId otherwise.
 * The component handles the actual `navigate({ to: "/w/$branchId" })` so
 * the React-router coupling stays out of this helper (and the helper
 * stays unit-testable without a DOM).
 */
export function homeRedirectTarget(
  spaces: SpaceSummary[] | null | undefined,
  tree: TreeNode[] | null | undefined,
): { branchId: string } | null {
  if (!spaces || spaces.length !== 1) return null;
  if (!tree || tree.length === 0) return null;
  const first = tree[0];
  if (!first) return null;
  return { branchId: first.id };
}