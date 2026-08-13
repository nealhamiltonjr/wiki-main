import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request } from "@/api/client";

export const Route = createFileRoute("/_authenticated/settings/system")({
  component: SystemSettingsPage,
});

interface SystemInfo {
  storage: { dbPath: string; gitRepoRoot: string; pluginRoot: string };
  runtime: { node: string; platform: string; pid: number; uptimeSec: number };
  integrations: { privateClipHostsAllowed: boolean };
}

function SystemSettingsPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    request<SystemInfo>("/api/settings/system-info")
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setError("Failed to load system info"); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="text-sm text-danger">{error}</div>;
  if (!info) return <p className="text-sm text-text-muted">Loading…</p>;

  const uptime = (sec: number) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  };

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h2 className="text-lg font-medium">System</h2>
        <p className="text-sm text-text-muted">Read-only diagnostics — storage paths, runtime, environment.</p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Storage</h3>
        <dl className="space-y-2 text-sm">
          {[
            ["Database", info.storage.dbPath],
            ["Git repository", info.storage.gitRepoRoot],
            ["Plugin root", info.storage.pluginRoot],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-3">
              <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
              <dd className="font-mono text-xs text-text-secondary break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Runtime</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-text-muted">Node</dt>
            <dd className="font-mono text-xs text-text-secondary">{info.runtime.node}</dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-text-muted">Platform</dt>
            <dd className="text-text-secondary">{info.runtime.platform}</dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-text-muted">PID</dt>
            <dd className="font-mono text-xs text-text-secondary">{info.runtime.pid}</dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-text-muted">Uptime</dt>
            <dd className="text-text-secondary">{uptime(info.runtime.uptimeSec)}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Security environment</h3>
        <p className="text-xs text-text-muted">
          Private-host clips allowed: {info.integrations.privateClipHostsAllowed ? "yes (e2e/LAN mode)" : "no (SSRF guard on)"}
        </p>
      </section>
    </div>
  );
}
