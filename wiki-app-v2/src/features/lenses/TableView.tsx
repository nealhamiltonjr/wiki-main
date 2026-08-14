import type { ReactNode } from "react";
import type { LensHit } from "../../api/client.js";
import { deriveColumns, findAttr, sortHits } from "./lensView.helpers.js";

/**
 * Sortable table view over a lens result.
 *
 * Pure presentational: receives the hits, the active sort, and a
 * callback to change sort. The parent owns the state because it
 * also owns the table/board toggle.
 *
 * The page-link cell wraps the title in a clickable element when
 * `renderPageLink` is provided; otherwise it falls back to a plain
 * span so the component can be unit-tested without a router.
 */
export interface TableViewProps {
  hits: LensHit[];
  sortColumn: string | null;
  sortDirection: "asc" | "desc";
  onSort: (column: string) => void;
  renderPageLink?: (hit: LensHit, children: ReactNode) => ReactNode;
}

export function TableView({
  hits,
  sortColumn,
  sortDirection,
  onSort,
  renderPageLink,
}: TableViewProps) {
  const columns = deriveColumns(hits);
  const rows = sortHits(hits, sortColumn, sortDirection);

  if (rows.length === 0) {
    return <div className="p-6 text-sm text-text-muted">No pages match this lens.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm" data-testid="lens-table">
        <thead>
          <tr className="border-b">
            <th scope="col" className="px-3 py-2 text-left font-medium">Title</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Space</th>
            {columns.map((c) => (
              <SortableHeader
                key={c}
                column={c}
                active={sortColumn === c}
                direction={sortDirection}
                onClick={() => onSort(c)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((hit) => (
            <tr key={hit.pageId} className="border-b">
              <td className="px-3 py-2">
                {renderPageLink
                  ? renderPageLink(hit, <span>{hit.title}</span>)
                  : <span>{hit.title}</span>}
                {hit.isTrashed && (
                  <span className="ml-2 rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted">
                    trashed
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-text-muted">{hit.spaceName}</td>
              {columns.map((c) => {
                const a = findAttr(hit, c);
                return (
                  <td key={c} className="px-3 py-2">
                    {a ? (
                      <span title={a.fromTitle ?? ""}>
                        {a.value}
                        {!a.own && a.fromTitle && (
                          <span className="ml-1 text-xs text-text-muted">
                            ↑{a.fromTitle}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface SortableHeaderProps {
  column: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
}

function SortableHeader({ column, active, direction, onClick }: SortableHeaderProps) {
  const arrow = !active ? "" : direction === "asc" ? " ▲" : " ▼";
  return (
    <th
      scope="col"
      className="cursor-pointer select-none px-3 py-2 text-left font-medium hover:bg-muted"
      onClick={onClick}
      data-testid={`sort-${column}`}
    >
      {column}
      {arrow}
    </th>
  );
}