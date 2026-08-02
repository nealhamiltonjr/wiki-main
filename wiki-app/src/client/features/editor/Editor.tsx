import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { api, ApiError, type PageContent, type HistoryEntry, type CommentThread } from "../../api/client.js";
import { Toolbar } from "./Toolbar.js";
import { baseEditorExtensions } from "./baseExtensions.js";
import { editingExtensions } from "./editingExtensions.js";
import { WikiLinkExtension } from "./wikiLinkExtension.js";
import { getEditorExtensions } from "./pluginEngine.js";
import "./editorPlugins.js";
import { CommentPanel } from "./CommentPanel.js";
import { PermissionsDialog } from "./PermissionsDialog.js";
import { BacklinksPanel } from "./BacklinksPanel.js";
import { AttributesPanel } from "./AttributesPanel.js";
import { useCollab } from "./useCollab.js";
import { useSession } from "../../api/authClient.js";
import { DragHandleMenu, blockAtPos, type BlockAnchor } from "./DragHandleMenu.js";
import { SearchReplacePopup } from "./SearchReplacePopup.js";
import { handleMarkdownPaste } from "./paste.js";
import { NotificationBell } from "./NotificationBell.js";

const USER_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#be185d", "#4f46e5"];

export function Editor({ branchId }: { branchId: string }) {
  const [page, setPage] = useState<PageContent | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession();

  // Latest page content, tracked in a ref so effects that must NOT reset the
  // editor on every autosave refresh of `page` can still read it.
  const pageRef = useRef<PageContent | null>(null);
  pageRef.current = page;
  const collabEnabledRef = useRef(false);

  const [editorWidth, setEditorWidth] = useState<"full" | "narrow">("full");
  useEffect(() => {
    api.getUserSettings().then((s) => {
      if (s["editor.width"] === "narrow" || s["editor.width"] === "full") {
        setEditorWidth(s["editor.width"]);
      }
    });
  }, []);
  function toggleWidth() {
    const next = editorWidth === "full" ? "narrow" : "full";
    setEditorWidth(next);
    api.setUserSetting("editor.width", next);
  }

  const [isEditing, setIsEditing] = useState(false);

  // Collaboration state
  const [useCollabMode, setUseCollabMode] = useState(false);
  const userName = session?.user.name ?? "Anonymous";
  const userColor = useMemo(
    () => USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] ?? "#2563eb",
    []
  );

  // Only enable collab when page is loaded AND user toggled it
  const collabEnabled = useCollabMode && !!page;
  collabEnabledRef.current = collabEnabled;
  const collabExtensions = useCollab({
    pageId: page?.pageId ?? "",
    userName,
    userColor,
    enabled: collabEnabled,
  });

  // Comment state
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);

  // Per-page permissions (§7.12g)
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  // Backlinks (§7.12 block-refs + backlinks)
  const [backlinksOpen, setBacklinksOpen] = useState(false);

  // Attributes (§7.12d.2)
  const [attributesOpen, setAttributesOpen] = useState(false);

  // Favorites (§7.12d.7)
  const [favorited, setFavorited] = useState(false);
  useEffect(() => {
    if (!page) return;
    api.getFavorites().then((list) => {
      setFavorited(list.some((f) => f.branchId === page.branchId));
    }).catch(() => {});
  }, [page?.branchId]);
  function toggleFavorite() {
    if (!page) return;
    api.toggleFavorite(page.branchId).then((r) => setFavorited(r.favorited)).catch(() => {});
  }

  const exportMarkdown = useCallback(async (mode: "raw" | "zip") => {
    if (!page) return;
    const params = new URLSearchParams();
    params.set("images", "copy");
    if (mode === "raw") params.set("images", "raw");
    const url = `/api/branches/${page.branchId}/export?${params.toString()}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = mode === "zip" ? `${page.slug}.zip` : `${page.slug}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [page?.branchId, page?.slug]);

  // Phase 2: drag-handle block menu + search & replace popup
  const [dragMenu, setDragMenu] = useState<{ x: number; y: number; block: BlockAnchor } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The editor instance is created inside useEditor, so its options can't close
  // over it directly - editorProps.handlePaste resolves it via this ref instead.
  const editorRef = useRef<TiptapEditor | null>(null);

  const engineExtensions = getEditorExtensions();

  const editor = useEditor({
    extensions: [
      ...baseEditorExtensions({
        onCommentActivated: (commentId: string) => {
          // Only open the panel when a comment is actually activated. Deliberately
          // ignoring null keeps the panel open when the user clicks elsewhere in
          // the document, so comments don't "disappear" the moment they deselect
          // the commented text. Close is explicit (✕ / Resolve).
          if (commentId) setActiveCommentId(commentId);
        },
      }),
      ...engineExtensions,
      ...(collabExtensions ?? []),
      // Drag handle + search-and-replace are editing chrome - ProseMirror
      // plugins over the DOM, never part of the shareable schema. They're added
      // unconditionally because the editor is created once and toggled via
      // setEditable (extensions can't be added later); both no-op when
      // view.editable is false (read-only mode).
      ...editingExtensions(),
      WikiLinkExtension,
    ],
    content: undefined,
    editorProps: {
      // Phase 2: convert pasted Markdown to Tiptap content through the same
      // converter the server uses. Returns true when handled.
      handlePaste: (_view, event) => (editorRef.current ? handleMarkdownPaste(editorRef.current, event as ClipboardEvent) : false),
    },
    editable: isEditing && (page?.access === "editor" || page?.access === "admin"),
    onUpdate: ({ editor }) => {
      if (collabEnabled) return; // collab mode handles save via WebSocket
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(editor.getJSON()), 800);
    },
    // The Collaboration extension can only be applied at editor creation time,
    // so the editor is destroyed and re-created when collab mode or the target
    // page changes. (Tiptap's setOptions cannot add extensions to a live editor.)
  }, [collabEnabled, page?.pageId, collabExtensions]);

  // Re-created editors (first mount, collab toggle, page switch) start empty;
  // push the persisted content in when not in collab mode. Deliberately does
  // NOT depend on `page`, so autosave refreshes of `page` don't reset the doc.
  useEffect(() => {
    if (!editor) return;
    if (collabEnabledRef.current) return; // Collaboration extension owns the doc
    const content = pageRef.current?.content;
    if (!content) return;
    editor.commands.setContent(content as any);
    // Re-anchor comment highlights from the comment_threads table (the
    // canonical anchor store). Marks serialized inside the saved doc JSON
    // render automatically, but any thread whose mark was never written into
    // the JSON (e.g. created before the selection-restore fix, or via a
    // collab session) must be re-applied here from its stored range.
    const branchId = pageRef.current?.branchId;
    if (branchId) {
      api
        .getComments(branchId)
        .then((threads) => applyCommentMarksFromThreads(editor, threads))
        .catch(() => {});
    }
  }, [editor]);

  // Phase 2: keep the editor instance available to editorProps (created inside
  // useEditor) and wire the drag-handle click + Ctrl/Cmd+F shortcut.
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom.parentElement;
    if (!el) return;

    const onHandleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".drag-handle")) return;
      e.preventDefault();
      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!pos) return;
      const block = blockAtPos(editor, pos.pos);
      if (!block) return;
      setDragMenu({ x: e.clientX, y: e.clientY, block });
    };

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };

    el.addEventListener("click", onHandleClick);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("click", onHandleClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [editor]);

  // Re-applies a comment mark at each thread's anchor. Phase 1 (§7.12): a
  // thread with a blockId is re-anchored to that block's CURRENT range in the
  // document (the block id is stable across edits, so the highlight follows
  // the content instead of drifting). Threads without a blockId (created before
  // Phase 1) fall back to their stored [rangeFrom, rangeTo]. Anchors that no
  // longer exist in the document are skipped - the thread stays in the DB and
  // the panel, just not highlighted.
  function applyCommentMarksFromThreads(ed: TiptapEditor, threads: CommentThread[]) {
    if (!threads.length) return;
    const maxPos = ed.state.doc.content.size;
    const anchored = new Set<string>();
    ed.state.doc.descendants((node) => {
      if (node.isText && node.marks) {
        for (const m of node.marks) {
          if (m.type.name === "comment" && m.attrs.commentId) anchored.add(m.attrs.commentId as string);
        }
      }
    });
    const missing = threads.filter((t) => !anchored.has(t.id));
    if (!missing.length) return;
    // Preserve the user's selection - re-anchoring must not yank the cursor.
    const prevFrom = ed.state.selection.from;
    const prevTo = ed.state.selection.to;
    for (const t of missing) {
      // Block id is the primary anchor; stored range is the fallback.
      let from: number | null = null;
      let to: number | null = null;
      if (t.blockId) {
        ed.state.doc.descendants((node, pos) => {
          if ((node.attrs as Record<string, unknown>)?.id === t.blockId) {
            from = pos;
            to = pos + node.nodeSize;
            return false;
          }
          return true;
        });
      }
      if (from === null || to === null || from >= to) {
        from = Math.min(Math.max(t.rangeFrom, 1), maxPos);
        to = Math.min(Math.max(t.rangeTo, from + 1), maxPos);
      }
      if (from >= to) continue;
      ed.chain().setTextSelection({ from, to }).setComment(t.id).run();
    }
    ed.commands.setTextSelection({ from: prevFrom, to: prevTo });
  }

  useEffect(() => {
    setPage(null);
    setStatus("idle");
    setHistory(null);
    setIsEditing(false);
    setUseCollabMode(false);
    api.getPage(branchId).then((p) => {
      setPage(p);
      editor?.setEditable(false);
    });
  }, [branchId]);

  useEffect(() => {
    if (!page) return;
    editor?.setEditable(isEditing && (page.access === "editor" || page.access === "admin"));
  }, [isEditing]);

  const save = useCallback(
    async (content: unknown) => {
      if (!page) return;
      setStatus("saving");
      try {
        await api.savePage(page.pageId, page.branchId, content, page.updatedAt);
        const fresh = await api.getPage(branchId);
        setPage(fresh);
        setStatus("saved");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setStatus("conflict");
        } else {
          setStatus("error");
        }
      }
    },
    [page, branchId]
  );

  async function toggleCollab() {
    // Exiting collab mode: the Collaboration extension owns the document while
    // enabled, so persist its current content back to the pages table before
    // the editor is re-created without the extension.
    if (useCollabMode && editor && page) {
      await save(editor.getJSON());
    }
    setUseCollabMode((v) => !v);
  }

  async function reloadAfterConflict() {
    const fresh = await api.getPage(branchId);
    setPage(fresh);
    editor?.commands.setContent(fresh.content as any);
    setStatus("idle");
  }

  async function takeSnapshot() {
    if (!page) return;
    const message = window.prompt("Snapshot message:");
    if (!message) return;
    await api.snapshot(page.pageId, page.branchId, message);
  }

  async function toggleHistory() {
    if (!page) return;
    if (history) {
      setHistory(null);
      return;
    }
    setHistory(await api.getHistory(page.pageId, page.branchId));
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (!page) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await api.uploadFile(page.branchId, file);
    const url = `/api/branches/${page.branchId}/files/${result.id}`;
    if (file.type.startsWith("image/")) {
      editor?.chain().focus().setImage({ src: url, alt: result.filename }).run();
    } else {
      editor?.chain().focus().insertContent(`[${result.filename}](${url})`).run();
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function createShareLink() {
    if (!page) return;
    const hours = window.prompt("Link expires in how many hours? (blank = try no-expiration, requires permission)");
    const expiresAt = hours ? new Date(Date.now() + Number(hours) * 3600_000).toISOString() : null;
    try {
      const result = await api.createShareLink(page.branchId, { permission: "view", expiresAt });
      const url = `${window.location.origin}/share/${result.token}`;
      window.prompt("Share link created - copy it:", url);
    } catch (err) {
      if (err instanceof ApiError) {
        window.alert((err.body as any)?.error ?? "Could not create share link");
      }
    }
  }

  async function addCommentOnSelection() {
    if (!page || !editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const body = window.prompt("Comment:");
    if (!body) return;
    try {
      const selectionText = editor.state.doc.textBetween(from, to, "\n").slice(0, 2000);
      // Phase 1 (§7.12): capture the id of the block containing the selection
      // so the highlight can be re-anchored to it later even if earlier edits
      // shift the character range. `resolve(from).parent` is the innermost
      // node at the selection start - for a text selection inside a paragraph
      // that's the paragraph itself, which carries the UniqueID `id` attr.
      const blockId = (editor.state.doc.resolve(from).parent.attrs as Record<string, unknown>)?.id as
        | string
        | null
        | undefined;
      const { threadId } = await api.createCommentThread(page.branchId, from, to, body, {
        selection: selectionText,
        blockId: blockId ?? undefined,
      });
      // The prompt dialog steals focus and collapses the editor's selection, so
      // applying the mark to the LIVE selection would mark nothing (this is why
      // notes were created with no visible reference). Restore the captured
      // range explicitly before setting the comment mark.
      editor.chain().focus().setTextSelection({ from, to }).setComment(threadId).run();
      setActiveCommentId(threadId);
    } catch (err) {
      if (err instanceof ApiError) {
        window.alert((err.body as any)?.error ?? "Failed to create comment");
      }
    }
  }

  if (!page) return <div className="loading-page">Loading…</div>;
  const canEdit = page.access === "editor" || page.access === "admin";

  const triggerUpload = () => fileInputRef.current?.click();

  return (
    <div className="page-editor" style={{ padding: 24, maxWidth: editorWidth === "full" ? "none" : 760, margin: editorWidth === "full" ? 0 : "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14, alignItems: "center" }}>
        <span className="wiki-page-slug">
          <button onClick={toggleFavorite} className="star-btn" title={favorited ? "Remove favorite" : "Add to favorites"}>{favorited ? "★" : "☆"}</button>
          /{page.slug}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <StatusLabel status={status} />
          <NotificationBell />
          <button onClick={toggleWidth} className="wiki-page-action" title="Toggle full-width / narrow reading width">
            {editorWidth === "full" ? "Narrow view" : "Full width"}
          </button>
          <button onClick={createShareLink} className="wiki-page-action">Share</button>
          <button onClick={() => exportMarkdown("raw")} className="wiki-page-action" title="Export as clean Markdown (SSG-ready)">Export .md</button>
          <button onClick={() => exportMarkdown("zip")} className="wiki-page-action" title="Export with images as a ZIP">Export .zip</button>
        <button onClick={() => setBacklinksOpen((v) => !v)} className={`wiki-page-action${backlinksOpen ? " primary" : ""}`} title="Pages that link to this page">Backlinks</button>
        <button onClick={() => setAttributesOpen((v) => !v)} className={`wiki-page-action${attributesOpen ? " primary" : ""}`} title="Page attributes (labels/tags)">Attributes</button>
          {canEdit && (
            <>
              <button
                onClick={() => setIsEditing((v) => !v)}
                className={`wiki-page-action${isEditing ? " primary" : ""}`}
              >
                {isEditing ? "Done editing" : "Edit"}
              </button>
              {isEditing && (
                <button
                  onClick={toggleCollab}
                  className={`wiki-page-action${useCollabMode ? " success" : ""}`}
                >
                  {useCollabMode ? "Collab ON" : "Collab OFF"}
                </button>
              )}
              <button onClick={() => setPermissionsOpen(true)} className="wiki-page-action">Permissions</button>
              <button onClick={triggerUpload} className="wiki-page-action">Upload file</button>
              <button onClick={takeSnapshot} className="wiki-page-action">Snapshot</button>
            </>
          )}
          <button onClick={toggleHistory} className="wiki-page-action">{history ? "Hide history" : "History"}</button>
        </div>
      </div>

      {permissionsOpen && <PermissionsDialog branchId={page.branchId} onClose={() => setPermissionsOpen(false)} />}
      {backlinksOpen && <BacklinksPanel pageId={page.pageId} onNavigate={(bid) => { window.location.hash = `#/wiki/${bid}`; }} />}
      {attributesOpen && <AttributesPanel branchId={page.branchId} />}

      {status === "conflict" && (
        <div className="wiki-banner">
          Someone else saved this page first.{" "}
          <button className="banner-btn" onClick={reloadAfterConflict}>Reload their version</button>
        </div>
      )}

      {history && (
        <div className="history-panel">
          <div className="history-title">History</div>
          {history.length === 0 && <div>No history yet</div>}
          {history.map((h) => (
            <div key={h.hash} className="history-entry">
              <code>{h.hash.slice(0, 7)}</code> — {h.message}{" "}
              <span className="history-meta">({h.date})</span>
              {canEdit && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(`Restore page content from "${h.message}"? Current content will be replaced.`)) return;
                    const ed = editor;
                    if (!ed) return;
                    ed.setEditable(false);
                    try {
                      await api.restoreHistory(page.pageId, page.branchId, h.hash);
                      const fresh = await api.getPage(page.branchId);
                      setPage(fresh);
                      ed.commands.setContent(fresh.content as any);
                    } catch (err) {
                      console.error("Restore failed", err);
                    } finally {
                      ed.setEditable(true);
                    }
                  }}
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && isEditing && (
        <>
          <Toolbar editor={editor} onUploadImage={triggerUpload} onAddComment={addCommentOnSelection} onSearch={() => setSearchOpen(true)} />
          {searchOpen && editor && <SearchReplacePopup editor={editor} onClose={() => setSearchOpen(false)} />}
        </>
      )}

      {editor && canEdit && isEditing && (
        <BubbleMenu editor={editor}>
          <div className="wiki-bubble-menu">
            <BubbleBtn active={editor.isActive("bold")} label="B" title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} />
            <BubbleBtn active={editor.isActive("italic")} label="I" title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} />
            <BubbleBtn active={editor.isActive("underline")} label="U" title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} />
            <BubbleBtn active={editor.isActive("link")} label="🔗" title="Link" onClick={() => {
              const prev = editor.getAttributes("link").href ?? "";
              const href = window.prompt("URL:", prev);
              if (href === null) return;
              if (href === "") editor.chain().focus().unsetLink().run();
              else editor.chain().focus().setLink({ href }).run();
            }} />
            <BubbleBtn active={false} label="💬" title="Add comment" onClick={addCommentOnSelection} />
          </div>
        </BubbleMenu>
      )}

      <div style={{ display: "flex", gap: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <EditorContent
            editor={editor}
            className="wiki-editor-content"
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              minHeight: 300,
              padding: "12px 16px",
              background: isEditing ? "var(--color-surface)" : "var(--color-bg-secondary)",
            }}
          />
        </div>
        {activeCommentId && (
          <CommentPanel threadId={activeCommentId} branchId={page.branchId} onClose={() => setActiveCommentId(null)} />
        )}
      </div>

      {dragMenu && editor && (
        <DragHandleMenu
          editor={editor}
          block={dragMenu.block}
          x={dragMenu.x}
          y={dragMenu.y}
          onClose={() => setDragMenu(null)}
        />
      )}
    </div>
  );
}

function BubbleBtn({ active, label, title, onClick }: { active: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={active ? "active" : ""}
    >
      {label}
    </button>
  );
}

function StatusLabel({ status }: { status: string }) {
  const label = { idle: "", saving: "Saving…", saved: "Saved", conflict: "Conflict", error: "Error saving" }[status] ?? "";
  const cls = status === "saved" ? "status-saved" : status === "saving" ? "status-saving" : status === "conflict" ? "status-conflict" : status === "error" ? "status-error" : "";
  return <span className={`wiki-status ${cls}`}>{label}</span>;
}
