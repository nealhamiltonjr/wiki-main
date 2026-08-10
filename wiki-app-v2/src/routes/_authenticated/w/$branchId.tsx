import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Pencil, Eye, Loader2, MessageSquare, History } from "lucide-react";

import { api, type PageData } from "@/api/client";
import { PageEditor, type PageEditorHandle } from "@/features/editor/Editor";
import { useAutosave, saveStateLabel } from "@/features/editor/useAutosave";
import { ReadOnlyContent } from "@/features/editor/ReadOnlyContent";
import { CommentsPanel } from "@/features/comments/CommentsPanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { FavoriteButton } from "@/features/favorites/FavoriteButton";
import { useQuery } from "@/lib/useQuery";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/w/$branchId")({
  component: PageView,
});

function PageView() {
  const { branchId } = Route.useParams();
  const [editMode, setEditMode] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Content/updatedAt the editor has autosaved this session. The read view and
  // any re-entry into edit mode use this instead of the fetch-time snapshot so
  // "View" never shows stale content and re-editing never saves on a stale OCC
  // timestamp.
  const [livePage, setLivePage] = useState<{ content: unknown; updatedAt: string } | null>(null);
  // Bumped whenever we discard the session's live content (OCC conflict reload,
  // git restore). Forces the editor to remount with fresh server data — without
  // it, a 409 reload leaves the editor holding a stale expectedUpdatedAt and
  // every subsequent save conflicts again (infinite loop), and a restore stays
  // hidden behind the older autosaved session content.
  const [reloadTick, setReloadTick] = useState(0);

  const { data: page, loading, error, reload } = useQuery(
    () => api.getPage(branchId),
    [branchId]
  );

  const handleReload = useCallback(() => {
    setLivePage(null);
    setReloadTick((t) => t + 1);
    reload();
  }, [reload]);

  // Reset transient view state whenever we navigate to a different page. The
  // route component instance is reused across branch params (same route match),
  // so without this the comments panel would keep showing the previous page's
  // threads and edit mode would leak onto the next page.
  useEffect(() => {
    setLivePage(null);
    setShowComments(false);
    setShowHistory(false);
    setEditMode(false);
  }, [branchId]);

  // Derive the star's initial state from the user's favorites list (refetched
  // per branch so navigation always reflects reality). FavoriteButton keys off
  // branchId so it remounts with the correct initial value.
  const { data: favoriteBranchIds } = useQuery(
    () => api.listFavorites().then((list) => new Set(list.map((f) => f.branchId))),
    [branchId]
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading page…
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Page not found
      </div>
    );
  }

  const iconAttr = page.attributes.find((a) => a.name === "icon");
  const content = livePage?.content ?? page.content;
  const updatedAt = livePage?.updatedAt ?? page.updatedAt;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        key={page.branchId}
        page={page}
        icon={iconAttr?.value}
        editMode={editMode}
        onToggleEdit={() => setEditMode((m) => !m)}
        showComments={showComments}
        onToggleComments={() => setShowComments((s) => !s)}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory((s) => !s)}
        initiallyFavorited={favoriteBranchIds?.has(page.branchId) ?? false}
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          {editMode ? (
            <EditableCanvas
              branchId={page.branchId}
              slug={page.slug}
              content={content}
              updatedAt={updatedAt}
              key={`${page.id}:${reloadTick}`}
              onConflict={handleReload}
              onContentChange={(nextContent, nextUpdatedAt) =>
                setLivePage({ content: nextContent, updatedAt: nextUpdatedAt })
              }
            />
          ) : (
            <div className="flex h-full min-h-0">
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="editor-canvas">
                  <div className="wiki-prose">
                    <ReadOnlyContent content={content} />
                  </div>
                </div>
              </div>
              {!showComments && <PageTOC content={content} />}
            </div>
          )}
        </div>
        {showComments && (
          <CommentsPanel
            key={page.branchId}
            branchId={branchId}
            canEdit={page.access === "editor" || page.access === "admin"}
          />
        )}
        {showHistory && (
          <HistoryPanel
            pageId={page.id}
            branchId={page.branchId}
            canEdit={page.access === "editor" || page.access === "admin"}
            onRestored={handleReload}
          />
        )}
      </div>
    </div>
  );
}

function PageHeader({
  page,
  icon,
  editMode,
  onToggleEdit,
  showComments,
  onToggleComments,
  showHistory,
  onToggleHistory,
  initiallyFavorited,
}: {
  page: PageData;
  icon?: string;
  editMode: boolean;
  onToggleEdit: () => void;
  showComments: boolean;
  onToggleComments: () => void;
  showHistory: boolean;
  onToggleHistory: () => void;
  initiallyFavorited: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-1.5">
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-sm font-medium text-text-secondary truncate max-w-md">
          {icon ? <span className="mr-1.5">{icon}</span> : null}{page.title}
        </h2>
        {page.access && page.access !== "none" && (
          <span className="text-xs text-text-muted capitalize shrink-0">
            · {page.access}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <FavoriteButton branchId={page.branchId} initiallyFavorited={initiallyFavorited} />
        <button
          type="button"
          onClick={onToggleHistory}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
            showHistory ? "bg-accent text-primary" : "text-text-secondary hover:bg-surface-hover"
          )}
          aria-label={showHistory ? "Hide version history" : "Show version history"}
          aria-pressed={showHistory}
          data-testid="history-toggle"
        >
          <History className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onToggleComments}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
            showComments ? "bg-accent text-primary" : "text-text-secondary hover:bg-surface-hover"
          )}
          aria-label={showComments ? "Hide comments" : "Show comments"}
          aria-pressed={showComments}
          data-testid="comments-toggle"
        >
          <MessageSquare className="h-4 w-4" />
        </button>
        {page.access === "editor" || page.access === "admin" ? (
          <button
            type="button"
            onClick={onToggleEdit}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium
                       transition-colors border border-border hover:bg-surface-hover"
            aria-label={editMode ? "View mode" : "Edit"}
          >
            {editMode ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {editMode ? "View" : "Edit"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable canvas — Tiptap editor with OCC autosave.
// ---------------------------------------------------------------------------

function EditableCanvas({ branchId, slug, content, updatedAt, onConflict, onContentChange }: {
  branchId: string;
  slug: string;
  content: unknown;
  updatedAt: string;
  onConflict: () => void;
  onContentChange: (content: unknown, updatedAt: string) => void;
}) {
  const editorRef = useRef<PageEditorHandle>(null);

  const getContent = useCallback(() => editorRef.current?.getJSON() ?? content, [content]);
  const getTitle = useCallback(() => undefined, []);

  const { state: saveState, scheduleSave, saveNow } = useAutosave({
    branchId,
    initialUpdatedAt: new Date(updatedAt),
    getContent,
    getTitle,
    onSaved: (next) => onContentChange(getContent(), next.toISOString()),
    onConflict: () => {
      toast.error("This page was updated elsewhere. Reload to see the latest version.", {
        action: { label: "Reload", onClick: onConflict },
      });
    },
  });

  const handleUpdate = useCallback(() => {
    scheduleSave();
  }, [scheduleSave]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageEditor
        ref={editorRef}
        content={content}
        editable
        onUpdate={handleUpdate}
      />
      <div className="flex items-center justify-between border-t border-border px-4 py-1 text-xs text-text-muted">
        <span>{saveStateLabel(saveState)}</span>
        <div className="flex items-center gap-3">
          <span>{slug}</span>
          {saveState === "dirty" && (
            <button type="button" onClick={saveNow} className="underline text-link">
              Save now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-page table of contents (§12.6) — auto-generated from heading nodes in the
// page JSON, sticky sidebar in read mode. Extracts headings from the Tiptap
// doc tree (same source as ReadOnlyContent), anchors them via heading id attrs.
// ---------------------------------------------------------------------------

interface TocEntry { id: string; level: number; text: string }

function PageTOC({ content }: { content: unknown }) {
  const entries = useMemo(() => extractTocEntries(content), [content]);
  if (entries.length < 2) return null; // Not enough headings to justify a TOC

  return (
    <nav className="sticky top-0 hidden w-52 shrink-0 overflow-auto border-l border-border px-3 py-6 lg:block" aria-label="In-page table of contents">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">On this page</h4>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              className={cn(
                "block rounded-sm py-0.5 text-xs text-text-secondary transition-colors hover:text-foreground",
                e.level === 1 && "font-medium text-foreground",
                e.level >= 3 && "pl-3"
              )}
            >
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function extractTocEntries(content: unknown): TocEntry[] {
  const entries: TocEntry[] = [];
  const doc = content as { type: string; content?: Array<Record<string, unknown>> } | null;
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return entries;
  for (const node of doc.content) {
    if (node.type === "heading") {
      const id = (node.attrs as Record<string, unknown> | undefined)?.id as string | undefined;
      const level = (node.attrs as Record<string, unknown> | undefined)?.level as number ?? 2;
      const text = extractText(node);
      if (id && text) entries.push({ id, level, text });
    }
  }
  return entries;
}

function extractText(node: Record<string, unknown>): string {
  const children = node.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(children)) return "";
  return children.map((c) => (c.type === "text" ? (c.text as string) ?? "" : "")).join("");
}
