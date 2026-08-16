import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { request } from "@/api/client";
import { ReadOnlyContent } from "@/features/editor/ReadOnlyContent";

export const Route = createFileRoute("/_public/p/$branchId")({
  component: PublicPageViewer,
});

interface PublicPage {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  content: unknown;
  pageType: string;
  language: string | null;
  spaceId: string;
  spaceName: string;
  updatedAt: string;
}

function PublicPageViewer() {
  const { branchId } = Route.useParams();
  const [page, setPage] = useState<PublicPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    request<PublicPage>(`/api/public/pages/${branchId}`)
      .then((p) => { setPage(p); setLoading(false); })
      .catch((err) => {
        setError(err.status === 404 ? "This page is not publicly available." : "Failed to load page.");
        setLoading(false);
      });
  }, [branchId]);

  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-sm text-text-muted">Loading…</p></div>;
  if (error) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Not available</h1>
      <p className="text-sm text-text-muted">{error}</p>
      <Link to="/login" className="text-sm text-primary underline">Sign in</Link>
    </div>
  );
  if (!page) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">Knowledge Base · Public</span>
        <Link to="/login" className="text-xs text-text-muted hover:text-foreground">Sign in</Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <p className="mb-1 text-xs text-text-muted">{page.spaceName}</p>
        <h1 className="mb-6 text-2xl font-semibold">{page.title || page.slug}</h1>
        <ReadOnlyContent content={page.content} />
        {page.updatedAt && (
          <p className="mt-8 border-t border-border pt-4 text-xs text-text-muted">
            Last updated {new Date(page.updatedAt).toLocaleDateString()}
          </p>
        )}
      </main>
    </div>
  );
}
