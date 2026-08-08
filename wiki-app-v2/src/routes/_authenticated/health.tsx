import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";

// Skeleton health check: proves the client shell mounts and renders. Slice 2
// wires this to the real Fastify /api/health endpoint and shows server state.
export const Route = createFileRoute("/_authenticated/health")({
  component: HealthPage,
});

function HealthPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Health</h1>
      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Client</span>
          <Badge variant="outline">ok</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Server</span>
          <Badge variant="outline">pending — slice 2</Badge>
        </div>
      </div>
    </div>
  );
}
