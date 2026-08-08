import { useState } from "react";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";

import { useSession } from "@/api/authClient";
import { Tree } from "@/features/tree/Tree";

// Pathless authenticated layout: the single chrome shell (sidebar + topbar)
// that wraps every page a signed-in user can reach. The session gate redirects
// unauthenticated visitors to /login; the sidebar hosts the react-arborist
// space tree (slice 4) and the topbar holds the space switcher + account.
export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);

  if (isPending) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (!session) {
    void navigate({ to: "/login" });
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col border-r" aria-label="Sidebar">
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <Tree onSelectBranch={(branchId) => setSelectedBranchId(branchId)} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b px-4" aria-label="Topbar">
          {selectedBranchId && (
            <span className="text-sm text-muted-foreground">
              Selected branch: <span className="font-mono">{selectedBranchId}</span>
            </span>
          )}
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
