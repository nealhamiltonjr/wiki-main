import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings/integrations")({
  component: IntegrationSettingsPage,
});

interface SystemInfo {
  integrations: {
    googleSso: boolean;
    githubSso: boolean;
    authUrl: string;
    privateClipHostsAllowed: boolean;
  };
}

interface GitRemote {
  url: string;
  branch: string;
}

function IntegrationSettingsPage() {
  const [git, setGit] = useState<GitRemote>({ url: "", branch: "main" });
  const [gitLoaded, setGitLoaded] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitSaved, setGitSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [sys, setSys] = useState<SystemInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([
        request<GitRemote>("/api/git/remote"),
        request<SystemInfo>("/api/settings/system-info"),
      ]);
      setGit(g);
      setSys(s);
    } catch {
      setGitError("Failed to load integration settings");
    } finally {
      setGitLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveGit() {
    setSaving(true);
    setGitSaved(false);
    setGitError("");
    try {
      const updated = await request<GitRemote>("/api/git/remote", {
        method: "PUT",
        body: JSON.stringify(git),
      });
      setGit(updated);
      setGitSaved(true);
    } catch (err) {
      setGitError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h2 className="text-lg font-medium">Integrations</h2>
        <p className="text-sm text-text-muted">
          Git remote and SSO provider configuration.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Git remote</h3>
        <p className="text-xs text-text-muted">
          The commit pipeline (slice-10) writes to the local repo; this remote is where manual/automated
          push would send it. Stored in system settings.
        </p>
        {!gitLoaded ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : (
          <>
            <div className="space-y-2">
              <input
                aria-label="Remote URL"
                placeholder="git@github.com:org/wiki.git"
                value={git.url}
                onChange={(e) => setGit({ ...git, url: e.target.value })}
                className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <input
                aria-label="Remote branch"
                placeholder="main"
                value={git.branch}
                onChange={(e) => setGit({ ...git, branch: e.target.value })}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </div>
            <Button size="sm" onClick={() => void saveGit()} disabled={saving}>
              {saving ? "Saving…" : "Save remote"}
            </Button>
            {gitSaved && <p className="text-xs text-success">Saved.</p>}
            {gitError && <p className="text-xs text-danger">{gitError}</p>}
          </>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">SSO providers</h3>
        <p className="text-xs text-text-muted">Configured via environment variables — read-only here.</p>
        {sys ? (
          <dl className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <dt className="w-28 text-text-muted">Google</dt>
              <dd>{sys.integrations.googleSso ? <Badge>enabled</Badge> : <Badge variant="outline">not configured</Badge>}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-28 text-text-muted">GitHub</dt>
              <dd>{sys.integrations.githubSso ? <Badge>enabled</Badge> : <Badge variant="outline">not configured</Badge>}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-28 text-text-muted">Auth URL</dt>
              <dd className="font-mono text-xs text-text-secondary">{sys.integrations.authUrl}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-text-muted">Loading…</p>
        )}
      </section>

      <SmtpSection />
    </div>
  );
}

function SmtpSection() {
  const [smtp, setSmtp] = useState({ host: "", port: 587, user: "", password: "", from: "" });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const rows = await request<Array<{ key: string; value: unknown; isSecret: boolean }>>("/api/settings");
        const get = (k: string) => { const row = rows.find((r) => r.key === k); return row ? String(row.value) : ""; };
        setSmtp({ host: get("smtp.host"), port: Number(get("smtp.port")) || 587, user: get("smtp.user"), password: "", from: get("smtp.from") });
      } catch { setError("Failed to load SMTP settings"); }
      finally { setLoaded(true); }
    })();
  }, []);

  async function save() {
    setSaving(true); setSaved(false); setError("");
    try {
      const puts = [
        request("/api/settings/smtp.host", { method: "PUT", body: JSON.stringify({ value: smtp.host }) }),
        request("/api/settings/smtp.port", { method: "PUT", body: JSON.stringify({ value: smtp.port }) }),
        request("/api/settings/smtp.user", { method: "PUT", body: JSON.stringify({ value: smtp.user }) }),
        request("/api/settings/smtp.from", { method: "PUT", body: JSON.stringify({ value: smtp.from }) }),
      ];
      if (smtp.password) puts.push(request("/api/settings/smtp.password", { method: "PUT", body: JSON.stringify({ value: smtp.password, isSecret: true }) }));
      await Promise.all(puts);
      setSaved(true); setSmtp({ ...smtp, password: "" });
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-text-secondary">Email (SMTP)</h3>
      <p className="text-xs text-text-muted">Optional. When configured, sends signup confirmations, share-link warnings, and mention notifications. Password is encrypted at rest.</p>
      {!loaded ? <p className="text-sm text-text-muted">Loading…</p> : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="SMTP host" placeholder="smtp.gmail.com" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} className="h-9 rounded-md border border-border bg-background px-3 text-sm" />
            <input aria-label="SMTP port" type="number" placeholder="587" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) || 587 })} className="h-9 rounded-md border border-border bg-background px-3 text-sm" />
          </div>
          <input aria-label="SMTP username" placeholder="user@example.com" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm" />
          <input aria-label="SMTP password" type="password" placeholder="••••••••" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm" />
          <input aria-label="From address" placeholder="Wiki <wiki@example.com>" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm" />
          <Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save SMTP settings"}</Button>
          {saved && <p className="text-xs text-success">Saved.</p>}
          {error && <p className="text-xs text-danger">{error}</p>}
        </>
      )}
    </section>
  );
}
