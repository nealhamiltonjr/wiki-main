import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Knowledge Base</h1>
      <p className="mt-2 text-muted-foreground">
        Skeleton slice 1 — the authenticated shell renders. The space tree and
        editor land in slices 4–5.
      </p>
    </div>
  );
}
