import type { ReactNode } from "react";
import type { LensHit } from "../../api/client.js";
import { groupHits } from "./lensView.helpers.js";

/**
 * Kanban-style board view. One column per distinct value of the
 * chosen promoted attribute; missing/empty values land in the
 * "(none)" column.
 *
 * Like TableView, this is pure presentational. The parent owns
 * the groupBy state and the page-link renderer (so this can be
 * unit-tested without a router context).
 */
export interface BoardViewProps {
  hits: LensHit[];
  groupBy: string;
  renderPageLink?: (hit: LensHit, children: ReactNode) => ReactNode;
}

export function BoardView({ hits, groupBy, renderPageLink }: BoardViewProps) {
  const groups = groupHits(hits, groupBy);

  if (hits.length === 0) {
    return <div className="p-6 text-sm text-text-muted">No pages match this lens.</div>;
  }

  return (
    <div className="flex gap-3 overflow-x-auto p-3" data-testid="lens-board">
      {[...groups.entries()].map(([value, items]) => (
        <div
          key={value}
          className="flex w-64 shrink-0 flex-col rounded border bg-muted/30"
          data-testid={`board-column-${value}`}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="font-medium text-sm">
              {value === "__none__" ? "(none)" : value}
            </span>
            <span className="text-xs text-text-muted">{items.length}</span>
          </div>
          <div className="flex min-h-[2rem] flex-col gap-2 p-2">
            {items.map((hit) => (
              <div
                key={hit.pageId}
                className="rounded border bg-background px-3 py-2 text-sm shadow-sm"
              >
                {renderPageLink
                  ? renderPageLink(hit, <span className="font-medium">{hit.title}</span>)
                  : <span className="font-medium">{hit.title}</span>}
                <div className="mt-1 text-xs text-text-muted">{hit.spaceName}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}