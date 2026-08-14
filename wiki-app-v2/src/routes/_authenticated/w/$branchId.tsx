import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Pencil, Eye, Loader2, MessageSquare, History, Link2, Network, Lock, LockOpen } from "lucide-react";

import { api, type PageData } from "@/api/client";
import { CollabEditor, PageEditor, type PageEditorHandle } from "@/features/editor/Editor";
import { useAutosave, saveStateLabel, type SavePageFn } from "@/features/editor/useAutosave";
import { userColor, type CollabUser } from "@/features/editor/useCollab";
import { useSession } from "@/api/authClient";
import { ReadOnlyContent } from "@/features/editor/ReadOnlyContent";
import { TableOfContents } from "@/features/editor/TableOfContents";
import { CodePageReadOnly } from "@/features/editor/CodePageReadOnly";
import { CodePageEditor } from "@/features/editor/CodePageEditor";
import { EncryptedPageLock } from "@/features/encryption/EncryptedPageLock";
import { ProtectPageDialog } from "@/features/encryption/ProtectPageDialog";
import { createEnvelope, sealContent, type CryptoEnvelope } from "@/shared/cryptoEnvelope";
import { CommentsPanel } from "@/features/comments/CommentsPanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { RelationsPanel } from "@/features/relations/RelationsPanel";
import { GraphPanel } from "@/features/graph/GraphPanel";
import { TemplateBanner } from "@/features/templates/TemplateBanner";
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
  const [showGraph, setShowGraph] = useState(false);
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
  // §13.7: an unlocked page keeps its plaintext + live DEK in memory for this
  // session only. Nothing here is persisted; navigating away forgets the key.
  const [unlock, setUnlock] = useState<{ plaintext: unknown; dek: CryptoKey; updatedAt: string } | null>(null);
  const [showProtect, setShowProtect] = useState(false);
  const [protectBusy, setProtectBusy] = useState(false);

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
    setShowGraph(false);
    setEditMode(false);
    setCollabOn(false);
    setUnlock(null);
    setShowProtect(false);
  }, [branchId]);

  // Derive the star's initial state from the user's favorites list (refetched
  // per branch so navigation always reflects reality). FavoriteButton keys off
  // branchId so it remounts with the correct initial value.
  const { data: favoriteBranchIds } = useQuery(
    () => api.listFavorites().then((list) => new Set(list.map((f) => f.branchId))),
    [branchId]
  );

  // §13.7 derived state + callbacks. These must live BEFORE the early loading/
  // error returns below so the hook order stays constant across renders.
  const isEncrypted = page?.isEncrypted === true;
  const envelope = isEncrypted && page ? (page.content as CryptoEnvelope) : null;
  // A locked page exposes no plaintext to the read/edit views; the lock gate in
  // the body owns the unlock interaction. Once unlocked, `unlock.plaintext` is
  // the single source of truth for this session (edits update it in place).
  const content = isEncrypted ? (unlock?.plaintext ?? null) : (livePage?.content ?? page?.content);
  const updatedAt = isEncrypted ? (unlock?.updatedAt ?? page?.updatedAt ?? "") : (livePage?.updatedAt ?? page?.updatedAt ?? "");

  const handleEncryptedContentChange = useCallback((nextContent: unknown, nextUpdatedAt: string) => {
    setUnlock((u) => (u ? { ...u, plaintext: nextContent, updatedAt: nextUpdatedAt } : u));
  }, []);

  // Encrypted autosave: re-seal the edited plaintext with the in-memory DEK and
  // reuse the original envelope's KDF/wrapped-DEK (they never change). The
  // server only ever sees the sealed envelope.
  const encryptedSavePage = useCallback<SavePageFn>(async (branchIdArg, pending) => {
    if (!unlock || !envelope) throw new Error("Page not unlocked");
    const sealed = await sealContent(pending.content, unlock.dek);
    return api.savePageContent(branchIdArg, {
      content: { ...envelope, content: sealed },
      title: pending.title,
      titleProvided: pending.titleProvided,
      expectedUpdatedAt: pending.expectedUpdatedAt,
      encrypted: true,
    });
  }, [unlock, envelope]);

  const handleProtectConfirm = useCallback(async (passphrase: string) => {
    if (!page) return;
    setProtectBusy(true);
    try {
      const env = await createEnvelope(content, passphrase);
      await api.savePageContent(page.branchId, {
        content: env,
        expectedUpdatedAt: new Date(updatedAt),
        encrypted: true,
      });
      setShowProtect(false);
      handleReload();
      toast.success("Page protected.");
    } catch {
      toast.error("Could not protect this page.");
    } finally {
      setProtectBusy(false);
    }
  }, [content, updatedAt, page, handleReload]);

  const handleUnprotect = useCallback(async () => {
    if (!unlock || !page) return;
    try {
      await api.savePageContent(page.branchId, {
        content: unlock.plaintext,
        expectedUpdatedAt: new Date(unlock.updatedAt),
        encrypted: false,
      });
      setUnlock(null);
      handleReload();
      toast.success("Page protection removed.");
    } catch {
      toast.error("Could not remove protection.");
    }
  }, [unlock, page, handleReload]);

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

  return (
    <div className="flex h-full flex-col">
      <TemplateBanner
        templates={page.templates ?? []}
        inheritedAttributes={page.inheritedAttributes}
      />
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
        showGraph={showGraph}
        onToggleGraph={() => setShowGraph((s) => !s)}
        initiallyFavorited={favoriteBranchIds?.has(page.branchId) ?? false}
        isEncrypted={isEncrypted}
        unlocked={unlock !== null}
        onProtect={() => setShowProtect(true)}
        onUnprotect={handleUnprotect}
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          {isEncrypted && !unlock ? (
            envelope ? (
              <EncryptedPageLock
                envelope={envelope}
                onUnlock={(plaintext, dek) =>
                  setUnlock({ plaintext, dek, updatedAt: page.updatedAt })
                }
              />
            ) : null
          ) : editMode ? (
            page.pageType === "code" ? (
              <CodeEditableCanvas
                branchId={page.branchId}
                slug={page.slug}
                content={content}
                language={page.language ?? null}
                updatedAt={updatedAt}
                key={`${page.id}:${reloadTick}`}
                onConflict={handleReload}
                savePage={isEncrypted ? encryptedSavePage : undefined}
                onContentChange={isEncrypted ? handleEncryptedContentChange : (nextContent, nextUpdatedAt) =>
                  setLivePage({ content: nextContent, updatedAt: nextUpdatedAt })
                }
              />
            ) : (
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
                savePage={isEncrypted ? encryptedSavePage : undefined}
                onContentChange={isEncrypted ? handleEncryptedContentChange : (nextContent, nextUpdatedAt) =>
                  setLivePage({ content: nextContent, updatedAt: nextUpdatedAt })
                }
              />
            )
          ) : page.pageType === "code" ? (
            <div className="flex h-full min-h-0">
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="editor-canvas">
                  <CodePageReadOnly content={content} language={page.language ?? null} />
                </div>
              </div>
            </div>
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
        {showGraph && (
          <GraphPanel
            key={page.id}
            pageId={page.id}
          />
        )}
      </div>
      {showProtect && (
        <ProtectPageDialog
          busy={protectBusy}
          onCancel={() => setShowProtect(false)}
          onConfirm={handleProtectConfirm}
        />
      )}
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
  showGraph,
  onToggleGraph,
  initiallyFavorited,
  isEncrypted,
  unlocked,
  onProtect,
  onUnprotect,
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
  showGraph: boolean;
  onToggleGraph: () => void;
  initiallyFavorited: boolean;
  isEncrypted: boolean;
  unlocked: boolean;
  onProtect: () => void;
  onUnprotect: () => void;
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
        {isEncrypted && (
          <span
            className="flex items-center text-text-muted shrink-0"
            title={unlocked ? "Protected (unlocked this session)" : "Protected"}
          >
            {unlocked ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <FavoriteButton branchId={page.branchId} initiallyFavorited={initiallyFavorited} />
        {!editMode && (page.access === "editor" || page.access === "admin") ? (
          isEncrypted && unlocked ? (
            <button
              type="button"
              onClick={onUnprotect}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors text-text-secondary hover:bg-surface-hover"
              aria-label="Remove page protection"
              title="Remove protection"
              data-testid="unprotect-page"
            >
              <LockOpen className="h-4 w-4" />
            </button>
          ) : !isEncrypted ? (
            <button
              type="button"
              onClick={onProtect}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors text-text-secondary hover:bg-surface-hover"
              aria-label="Protect page"
              title="Protect page with a passphrase"
              data-testid="protect-page"
            >
              <Lock className="h-4 w-4" />
            </button>
          ) : null
        ) : null}
        {!isEncrypted && (
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
        )}
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
        <button
          type="button"
          onClick={onToggleGraph}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
            showGraph ? "bg-accent text-primary" : "text-text-secondary hover:bg-surface-hover"
          )}
          aria-label={showGraph ? "Hide graph" : "Show graph"}
          aria-pressed={showGraph}
          data-testid="graph-toggle"
        >
          <Network className="h-4 w-4" />
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

function EditableCanvas({ branchId, slug, content, updatedAt, collabOn, collabUser, onToggleCollab, onCollabSessionEnd, onConflict, onContentChange, savePage }: {
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
  savePage?: Parameters<typeof useAutosave>[0]["savePage"];
}) {
  const editorRef = useRef<PageEditorHandle>(null);

  const getContent = useCallback(() => editorRef.current?.getJSON() ?? content, [content]);
  const getTitle = useCallback(() => undefined, []);

  const { state: saveState, scheduleSave, saveNow } = useAutosave({
    branchId,
    initialUpdatedAt: new Date(updatedAt),
    getContent,
    getTitle,
    savePage,
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

// ---------------------------------------------------------------------------
// Code-page editable canvas — plain-text source editor with OCC autosave.
// No collab: the Yjs/Tiptap collab path is rich-text only (§13.6 code pages
// are single-file text, so live-edit is out of scope for this slice).
// ---------------------------------------------------------------------------

function CodeEditableCanvas({ branchId, slug, content, language, updatedAt, onConflict, onContentChange, savePage }: {
  branchId: string;
  slug: string;
  content: unknown;
  language: string | null;
  updatedAt: string;
  onConflict: () => void;
  onContentChange: (content: unknown, updatedAt: string) => void;
  savePage?: Parameters<typeof useAutosave>[0]["savePage"];
}) {
  const [value, setValue] = useState(typeof content === "string" ? content : "");
  // The autosave controller snapshots `getContent()` synchronously when the
  // debounce is scheduled, which is BEFORE React re-renders with the new value.
  // Reading a ref (like the Tiptap editor does with editorRef) keeps the save
  // payload current without depending on the render closure's `value`.
  const valueRef = useRef(value);
  valueRef.current = value;

  const getContent = useCallback(() => valueRef.current, []);
  const getTitle = useCallback(() => undefined, []);

  const { state: saveState, scheduleSave, saveNow } = useAutosave({
    branchId,
    initialUpdatedAt: new Date(updatedAt),
    getContent,
    getTitle,
    savePage,
    onSaved: (next) => onContentChange(valueRef.current, next.toISOString()),
    onConflict: () => {
      toast.error("This page was updated elsewhere. Reload to see the latest version.", {
        action: { label: "Reload", onClick: onConflict },
      });
    },
  });

  const handleChange = useCallback((next: string) => {
    // Update the ref synchronously: scheduleSave snapshots getContent() in the
    // same tick (before this render commits), so the ref must already hold the
    // latest text or the debounced save would persist the previous value.
    valueRef.current = next;
    setValue(next);
    scheduleSave();
  }, [scheduleSave]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodePageEditor value={value} language={language} onChange={handleChange} autoFocus />
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
