import { Link } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import type { TemplateRef, InheritedAttribute } from "@/api/client";

/**
 * Banner shown above the page header when the page declares one or
 * more direct templates (§13.3). Lists the templates in their
 * user-defined position order; clicking a template navigates to it.
 *
 * Pure presentational — the data already passed permission filtering
 * server-side, so a non-null template here is safe to render.
 *
 * The "Inherited from" subline shows the *deepest* template in the
 * chain (largest depth) when inherited attributes are present, which
 * is the most informative single-line summary; the full per-attribute
 * provenance is exposed via the inheritedAttributes field on PageData
 * for §13.4 saved views.
 */
export function TemplateBanner({
  templates,
  inheritedAttributes,
}: {
  templates: TemplateRef[];
  inheritedAttributes?: InheritedAttribute[];
}) {
  if (!templates || templates.length === 0) return null;

  const inheritedCount = inheritedAttributes?.length ?? 0;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface/40 px-4 py-1.5 text-xs text-text-secondary"
      data-testid="template-banner"
      role="note"
      aria-label="Template banner"
    >
      <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide text-text-muted">
        <Layers className="h-3.5 w-3.5" aria-hidden />
        Template
        {templates.length > 1 ? "s" : ""}
      </span>
      {templates.map((t, i) => (
        <span key={t.pageId} className="inline-flex items-center gap-2">
          {i > 0 && <span className="text-text-muted">·</span>}
          {t.branchId ? (
            <Link
              to="/w/$branchId"
              params={{ branchId: t.branchId }}
              className="rounded text-text-secondary underline-offset-2 hover:text-primary hover:underline"
              data-testid="template-link"
            >
              {t.title}
            </Link>
          ) : (
            <span className="text-text-muted">{t.title}</span>
          )}
        </span>
      ))}
      {inheritedCount > 0 && (
        <span className="ml-auto text-[11px] text-text-muted" data-testid="template-inherited-count">
          Inherits {inheritedCount} attribute{inheritedCount === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}