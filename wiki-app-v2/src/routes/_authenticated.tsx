import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pathless authenticated layout: the single chrome shell (sidebar + topbar)
// that wraps every page a signed-in user can reach. Slice 1 ships the empty
// shell; slice 4 fills the sidebar with the react-arborist tree.
export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-64 shrink-0 border-r" aria-label="Sidebar" />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b px-4" aria-label="Topbar" />
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
