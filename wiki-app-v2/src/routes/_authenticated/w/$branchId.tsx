import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Pencil, Eye, Loader2, MessageSquare, History, Link2 } from "lucide-react";

import { api, type PageData } from "@/api/client";
import { CollabEditor, PageEditor, type PageEditorHandle } from "@/features/editor/Editor";
import { useAutosave, saveStateLabel } from "@/features/editor/useAutosave";
import { userColor, type CollabUser } from "@/features/editor/useCollab";
import { useSession } from "@/api/authClient";
import { ReadOnlyContent } from "@/features/editor/ReadOnlyContent";
import { TableOfContents } from "@/features/editor/TableOfContents";
import { CommentsPanel } from "@/features/comments/CommentsPanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { RelationsPanel } from "@/features/relations/RelationsPanel";
import { FavoriteButton } from "@/features/favorites/FavoriteButton";
import { useQuery } from "@/lib/useQuery";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/w/$branchId")({
  component: PageView,
});

// How long to wait after a collab session stops before refetching the page:
// the Hocuspocus server persists via onStoreDocument after its debounce
// window, and the refetch must not beat that write-back or the editor/view
// would show pre-collab content.
const COLLAB_FLUSH_WAIT_MS = 2600;

function PageView() {
  const { branchId } = Route.useParams();
  const [editMode, setEditMode] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRelations, setShowRelations] = useState(false);
  const [collabOn, setCollabOn] = useState(false);
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

  // Session user feeds the collab cursor identity; resolved unconditionally so
  // hook order stays stable across the early returns below.
  const { data: session } = useSession();
  const collabUser = useMemo<CollabUser>(() => {
    const name = session?.user?.name?.trim() || session?.user?.email || "Anonymous";
    return { name, color: userColor(session?.user?.id ?? name) };
  }, [session]);

  const handleReload = useCallback(() => {
    setLivePage(null);
    setReloadTick((t) => t + 1);
    reload();
  }, [reload]);

  // End of a collab session: let the server's write-back (Hocuspocus debounce)
  // land before refetching, so the next editor/view starts from the collab
  // content rather than the pre-session snapshot.
  const handleCollabSessionEnd = useCallback(() => {
    setCollabOn(false);
    window.setTimeout(handleReload, COLLAB_FLUSH_WAIT_MS);
  }, [handleReload]);

  const toggleEdit = useCallback(() => {
    // Exiting edit mode while a collab session is live: the collab editor is
    // about to unmount (provider destroy flushes), so refetch after the
    // write-back lands instead of showing the stale autosave snapshot.
    if (editMode && collabOn) handleCollabSessionEnd();
    setEditMode((m) => !m);
  }, [editMode, collabOn, handleCollabSessionEnd]);

  // Reset transient view state whenever we navigate to a different page. The
  // route component instance is reused across branch params (same route match),
  // so without this the comments panel would keep showing the previous page's
  // threads and edit mode would leak onto the next page.
  useEffect(() => {
    setLivePage(null);
    setShowComments(false);
    setShowHistory(false);
    setShowRelations(false);
    setEditMode(false);
    setCollabOn(false);
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
        onToggleEdit={toggleEdit}
        showComments={showComments}
        onToggleComments={() => setShowComments((s) => !s)}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory((s) => !s)}
        showRelations={showRelations}
        onToggleRelations={() => setShowRelations((s) => !s)}
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
              collabOn={collabOn}
              collabUser={collabUser}
              onToggleCollab={() => setCollabOn((c) => !c)}
              onCollabSessionEnd={handleCollabSessionEnd}
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
              {!showComments && <TableOfContents content={content} />}
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
        {showRelations && (
          <RelationsPanel
            key={page.id}
            pageId={page.id}
            canEdit={page.access === "editor" || page.access === "admin"}
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
  showRelations,
  onToggleRelations,
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
  showRelations: boolean;
  onToggleRelations: () => void;
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
        <button
          type="button"
          onClick={onToggleRelations}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
            showRelations ? "bg-accent text-primary" : "text-text-secondary hover:bg-surface-hover"
          )}
          aria-label={showRelations ? "Hide relations" : "Show relations"}
          aria-pressed={showRelations}
          data-testid="relations-toggle"
        >
          <Link2 className="h-4 w-4" />
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

function EditableCanvas({ branchId, slug, content, updatedAt, collabOn, collabUser, onToggleCollab, onCollabSessionEnd, onConflict, onContentChange }: {
  branchId: string;
  slug: string;
  content: unknown;
  updatedAt: string;
  collabOn: boolean;
  collabUser: CollabUser;
  onToggleCollab: () => void;
  onCollabSessionEnd: () => void;
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

  // Autosave only runs in the single-user editor; while collab is live the
  // server's onStoreDocument write-back is the only persistence path.
  const handleUpdate = useCallback(() => {
    if (!collabOn) scheduleSave();
  }, [collabOn, scheduleSave]);

  if (collabOn) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <CollabEditor documentName={branchId} user={collabUser} />
        <div className="flex items-center justify-between border-t border-border px-4 py-1 text-xs text-text-muted">
          <span>{slug}</span>
          <button type="button" onClick={onCollabSessionEnd} className="underline text-link">
            Stop live editing
          </button>
        </div>
      </div>
    );
  }

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
          <button
            type="button"
            onClick={onToggleCollab}
            className="underline text-link"
            title="Collaborate live on this page with other editors"
          >
            Live edit…
          </button>
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
