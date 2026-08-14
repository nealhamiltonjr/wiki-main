import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@/api/client";
import { homeRedirectTarget } from "@/features/home/homeRedirect";
import { useQuery } from "@/lib/useQuery";

export const Route = createFileRoute("/_authenticated/")({
  component: HomePage,
});

/**
 * Slice-47 — landing page.
 *
 * Goals:
 *   1. The bootstrap seeds the Welcome space for the first admin (§11.6 +
 *      slice-18). Before this slice, landing on `/` showed a slice-1
 *      "Knowledge Base" placeholder and the user had to manually click
 *      around to find their spaces. With this slice:
 *      - A user who has exactly one space is auto-redirected to the first
 *        branch in that space's tree (the Welcome page, by default).
 *      - A user with multiple spaces lands on a simple list and chooses.
 *      - A user with zero spaces sees an empty state with a "Create your
 *        first space" affordance (the slice-4 page covers creation).
 *   2. The redirect fires ONCE per mount; if the user comes back to `/`
 *      from inside a space, they should still land on the list (the
 *      `redirecting` ref guard makes that work).
 */
function HomePage() {
  const navigate = useNavigate();
  const [redirecting, setRedirecting] = useState(true);
  const { data: spaces, loading: loadingSpaces, error: spacesError } = useQuery(
    () => api.listSpaces(),
    [],
  );
  const firstSpaceId = spaces?.[0]?.id;
  const singleSpace = !!firstSpaceId && spaces!.length === 1;
  const { data: tree, loading: loadingTree } = useQuery(
    async () => {
      if (!firstSpaceId) return [];
      return api.getSpaceTree(firstSpaceId);
    },
    [firstSpaceId],
  );

  useEffect(() => {
    // We only auto-redirect when the user has exactly one space AND we've
    // resolved its tree — otherwise the URL would briefly bounce. Multi-
    // space users get the list; zero-space users get the empty state.
    if (!redirecting) return;
    const target = homeRedirectTarget(spaces, tree);
    if (!target) {
      setRedirecting(false);
      return;
    }
    void navigate({ to: "/w/$branchId", params: { branchId: target.branchId } });
    // (no setRedirecting(false) — the navigate replaces the route and unmounts us)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirecting, spaces, tree, navigate]);

  if (loadingSpaces) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading your wiki…</div>
    );
  }
  if (spacesError) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Knowledge Base</h1>
        <p className="mt-2 text-sm text-destructive">
          Could not load your spaces: {spacesError.message}
        </p>
      </div>
    );
  }
  if (!spaces || spaces.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Welcome to your wiki</h1>
        <p className="mt-2 text-muted-foreground">
          You don't have any spaces yet. Create one to start writing pages.
        </p>
        <a
          className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary-hover"
          href="/settings/spaces"
        >
          Create a space
        </a>
      </div>
    );
  }
  if (singleSpace && loadingTree) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    );
  }
  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Your spaces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a space to open, or jump straight to a page.
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {spaces.map((s) => (
          <li key={s.id} className="rounded-md border p-4">
            <div className="text-base font-medium">{s.name}</div>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Use the page tree on the left to navigate to a specific page, or open
        the space from <a className="underline" href="/settings/spaces">Settings → Spaces</a>.
      </p>
    </div>
  );
}