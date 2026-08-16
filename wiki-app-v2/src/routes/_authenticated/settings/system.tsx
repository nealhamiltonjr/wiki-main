import { useEffect, useState, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request, api } from "@/api/client";
import type { GitStatus, GitLogEntry, GitSnapshotStatus, AuditLogEntry } from "@/api/client";
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

  // Phase 1.4 — Git repo health state.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLog, setGitLog] = useState<GitLogEntry[]>([]);
  const [snapshotStatus, setSnapshotStatus] = useState<GitSnapshotStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitActionLoading, setGitActionLoading] = useState<string | null>(null);

  const loadGit = useCallback(async () => {
    setGitLoading(true);
    try {
      const [status, log, snap] = await Promise.all([api.getGitStatus(), api.getGitLog(15), api.getGitSnapshotStatus()]);
      setGitStatus(status); setGitLog(log); setSnapshotStatus(snap); setGitError("");
    } catch { setGitError("Failed to load git status (admin only)"); }
    finally { setGitLoading(false); }
  }, []);

  const runGitAction = useCallback(async (action: "gc" | "push" | "pull" | "snapshot") => {
    setGitActionLoading(action);
    try {
      if (action === "gc") await api.runGitGc();
      else if (action === "push") await api.gitPush();
      else if (action === "pull") await api.gitPull();
      else if (action === "snapshot") await api.createGitSnapshot(`Manual snapshot at ${new Date().toISOString()}`);
      await loadGit();
    } catch (err) { setGitError(err instanceof Error ? err.message : `Git ${action} failed`); }
    finally { setGitActionLoading(null); }
  }, [loadGit]);

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
    loadGit();
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

      <GitSection gitStatus={gitStatus} gitLog={gitLog} snapshotStatus={snapshotStatus} gitLoading={gitLoading} gitError={gitError} gitActionLoading={gitActionLoading} loadGit={loadGit} runGitAction={runGitAction} />
      <AuditLogSection />
    </div>
  );
}

function GitSection({ gitStatus, gitLog, snapshotStatus, gitLoading, gitError, gitActionLoading, loadGit, runGitAction }: {
  gitStatus: GitStatus | null; gitLog: GitLogEntry[]; snapshotStatus: GitSnapshotStatus | null;
  gitLoading: boolean; gitError: string; gitActionLoading: string | null;
  loadGit: () => void; runGitAction: (a: "gc"|"push"|"pull"|"snapshot") => void;
}) {
  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div className="flex items-baseline justify-between">
        <div><h3 className="text-sm font-medium text-text-secondary">Git repository</h3><p className="text-xs text-text-muted">Content store status, recent commits, and admin actions.</p></div>
        <button type="button" onClick={loadGit} disabled={gitLoading} className="text-xs px-2 py-1 border border-border rounded hover:bg-bg-muted disabled:opacity-50">{gitLoading ? "Refreshing…" : "Refresh"}</button>
      </div>
      {gitError && <p className="text-sm text-danger">{gitError}</p>}
      {gitStatus && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="border border-border rounded p-3 space-y-1"><div className="text-text-muted text-xs uppercase tracking-wide">Branch</div><div className="text-text-secondary font-mono text-xs">{gitStatus.branch}</div><div className="text-text-muted text-xs">HEAD: {gitStatus.headHash.slice(0, 8)}</div></div>
          <div className="border border-border rounded p-3 space-y-1"><div className="text-text-muted text-xs uppercase tracking-wide">Working tree</div><div className="text-text-secondary">{gitStatus.dirty === 0 ? <span className="text-success">clean</span> : <span className="text-warning">{gitStatus.dirty} uncommitted</span>}</div></div>
          <div className="border border-border rounded p-3 space-y-1"><div className="text-text-muted text-xs uppercase tracking-wide">Remote</div><div className="text-text-secondary font-mono text-xs break-all">{gitStatus.remote.url || "(none)"}</div></div>
          <div className="border border-border rounded p-3 space-y-1"><div className="text-text-muted text-xs uppercase tracking-wide">Last sync</div><div className="text-text-secondary text-xs">push: {gitStatus.lastPushAt ? formatAgo(gitStatus.lastPushAt) : "never"}</div><div className="text-text-secondary text-xs">pull: {gitStatus.lastPullAt ? formatAgo(gitStatus.lastPullAt) : "never"}</div></div>
        </div>
      )}
      {snapshotStatus && (
        <div className="border border-border rounded p-3 space-y-1 text-sm"><div className="text-text-muted text-xs uppercase tracking-wide">Snapshots</div><div className="text-text-secondary text-xs">{snapshotStatus.lastSnapshotAt ? `Last: ${formatAgo(snapshotStatus.lastSnapshotAt)}` : "No snapshots yet"} · {snapshotStatus.enabled ? `auto every ${snapshotStatus.intervalHours}h` : "auto disabled"}</div></div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => runGitAction("snapshot")} disabled={gitActionLoading !== null} className="text-xs px-3 py-1.5 border border-border rounded hover:bg-bg-muted disabled:opacity-50">{gitActionLoading === "snapshot" ? "Creating…" : "New snapshot"}</button>
        <button type="button" onClick={() => runGitAction("push")} disabled={gitActionLoading !== null || !gitStatus?.remote.url} className="text-xs px-3 py-1.5 border border-border rounded hover:bg-bg-muted disabled:opacity-50">{gitActionLoading === "push" ? "Pushing…" : "Push"}</button>
        <button type="button" onClick={() => runGitAction("pull")} disabled={gitActionLoading !== null || !gitStatus?.remote.url} className="text-xs px-3 py-1.5 border border-border rounded hover:bg-bg-muted disabled:opacity-50">{gitActionLoading === "pull" ? "Pulling…" : "Pull"}</button>
        <button type="button" onClick={() => runGitAction("gc")} disabled={gitActionLoading !== null} className="text-xs px-3 py-1.5 border border-border rounded hover:bg-bg-muted disabled:opacity-50">{gitActionLoading === "gc" ? "Running…" : "Run gc"}</button>
      </div>
      {gitLog.length > 0 && (
        <div className="space-y-2"><div className="text-text-muted text-xs uppercase tracking-wide">Recent commits</div><ul className="space-y-1 text-xs font-mono">{gitLog.map((c) => <li key={c.hash} className="border-l-2 border-border pl-2"><div className="flex items-center gap-2"><span className="text-text-muted">{c.hash.slice(0, 8)}</span><span className="text-text-muted">{formatAgo(c.date)}</span><span className="text-text-secondary">{c.author}</span></div><div className="text-text-secondary break-words">{c.message}</div></li>)}</ul></div>
      )}
    </section>
  );
}

function AuditLogSection() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const rows = await api.getAuditLog(100); setEntries(rows); setError(""); } catch { setError("Failed to load audit log"); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="space-y-3 border-t border-border pt-6">
      <div className="flex items-baseline justify-between">
        <div><h3 className="text-sm font-medium text-text-secondary">Audit log</h3><p className="text-xs text-text-muted">Security-critical admin actions.</p></div>
        <button type="button" onClick={load} disabled={loading} className="text-xs px-2 py-1 border border-border rounded hover:bg-bg-muted disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {entries.length === 0 ? <p className="text-xs text-text-muted">No audit entries recorded yet.</p> : (
        <ul className="space-y-1 text-xs font-mono">{entries.map((e) => <li key={e.id} className="border-l-2 border-border pl-2"><div className="flex items-center gap-2 flex-wrap"><span className="text-text-secondary font-semibold">{e.action}</span>{e.targetType && <span className="text-text-muted">{e.targetType}{e.targetId ? `:${e.targetId.slice(0, 8)}` : ""}</span>}<span className="text-text-muted">{formatAgo(e.createdAt)}</span><span className="text-text-muted">by {e.actorName ?? e.actorEmail ?? e.actorUserId ?? "system"}</span></div>{e.meta != null && <div className="text-text-muted break-words">{JSON.stringify(e.meta)}</div>}</li>)}</ul>
      )}
    </section>
  );
}
