import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pathless public layout: unauthenticated surface (login and anything else
// reachable without a session). Empty shell for slice 1; slice 2 wires the
// real session gate here.
export const Route = createFileRoute("/_public")({
  component: PublicLayout,
});

function PublicLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">Knowledge Base</span>
      </header>
      <main className="flex flex-1 items-center justify-center">
        <Outlet />
      </main>
    </div>
  );
}
