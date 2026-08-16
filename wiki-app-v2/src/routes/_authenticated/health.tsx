import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/_authenticated/health")({
  component: HealthPage,
});

function HealthPage() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => {
    fetch("/api/health").then(r => r.json()).then(() => setStatus("ok")).catch(() => setStatus("error"));
  }, []);
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Health</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Server: <span className="font-mono">{status === "loading" ? "checking…" : status === "ok" ? "ok" : "unreachable"}</span>
      </p>
    </div>
  );
}
