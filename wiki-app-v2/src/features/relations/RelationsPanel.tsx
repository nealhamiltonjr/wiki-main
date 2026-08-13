import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link2, ArrowRight, ArrowLeft, Plus, Trash2, Loader2, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError, type IncomingRelation, type OwnedRelation, type PageSearchHit } from "@/api/client";
import { cn } from "@/lib/utils";

const TYPE_MAX = 64;

/** Pure validator for the relation-type input. Mirrors the server-side
 *  rules: non-empty, ≤ 64 chars, no control chars. Returns the first
 *  failing message, or null when valid. Exported for unit tests. */
export function validateRelationType(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "relation type is required";
  if (t.length > TYPE_MAX) return `relation type must be ≤ ${TYPE_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(t)) return "relation type contains control characters";
  return null;
}

/**
 * Relations sidebar panel (slice-26, finishing brief §13.1 from the UI side).
 *
 * Lists typed relations declared by the current page (owned / outgoing) and
 * relations from other pages that point at this one (incoming). Editors
 * can create new relations via a search-driven target picker and remove
 * relations they own.
 *
 * Search-driven target picker: a plain autocomplete over `/api/search`
 * — typing ≥ 2 chars fires a debounced search and the results become
 * click-to-pick rows. The picker requires a readable branch, so the
 * permission filtering the search route already does is reused.
 */
export function RelationsPanel({ pageId, canEdit }: { pageId: string; canEdit: boolean }) {
  const [owned, setOwned] = useState<OwnedRelation[] | null>(null);
  const [incoming, setIncoming] = useState<IncomingRelation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      const [o, i] = await Promise.all([
        api.listOwnedRelations(pageId).then((r) => r.owned).catch(() => []),
        api.listIncomingRelations(pageId).then((r) => r.incoming).catch(() => []),
      ]);
      setOwned(o);
      setIncoming(i);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <RelationsPanelBody
      pageId={pageId}
      canEdit={canEdit}
      owned={owned}
      incoming={incoming}
      loading={loading}
      showForm={showForm}
      setShowForm={setShowForm}
      refresh={refresh}
    />
  );
}

function RelationsPanelBody({
  pageId, canEdit, owned, incoming, loading, showForm, setShowForm, refresh,
}: {
  pageId: string;
  canEdit: boolean;
  owned: OwnedRelation[] | null;
  incoming: IncomingRelation[] | null;
  loading: boolean;
  showForm: boolean;
  setShowForm: (b: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const ownedList = owned ?? [];
  const incomingList = incoming ?? [];
  return (
    <aside
      className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface/50"
      data-testid="relations-panel"
      aria-label="Relations"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-text-secondary" />
          <h3 className="text-xs font-medium">Relations</h3>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            aria-label={showForm ? "Cancel new relation" : "Add a relation"}
            aria-expanded={showForm}
            data-testid="relations-toggle-form"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded transition-colors",
              showForm
                ? "bg-accent text-primary"
                : "text-text-muted hover:bg-surface-hover",
            )}
          >
            {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {showForm && canEdit && (
        <RelationForm
          pageId={pageId}
          onCreated={async () => {
            setShowForm(false);
            await refresh();
          }}
        />
      )}

      <SectionHeader icon={ArrowRight} label="Outgoing" count={ownedList.length} />
      <RelationList
        loading={loading && owned === null}
        emptyMessage="No outgoing relations"
        rows={ownedList.map((r) => ({
          key: r.id,
          type: r.type,
          ref: r.target,
          canRemove: canEdit,
          attributeId: r.id,
          pageId,
          onRemoved: refresh,
        }))}
        testid="owned-relation"
        variant="outgoing"
      />

      <SectionHeader icon={ArrowLeft} label="Incoming" count={incomingList.length} />
      <RelationList
        loading={loading && incoming === null}
        emptyMessage="No incoming relations"
        rows={incomingList.map((r) => ({
          key: r.id,
          type: r.type,
          ref: r.source,
          canRemove: false,
          attributeId: r.id,
          pageId,
          onRemoved: refresh,
        }))}
        testid="incoming-relation"
        variant="incoming"
      />
    </aside>
  );
}

function SectionHeader({ icon: Icon, label, count }: { icon: typeof ArrowRight; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-surface/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
      <Icon className="h-3 w-3" />
      <span>{label}</span>
      <span className="ml-auto text-text-muted">{count}</span>
    </div>
  );
}

interface RelationRow {
  key: string;
  type: string;
  ref: { id: string; title: string; branchId: string | null } | null;
  canRemove: boolean;
  attributeId: string;
  pageId: string;
  onRemoved: () => Promise<void>;
}

function RelationList({
  rows, loading, emptyMessage, testid, variant,
}: {
  rows: RelationRow[];
  loading: boolean;
  emptyMessage: string;
  testid: string;
  variant: "outgoing" | "incoming";
}) {
  if (loading) {
    return (
      <p className="flex items-center justify-center gap-1.5 p-4 text-xs text-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="p-4 text-center text-xs text-text-muted">{emptyMessage}</p>;
  }
  return (
    <ul className="divide-y divide-border" data-testid={`${testid}-list`}>
      {rows.map((row) => (
        <RelationRowView key={row.key} row={row} variant={variant} />
      ))}
    </ul>
  );
}

function RelationRowView({ row, variant }: { row: RelationRow; variant: "outgoing" | "incoming" }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!row.canRemove || busy) return;
    setBusy(true);
    try {
      await api.removeRelation(row.pageId, row.attributeId);
      await row.onRemoved();
    } finally {
      setBusy(false);
    }
  };
  const title = row.ref?.title || "(untitled)";
  const navigateTo = row.ref?.branchId
    ? () => navigate({ to: "/w/$branchId", params: { branchId: row.ref!.branchId! } })
    : null;
  return (
    <li className="p-3" data-testid={variant === "outgoing" ? "owned-relation" : "incoming-relation"}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              "inline-block max-w-full truncate rounded border px-1.5 py-0.5 align-middle text-[11px] font-medium",
              variant === "outgoing"
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-accent bg-accent text-accent-foreground",
            )}
            data-testid="relation-type"
          >
            {row.type}
          </span>
          <button
            type="button"
            onClick={navigateTo ?? undefined}
            disabled={!navigateTo}
            className={cn(
              "mt-1 block w-full truncate text-left text-xs",
              navigateTo
                ? "cursor-pointer text-foreground hover:underline"
                : "cursor-default text-text-muted",
            )}
            data-testid="relation-target"
            title={title}
          >
            {title}
          </button>
        </div>
        {row.canRemove && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            aria-label="Remove relation"
            data-testid="relation-remove"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </button>
        )}
      </div>
    </li>
  );
}

/** Search-driven target picker. The user types a page title; debounced
 *  search returns hits; clicking a hit submits the relation. */
function RelationForm({
  pageId, onCreated,
}: {
  pageId: string;
  onCreated: () => Promise<void>;
}) {
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PageSearchHit[]>([]);
  const [picked, setPicked] = useState<PageSearchHit | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search; skip when a target has already been picked (so
  // editing the type field doesn't keep firing).
  useEffect(() => {
    if (picked) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      api
        .searchPages(q, { limit: 8 })
        .then((res) => setHits(res.results.filter((h) => h.pageId !== pageId)))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, picked, pageId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked || busy) return;
    const t = type.trim();
    const validationError = validateRelationType(t);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.addRelation(pageId, { type: t, toPageId: picked.pageId });
      setType("");
      setQuery("");
      setHits([]);
      setPicked(null);
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? extractError(err) : "failed to add relation");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-b border-border bg-surface p-3"
      data-testid="relations-form"
    >
      <label className="block text-[11px] font-medium uppercase tracking-wide text-text-muted">
        Relation type
      </label>
      <input
        value={type}
        onChange={(e) => setType(e.target.value)}
        maxLength={TYPE_MAX}
        placeholder='e.g. "depends on"'
        data-testid="relation-type-input"
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
      />

      <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-text-muted">
        Target page
      </label>
      {picked ? (
        <div className="mt-1 flex items-center justify-between rounded-md border border-border bg-background px-2 py-1 text-xs">
          <span className="truncate" data-testid="relation-picked">{picked.title}</span>
          <button
            type="button"
            onClick={() => setPicked(null)}
            aria-label="Clear picked target"
            data-testid="relation-clear-pick"
            className="ml-2 text-text-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages…"
            data-testid="relation-target-input"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {(hits.length > 0 || searching) && (
            <ul
              className="mt-1 max-h-44 overflow-y-auto rounded-md border border-border bg-background"
              data-testid="relation-search-hits"
            >
              {searching && hits.length === 0 && (
                <li className="flex items-center gap-1.5 p-2 text-xs text-text-muted">
                  <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                </li>
              )}
              {hits.map((h) => (
                <li key={h.pageId}>
                  <button
                    type="button"
                    onClick={() => setPicked(h)}
                    data-testid="relation-search-hit"
                    className="block w-full truncate px-2 py-1 text-left text-xs hover:bg-surface-hover"
                    title={`${h.title} — ${h.spaceName}`}
                  >
                    {h.title}
                    <span className="ml-1 text-text-muted">· {h.spaceName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && (
        <p className="mt-2 text-[11px] text-danger" data-testid="relation-error">{error}</p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="submit"
          disabled={busy || !picked || !type.trim()}
          data-testid="relation-submit"
          className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add
        </button>
      </div>
    </form>
  );
}

function extractError(err: ApiError): string {
  const body = err.body as { error?: unknown } | null;
  if (body && typeof body === "object" && typeof body.error === "string") return body.error;
  return err.message || "request failed";
}
