import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { request, type SpaceSummary } from "@/api/client";

export const Route = createFileRoute("/_authenticated/settings/maintenance")({
  component: MaintenanceSettingsPage,
});

interface OrphanedPage {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  updatedAt: string;
}
interface BrokenRedirect {
  spaceId: string;
  oldSlug: string;
  pageId: string;
  reason: "deleted" | "missing";
  currentSlug: string;
  title: string;
}
interface BrokenWikilink {
  sourcePageId: string;
  sourceBranchId: string;
  sourceSlug: string;
  sourceTitle: string;
  targetBranchId: string;
  targetBlockId: string | null;
}
interface SimilarPagePair {
  a: { pageId: string; branchId: string; slug: string; title: string };
  b: { pageId: string; branchId: string; slug: string; title: string };
  score: number;
}
interface MaintenanceReport {
  generatedAt: string;
  orphanedPages: OrphanedPage[];
  brokenRedirects: BrokenRedirect[];
  brokenWikilinks: BrokenWikilink[];
  similarPages: SimilarPagePair[];
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border">
      <h3 className="border-b border-border px-4 py-2 text-sm font-medium">
        {title} <span className="text-text-muted">({count})</span>
      </h3>
      <div className="divide-y divide-border">
        {count === 0 ? (
          <p className="px-4 py-3 text-sm text-text-muted">Nothing to clean up.</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function PageLink({ branchId, label }: { branchId: string; label: string }) {
  if (!branchId) return <span>{label}</span>;
  return (
    <Link to="/w/$branchId" params={{ branchId }} className="font-medium hover:underline">
      {label}
    </Link>
  );
}

function MaintenanceSettingsPage() {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadSpaces = useCallback(async () => {
    try {
      setSpaces(await request<SpaceSummary[]>("/api/spaces"));
    } catch {
      setError("Failed to load spaces.");
    }
  }, []);

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  const loadReport = useCallback(async (id: string) => {
    if (!id) {
      setReport(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setReport(await request<MaintenanceReport>(`/api/spaces/${id}/maintenance`));
    } catch (err) {
      setError((err as Error).message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h2 className="text-lg font-medium">Maintenance</h2>
        <p className="text-sm text-text-muted">
          Orphaned pages, broken wikilinks, stale redirects, and near-duplicate pages — detected from
          the existing backlinks index and rendered plain text. No AI or external services.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="maintenance-space" className="text-sm text-text-secondary">
          Space
        </label>
        <select
          id="maintenance-space"
          value={spaceId}
          onChange={(e) => {
            setSpaceId(e.target.value);
            void loadReport(e.target.value);
          }}
          className="h-8 min-w-48 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a space…</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}
      {loading && <p className="text-sm text-text-muted">Building report…</p>}

      {report && !loading && (
        <>
          <p className="text-xs text-text-muted">
            Generated {new Date(report.generatedAt).toLocaleString()}
          </p>

          <Section title="Orphaned pages (no backlinks)" count={report.orphanedPages.length}>
            {report.orphanedPages.map((p) => (
              <div key={p.branchId} className="flex items-baseline justify-between px-4 py-2">
                <PageLink branchId={p.branchId} label={p.title || p.slug} />
                <span className="text-xs text-text-muted">/{p.slug}</span>
              </div>
            ))}
          </Section>

          <Section title="Broken wikilinks" count={report.brokenWikilinks.length}>
            {report.brokenWikilinks.map((b) => (
              <div key={`${b.sourcePageId}:${b.targetBranchId}:${b.targetBlockId ?? "*"}`} className="px-4 py-2 text-sm">
                <PageLink branchId={b.sourceBranchId} label={b.sourceTitle || b.sourceSlug} />{" "}
                <span className="text-text-muted">
                  → missing target {b.targetBranchId}
                  {b.targetBlockId ? ` #${b.targetBlockId}` : ""}
                </span>
              </div>
            ))}
          </Section>

          <Section title="Stale redirects" count={report.brokenRedirects.length}>
            {report.brokenRedirects.map((r) => (
              <div key={`${r.spaceId}:${r.oldSlug}`} className="px-4 py-2 text-sm">
                <span className="font-mono">/{r.oldSlug}</span>{" "}
                <span className="text-text-muted">
                  → {r.title || r.currentSlug} ({r.reason})
                </span>
              </div>
            ))}
          </Section>

          <Section title="Near-duplicate pages" count={report.similarPages.length}>
            {report.similarPages.map((p) => (
              <div
                key={`${p.a.pageId}:${p.b.pageId}`}
                className="flex items-baseline justify-between px-4 py-2 text-sm"
              >
                <span>
                  <PageLink branchId={p.a.branchId} label={p.a.title || p.a.slug} />{" "}
                  <span className="text-text-muted">↔</span>{" "}
                  <PageLink branchId={p.b.branchId} label={p.b.title || p.b.slug} />
                </span>
                <span className="text-xs text-text-muted">{Math.round(p.score * 100)}%</span>
              </div>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
