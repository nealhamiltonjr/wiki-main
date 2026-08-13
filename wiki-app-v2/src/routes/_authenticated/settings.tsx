import { useEffect } from "react";
import { createFileRoute, Outlet, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useSession } from "@/api/authClient";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

// §7.1 Information architecture — one route with a left-hand sub-navigation.
// Profile / Appearance / Tokens are every signed-in user's own settings; the
// rest are admin-only instance management. Direct navigation to an admin
// section by a non-admin redirects to Profile below (the server also enforces
// `config.access: "admin"` on every one of those APIs, so this is UX, not the
// security boundary).
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
