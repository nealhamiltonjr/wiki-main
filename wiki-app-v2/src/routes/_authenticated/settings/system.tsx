import { useEffect, useState, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request } from "@/api/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/system")({
  component: SystemSettingsPage,
});

interface SystemInfo {
  storage: { dbPath: string; gitRepoRoot: string; pluginRoot: string };
  runtime: { node: string; platform: string; pid: number; uptimeSec: number };
  integrations: { privateClipHostsAllowed: boolean };
}

interface SystemHealth {
  generatedAt: string;
  degraded: boolean;
  errors: { recent: { id: string; source: string; message: string; meta: unknown; createdAt: string }[]; note?: string };
  git: { lastFlushAt: string | null; note?: string };
  queue: { pending: number; failed: number; oldestPendingAgeSec: number | null; note?: string };
  database: { path: string; sizeBytes: number | null; journalMode: string | null; pageCount: number | null; note?: string };
  plugins: { failing: { id: string; name: string; failureCount: number; lastError: string | null; autoDisabled: boolean }[]; note?: string };
  runtime: { uptimeSec: number; node: string; pid: number };
}

interface SystemLogEntry {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  meta: unknown;
  createdAt: string;
}

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function SystemSettingsPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState("");
  const [healthError, setHealthError] = useState("");
  const [healthLoading, setHealthLoading] = useState(false);
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);

  const loadLogs = useCallback(async () => {
    try {
      const rows = await request<SystemLogEntry[]>("/api/settings/system-logs");
      setLogs(rows);
    } catch {
      setLogs([]);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const h = await request<SystemHealth>("/api/settings/system-health");
      setHealth(h);
      setHealthError("");
    } catch {
      setHealthError("Failed to load system health");
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    request<SystemInfo>("/api/settings/system-info")
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setError("Failed to load system info"); });
    loadHealth();
    loadLogs();
    return () => { cancelled = true; };
  }, [loadHealth, loadLogs]);

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
        <p className="text-sm text-text-muted">
          Read-only diagnostics — storage paths, runtime, environment. The Health panel pulls live error/git/queue/plugin stats.
        </p>
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

      {/* §11.4 — live ops panel. Refresh button so an admin
          investigating a live issue can re-poll without a full
          page reload. Auto-refresh on mount only; we deliberately
          don't tick on a timer here (the page is admin-only and
          an open tab idling with timers is its own footgun). */}
      <section className="space-y-4 border-t border-border pt-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-secondary">Health</h3>
            <p className="text-xs text-text-muted">
              Recent errors, last git flush, collab queue, DB, plugin failures.
            </p>
          </div>
          <button
            type="button"
            onClick={loadHealth}
            disabled={healthLoading}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-bg-muted disabled:opacity-50"
          >
            {healthLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {healthError && <p className="text-sm text-danger">{healthError}</p>}
        {health && (
          <>
            {health.degraded && (
              <p className="text-xs text-warning border-l-2 border-warning pl-2">
                Health snapshot is partial — some sections failed to load. See notes inline.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="border border-border rounded p-3 space-y-1">
                <div className="text-text-muted text-xs uppercase tracking-wide">Last git flush</div>
                <div className="text-text-secondary">
                  {health.git.lastFlushAt ? formatAgo(health.git.lastFlushAt) : "never recorded"}
                </div>
                {health.git.note && (
                  <p className="text-xs text-warning mt-1">{health.git.note}</p>
                )}
              </div>

              <div className="border border-border rounded p-3 space-y-1">
                <div className="text-text-muted text-xs uppercase tracking-wide">Collab queue</div>
                <div className="text-text-secondary">
                  {health.queue.pending} pending · {health.queue.failed} failed
                </div>
                <div className="text-xs text-text-muted">
                  oldest pending:{" "}
                  {health.queue.oldestPendingAgeSec == null
                    ? "—"
                    : formatAgo(new Date(Date.now() - health.queue.oldestPendingAgeSec * 1000).toISOString())}
                </div>
                {health.queue.note && (
                  <p className="text-xs text-warning mt-1">{health.queue.note}</p>
                )}
              </div>

              <div className="border border-border rounded p-3 space-y-1">
                <div className="text-text-muted text-xs uppercase tracking-wide">Database</div>
                <div className="text-text-secondary font-mono text-xs">
                  {health.database.path}
                </div>
                <div className="text-xs text-text-muted">
                  {formatBytes(health.database.sizeBytes)} · {health.database.journalMode ?? "—"}
                  {" · "}
                  {health.database.pageCount ?? "?"} tables
                </div>
                {health.database.note && (
                  <p className="text-xs text-warning mt-1">{health.database.note}</p>
                )}
              </div>

              <div className="border border-border rounded p-3 space-y-1">
                <div className="text-text-muted text-xs uppercase tracking-wide">Recent errors</div>
                <div className="text-text-secondary">{health.errors.recent.length} recorded</div>
                {health.errors.note && (
                  <p className="text-xs text-warning mt-1">{health.errors.note}</p>
                )}
              </div>
            </div>

            {health.errors.recent.length > 0 && (
              <div className="space-y-2">
                <div className="text-text-muted text-xs uppercase tracking-wide">Last 20 errors</div>
                <ul className="space-y-1 text-xs font-mono">
                  {health.errors.recent.map((e) => (
                    <li key={e.id} className="border-l-2 border-danger pl-2">
                      <div className="text-text-secondary">{formatAgo(e.createdAt)} · {e.source}</div>
                      <div className="text-danger break-words">{e.message}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {health.plugins.failing.length > 0 && (
              <div className="space-y-2">
                <div className="text-text-muted text-xs uppercase tracking-wide">Plugins in failure</div>
                <ul className="space-y-1 text-xs">
                  {health.plugins.failing.map((p) => (
                    <li key={p.id} className="border-l-2 border-warning pl-2">
                      <div className="text-text-secondary">
                        {p.name}{" "}
                        {p.autoDisabled && <span className="text-warning">(auto-disabled)</span>}
                        {" — "}
                        {p.failureCount} failures
                      </div>
                      {p.lastError && (
                        <div className="text-danger break-words font-mono">{p.lastError}</div>
                      )}
                    </li>
                  ))}
                </ul>
                {health.plugins.note && (
                  <p className="text-xs text-warning mt-1">{health.plugins.note}</p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Slice 28 — full system log stream. Kept separate from Health so the
          "last 20 errors" aggregate stays compact while an operator can still
          page through recent debug/info/warn rows. */}
      <section className="space-y-3 border-t border-border pt-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-secondary">Logs</h3>
            <p className="text-xs text-text-muted">Recent system events across all levels.</p>
          </div>
          <button
            type="button"
            onClick={loadLogs}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-bg-muted"
          >
            Refresh
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="text-xs text-text-muted">No system log entries recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-xs font-mono">
            {logs.map((l) => (
              <li key={l.id} className="border-l-2 border-border pl-2">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "uppercase tracking-wide",
                    l.level === "error" && "text-danger",
                    l.level === "warn" && "text-warning",
                    l.level === "info" && "text-link",
                    l.level === "debug" && "text-text-muted",
                  )}>{l.level}</span>
                  <span className="text-text-muted">{formatAgo(l.createdAt)}</span>
                  <span className="text-text-secondary">{l.source}</span>
                </div>
                <div className="text-text-secondary break-words">{l.message}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
