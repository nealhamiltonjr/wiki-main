import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type LensSummary } from "../../../api/client";

/**
 * Saved-views landing page. Lists every lens the caller can read
 * (their own + public) with a "Run" link into the lens detail view.
 *
 * Creation / editing UI is intentionally a follow-up; the data
 * model and APIs are already in place (slice-24). For now the
 * page is read-only — admins can still wire lenses in via the
 * `/api/lenses` REST surface.
 */
export const Route = createFileRoute("/_authenticated/lenses/")({
  component: LensesPage,
});

function LensesPage() {
  const [lenses, setLenses] = useState<LensSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listLenses()
      .then((rows) => { if (alive) setLenses(rows); })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, []);

  if (err) return <div className="p-6 text-sm text-danger">{err}</div>;
  if (!lenses) return <div className="p-6 text-sm text-text-muted">Loading lenses…</div>;

  if (lenses.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Saved views</h1>
        <p className="mt-2 text-sm text-text-muted">
          No saved lenses yet. Lenses are user-defined cross-cutting views over
          the page tree — backed by tags, promoted attributes, and templates.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Saved views</h1>
      <p className="mt-1 text-sm text-text-muted">
        Cross-cutting views over your pages. Click any lens to run it.
      </p>
      <ul className="mt-4 divide-y rounded border">
        {lenses.map((l) => (
          <li key={l.id} className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <Link
                to="/lenses/$lensId"
                params={{ lensId: l.id }}
                className="font-medium hover:underline"
              >
                {l.name}
              </Link>
              {l.description && (
                <p className="text-sm text-text-muted">{l.description}</p>
              )}
            </div>
            <span className="text-xs text-text-muted">{l.visibility}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}