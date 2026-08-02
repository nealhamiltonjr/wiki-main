import { useEffect, useState, useCallback } from "react";
import { api, type RepoStatus, type RepoLogEntry } from "../../api/client.js";

/**
 * The Git section (§7.10c): repo status dashboard, remote config (via the
 * settings registry rows for git_remote_*), test-connection, and the
 * admin-only push/pull controls. Every destructive action requires a confirm
 * and is queued as a background job.
 */
export function GitSection() {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [log, setLog] = useState<RepoLogEntry[]>([]);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, l] = await Promise.all([api.getRepoStatus(), api.getRepoLog(15)]);
      setStatus(s);
      setLog(l);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repo status");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(fn: () => Promise<unknown>, confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Give the queue a moment to pick the job up, then refresh status.
      setTimeout(refresh, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function testConn() {
    setBusy(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await api.testGitRemote();
      setTestResult(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  const fmtBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleString() : "—");

  return (
    <section className="settings-card">
      <h3>Git — content repository</h3>
      {error && <div className="wiki-banner">{error}</div>}

      <div className="git-status-grid">
        <div className="git-stat"><span className="git-stat-label">Branch</span><strong>{status?.branch ?? "…"}</strong></div>
        <div className="git-stat"><span className="git-stat-label">HEAD</span><strong className="git-hash">{status?.headHash ? status.headHash.slice(0, 10) : "—"}</strong></div>
        <div className="git-stat"><span className="git-stat-label">Dirty files</span><strong>{status?.dirty ?? "…"}</strong></div>
        <div className="git-stat"><span className="git-stat-label">Ahead / behind</span><strong>{status?.ahead ?? 0} / {status?.behind ?? 0}</strong></div>
        <div className="git-stat"><span className="git-stat-label">Last commit</span><strong>{fmtDate(status?.lastCommit ?? null)}</strong></div>
        <div className="git-stat"><span className="git-stat-label">Repo size</span><strong>{status ? fmtBytes(status.sizeBytes) : "…"}</strong></div>
        <div className="git-stat"><span className="git-stat-label">Remote</span><strong className="git-hash">{status?.remoteUrl ?? "not configured"}</strong></div>
        <div className="git-stat"><span className="git-stat-label">Remote branch</span><strong>{status?.remoteBranch ?? "main"}</strong></div>
      </div>
      {status?.headMessage && <p className="hint">HEAD: {status.headMessage}</p>}

      <div className="settings-row">
        <span className="label">Test connection</span>
        <button className="settings-btn" onClick={testConn} disabled={busy}>Test remote</button>
        {testResult && <span className="hint">{testResult}</span>}
      </div>

      <div className="settings-row">
        <span className="label">Push to remote</span>
        <button
          className="settings-btn primary"
          disabled={busy || !status?.remoteUrl}
          onClick={() => run(() => api.gitPush(), "Push the content repository to the configured remote?")}
        >
          Push now
        </button>
        <span className="hint">Runs as a background job; status refreshes when it completes.</span>
      </div>

      <div className="settings-row">
        <span className="label">Pull from remote</span>
        <button
          className="settings-btn"
          disabled={busy || !status?.remoteUrl}
          onClick={() => run(() => api.gitPull(), "Pull remote content and import it into the database (last-write-wins with a backup commit)?")}
        >
          Pull &amp; import
        </button>
        <span className="hint">Fetches the remote into a shadow checkout, then imports pages into the DB.</span>
      </div>

      <h4 style={{ margin: "16px 0 8px" }}>Recent commits</h4>
      <table className="git-log-table">
        <thead>
          <tr><th>Date</th><th>Message</th><th>Author</th></tr>
        </thead>
        <tbody>
          {log.map((e) => (
            <tr key={e.hash}>
              <td className="git-hash">{fmtDate(e.date)}</td>
              <td>{e.message}</td>
              <td>{e.author}</td>
            </tr>
          ))}
          {log.length === 0 && <tr><td colSpan={3} className="hint">No commits yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
