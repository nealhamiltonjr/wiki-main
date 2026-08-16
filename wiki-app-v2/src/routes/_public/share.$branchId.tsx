import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { request, type PageData } from "@/api/client";
import { ReadOnlyContent } from "@/features/editor/ReadOnlyContent";

export const Route = createFileRoute("/_public/share/$branchId")({
  component: ShareViewerPage,
});

function ShareViewerPage() {
  const { branchId } = Route.useParams();
  const search = Route.useSearch() as { shareToken?: string; sharePassword?: string };
  const navigate = useNavigate();
  const [page, setPage] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");

  useEffect(() => {
    if (!search.shareToken) { setError("Missing share token"); setLoading(false); return; }
    const url = new URL(`/api/branches/${branchId}/page`, window.location.origin);
    url.searchParams.set("shareToken", search.shareToken);
    if (search.sharePassword) url.searchParams.set("sharePassword", search.sharePassword);
    request<PageData>(url.pathname + url.search)
      .then((p) => { setPage(p); setLoading(false); })
      .catch((err) => {
        if (err.status === 401) { setNeedsPassword(true); setLoading(false); }
        else if (err.status === 404) { setError("This share link no longer exists or has been revoked."); setLoading(false); }
        else { setError(err.message ?? "Failed to load shared page"); setLoading(false); }
      });
  }, [branchId, search.shareToken, search.sharePassword]);

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault(); if (!passwordInput) return;
    void navigate({ to: "/share/$branchId", params: { branchId }, search: { shareToken: search.shareToken, sharePassword: passwordInput } });
    setPasswordInput("");
  };

  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-sm text-text-muted">Loading shared page…</p></div>;
  if (error) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6"><h1 className="text-xl font-semibold">Share link unavailable</h1><p className="text-sm text-text-muted">{error}</p><Link to="/login" className="text-sm text-primary underline">Sign in</Link></div>;
  if (needsPassword) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6"><h1 className="text-xl font-semibold">Password required</h1><p className="text-sm text-text-muted">This share link is protected by a password.</p><form onSubmit={submitPassword} className="flex flex-col gap-2 w-full max-w-xs"><input type="password" placeholder="Enter password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" autoFocus aria-label="Share link password" /><button type="submit" className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90">Unlock</button></form></div>;
  if (!page) return null;
  return <div className="min-h-screen bg-background"><header className="flex items-center justify-between border-b px-6 py-3"><span className="font-semibold">Knowledge Base · Shared</span><Link to="/login" className="text-xs text-text-muted hover:text-foreground">Sign in</Link></header><main className="mx-auto max-w-3xl px-6 py-8"><h1 className="mb-6 text-2xl font-semibold">{page.title || page.slug}</h1><ReadOnlyContent content={page.content} /></main></div>;
}
