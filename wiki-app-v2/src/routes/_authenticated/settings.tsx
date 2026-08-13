import { useEffect } from "react";
import { createFileRoute, Outlet, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useSession } from "@/api/authClient";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

// §7.2 Audit pass (slice-14 gate). Every settings-shaped surface in the app
// either lives inside `/settings/*` (this route's ten sub-pages) or is one of
// the deliberate page-contextual controls below. Nothing to move as of this
// commit; this comment is the audit receipt and the rule future PRs must not
// break without updating it.
//
//   * Topbar `Settings` link → `/settings/plugins` (E2E gate). The user
//     reaches every settings sub-page from there on every page.
//   * Sidebar space selector (`features/tree/Tree.tsx`) — navigation, not
//     settings. Toggles the visible tree; exposes no role/permission knobs.
//   * Page chrome (`routes/_authenticated/w/$branchId.tsx`) — Favorite, Edit,
//     History, Comments. None are settings-shaped.
//   * HistoryPanel "Save a named snapshot" form — a page-contextual action
//     that writes a new history entry for the open page. Not a settings form.
//   * CommentsPanel reply form — page-contextual conversation thread.
//   * NotificationBell — page-contextual (topbar surface). No preferences or
//     delivery settings live here; default delivery is email only and is
//     configured per-user inside `/settings/profile` (added in a later slice).
//   * Plugin settings panels — rendered inside `/settings/plugins` via
//     `registerSettingsPanel` (§4.4). A plugin cannot inject its own settings
//     UI into the page chrome.
//
// Deferred page-contextual controls (not yet built, both per §7.1's allowed
// exceptions, both will deep-link to `/settings/*` for anything beyond the
// single immediate action they own):
//   * Page "Share" dialog → token policy around no-expiration grants lives
//     in `/settings/tokens`; the dialog only owns the per-page share link.
//   * Branch "Permissions" dialog (right-click on the tree) → group / role
//     grants for that branch live; broad permission policy lives in
//     `/settings/groups` and `/settings/spaces`.
const SECTIONS = [
  { to: "/settings/profile", label: "Profile", adminOnly: false },
  { to: "/settings/appearance", label: "Appearance", adminOnly: false },
  { to: "/settings/tokens", label: "Tokens", adminOnly: false },
  { to: "/settings/spaces", label: "Spaces", adminOnly: true },
  { to: "/settings/groups", label: "Groups & Permissions", adminOnly: true },
  { to: "/settings/users", label: "Users", adminOnly: true },
  { to: "/settings/plugins", label: "Plugins", adminOnly: true },
  { to: "/settings/integrations", label: "Integrations", adminOnly: true },
  { to: "/settings/system", label: "System", adminOnly: true },
  { to: "/settings/danger", label: "Danger zone", adminOnly: true },
] as const;

function SettingsLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const routerState = useRouterState();

  if (isPending) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (!session) { void navigate({ to: "/login" }); return null; }

  const currentPath = routerState.location.pathname;
  const isAdmin = !!session.user.isAdmin;

  const visible = SECTIONS.filter((s) => !s.adminOnly || isAdmin);
  const activeSection = visible.find((s) => currentPath.startsWith(s.to));

  // Non-admin hitting an admin section URL directly → Profile. Must happen
  // after the session resolves (isAdmin is only known then).
  useEffect(() => {
    if (session && !activeSection && currentPath !== "/settings") {
      void navigate({ to: "/settings/profile" });
    }
  }, [session, activeSection, currentPath, navigate]);

  if (!activeSection && currentPath !== "/settings") {
    // Render nothing while the redirect effect runs — the correct section
    // never flashes.
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="w-52 shrink-0 border-r border-border p-2 space-y-0.5" aria-label="Settings sections">
        <p className="px-3 pb-2 pt-1 text-xs font-medium uppercase tracking-wide text-text-muted">Settings</p>
        {visible.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className={cn(
              "block rounded-md px-3 py-1.5 text-sm transition-colors",
              activeSection?.to === section.to
                ? "bg-surface-elevated font-medium text-foreground"
                : "text-text-secondary hover:bg-surface-hover hover:text-foreground"
            )}
          >
            {section.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-6">
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        <Outlet />
      </div>
    </div>
  );
}
