import { createFileRoute, Outlet, Link, useRouterState } from "@tanstack/react-router";
import { useSession } from "@/api/authClient";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

const TABS = [
  { to: "/settings/plugins", label: "Plugins" },
] as const;

function SettingsLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const routerState = useRouterState();

  if (isPending) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (!session) { void navigate({ to: "/login" }); return null; }
  if (!session.user.isAdmin) { void navigate({ to: "/" }); return null; }

  const currentPath = routerState.location.pathname;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <h1 className="text-xl font-semibold mb-4">Settings</h1>
      <nav className="flex gap-1 border-b border-border mb-6">
        {TABS.map(tab => (
          <Link
            key={tab.to}
            to={tab.to}
            className={cn(
              "px-3 py-2 text-sm rounded-t-md border border-b-0 transition-colors",
              currentPath.startsWith(tab.to)
                ? "bg-surface-elevated text-foreground border-border"
                : "text-text-muted hover:text-foreground border-transparent",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
