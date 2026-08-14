import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api, type LensDetail, type LensHit } from "../../../api/client";
import { TableView } from "../../../features/lenses/TableView";
import { BoardView } from "../../../features/lenses/BoardView";
import { deriveColumns } from "../../../features/lenses/lensView.helpers";

type ViewMode = "list" | "table" | "board";

/**
 * Lens detail / run view. Loads the lens + runs it with promoted
 * attributes (own + inherited via §13.3) and lets the user switch
 * between List, Table, and Board presentations.
 *
 * List mode shows the hits as a simple ordered list — useful when
 * the result set is small or the user hasn't set up promoted
 * attributes yet. Table and Board are §13.4's headline views.
 */
export const Route = createFileRoute("/_authenticated/lenses/$lensId")({
  component: LensDetailPage,
});

function LensDetailPage() {
  const { lensId } = Route.useParams();
  const [lens, setLens] = useState<LensDetail | null>(null);
  const [hits, setHits] = useState<LensHit[] | null>(null);
  const [view, setView] = useState<ViewMode>("table");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLens(null); setHits(null); setErr(null);
    Promise.all([api.getLens(lensId), api.runLens(lensId, { includeAttributes: true })])
      .then(([lensRow, { hits: hitRows }]) => {
        if (!alive) return;
        setLens(lensRow);
        setHits(hitRows);
        // Default the groupBy selector to the first promoted column.
        const cols = deriveColumns(hitRows);
        if (cols.length > 0 && cols[0]) setGroupBy(cols[0]);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [lensId]);

  const columns = useMemo(() => (hits ? deriveColumns(hits) : []), [hits]);

  const onSort = (col: string) => {
    if (sortColumn === col) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDirection("asc");
    }
  };

  if (err) return <div className="p-6 text-sm text-danger">{err}</div>;
  if (!lens || !hits) return <div className="p-6 text-sm text-text-muted">Loading lens…</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0">
          <Link to="/lenses" className="text-xs text-text-muted hover:underline">
            ← Saved views
          </Link>
          <h1 className="truncate text-lg font-semibold">{lens.name}</h1>
          {lens.description && (
            <p className="text-sm text-text-muted">{lens.description}</p>
          )}
        </div>
        <ViewSwitcher value={view} onChange={setView} />
      </div>

      {columns.length > 0 && view !== "list" && (
        <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-2 text-sm">
          {view === "board" && (
            <label className="flex items-center gap-2">
              <span className="text-text-muted">Group by:</span>
              <select
                className="rounded border bg-background px-2 py-1"
                value={groupBy ?? ""}
                onChange={(e) => setGroupBy(e.target.value || null)}
                data-testid="groupby-select"
              >
                {columns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <span className="text-xs text-text-muted">
            {hits.length} page{hits.length === 1 ? "" : "s"} · {columns.length} column{columns.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {view === "list" && (
          <ListView hits={hits} />
        )}
        {view === "table" && (
          <TableView
            hits={hits}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={onSort}
            renderPageLink={(hit, children) => (
              <Link to="/w/$branchId" params={{ branchId: hit.branchId }}>
                {children}
              </Link>
            )}
          />
        )}
        {view === "board" && groupBy && (
          <BoardView
            hits={hits}
            groupBy={groupBy}
            renderPageLink={(hit, children) => (
              <Link to="/w/$branchId" params={{ branchId: hit.branchId }}>
                {children}
              </Link>
            )}
          />
        )}
      </div>
    </div>
  );
}

interface ViewSwitcherProps {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}

function ViewSwitcher({ value, onChange }: ViewSwitcherProps) {
  const opts: Array<{ v: ViewMode; label: string }> = [
    { v: "list", label: "List" },
    { v: "table", label: "Table" },
    { v: "board", label: "Board" },
  ];
  return (
    <div className="flex rounded border" data-testid="view-switcher">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={
            "px-3 py-1 text-sm " +
            (value === o.v
              ? "bg-primary text-primary-foreground"
              : "bg-background hover:bg-muted")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ListView({ hits }: { hits: LensHit[] }) {
  if (hits.length === 0) {
    return <div className="p-6 text-sm text-text-muted">No pages match this lens.</div>;
  }
  return (
    <ul className="divide-y">
      {hits.map((hit) => (
        <li key={hit.pageId} className="px-4 py-2">
          <Link to="/w/$branchId" params={{ branchId: hit.branchId }} className="font-medium hover:underline">
            {hit.title}
          </Link>
          <span className="ml-2 text-xs text-text-muted">{hit.spaceName}</span>
        </li>
      ))}
    </ul>
  );
}