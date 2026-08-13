import { useEffect } from "react";
import { createFileRoute, Outlet, useNavigate, Link } from "@tanstack/react-router";

import { useSession } from "@/api/authClient";
import { Tree } from "@/features/tree/Tree";
import { NotificationBell } from "@/features/notifications/NotificationBell";
import { loadPlugins } from "@/plugins/loader";
import { usePluginsLoaded } from "@/plugins/registry";

// Pathless authenticated layout: the single chrome shell (sidebar + topbar)
// that wraps every page a signed-in user can reach. The session gate redirects
// unauthenticated visitors to /login; the sidebar hosts the react-arborist
// space tree (slice 4) and the topbar holds breadcrumbs + account.
export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const pluginsLoaded = usePluginsLoaded();

  // Hooks must run unconditionally — this fires once the session resolves so
  // the plugin list fetch carries the auth cookie. loadPlugins is idempotent.
  useEffect(() => {
    if (session) void loadPlugins();
  }, [session]);

  if (isPending) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (!session) {
    void navigate({ to: "/login" });
    return null;
  }

  // Wait for plugin bundles to register BEFORE the first editor can mount —
  // the editor builds its Tiptap schema once, so a late plugin node/command
  // would never make it into the schema. loadPlugins resolves even on failure.
  if (!pluginsLoaded) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col border-r" aria-label="Sidebar">
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <Tree />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4" aria-label="Topbar">
          <Link to="/" className="text-sm font-medium hover:text-primary transition-colors">Knowledge Base</Link>
          <div className="flex items-center gap-3">
            {/* Every signed-in user reaches /settings; the left-hand sub-nav
                hides admin-only sections (§7.1), and the settings layout
                redirects non-admins away from admin URLs. The server enforces
                admin access on those APIs regardless. */}
            <Link to="/settings/plugins" className="text-xs text-text-muted hover:text-foreground transition-colors">Settings</Link>
            <NotificationBell />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
