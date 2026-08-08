import { Fragment, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Bold, Italic, Layers, Link as LinkIcon, MessageSquare, Underline, type LucideIcon } from "lucide-react";
import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { api, ApiError, type PageContent, type HistoryEntry, type CommentThread, type AncestryResult } from "../../api/client.js";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator } from "../../components/ui/breadcrumb.js";
import { Toolbar } from "./Toolbar.js";
import { baseEditorExtensions } from "./baseExtensions.js";
import { editingExtensions } from "./editingExtensions.js";
import { getEditorExtensions } from "./pluginEngine.js";
import "./editorPlugins.js";
import { usePluginState } from "../plugins/pluginRegistry.js";
import { CommentPanel } from "./CommentPanel.js";
import { CommentHoverPopup } from "./CommentHoverPopup.js";
import { PermissionsDialog } from "./PermissionsDialog.js";
import { BacklinksPanel } from "./BacklinksPanel.js";
import { AttributesPanel } from "./AttributesPanel.js";
import { useCollab } from "./useCollab.js";
import { useSession } from "../../api/authClient.js";
import { DragHandleMenu, blockAtPos, type BlockAnchor } from "./DragHandleMenu.js";
import { SearchReplacePopup } from "./SearchReplacePopup.js";
import { handleMarkdownPaste } from "./paste.js";
import { NotificationBell } from "./NotificationBell.js";
import { PageTitleInput } from "./PageTitleInput.js";

const USER_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#be185d", "#4f46e5"];

export function Editor({ branchId }: { branchId: string }) {
  const [page, setPage] = useState<PageContent | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  // UI overhaul B5: the display title has its own debounced save path (it is
  // independent of the body's OCC window), so it keeps a separate state + timer.
  const [title, setTitle] = useState("");
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  // UI overhaul B3: the page icon (reserved `icon` attribute) shown next to the title.
  const [pageIcon, setPageIcon] = useState("");
  // UI overhaul B8: breadcrumb trail (space → ancestors → this page).
  const [ancestry, setAncestry] = useState<AncestryResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession();
  const navigate = useNavigate();

  // Latest page content, tracked in a ref so effects that must NOT reset the
  // editor on every autosave refresh of `page` can still read it.
  const pageRef = useRef<PageContent | null>(null);
  pageRef.current = page;
  // Same idea for the title (B5): `save` is captured by the editor's onUpdate
  // at creation time, so it must read the CURRENT title from a ref instead of
  // a render closure, or a late body autosave would revert a freshly renamed
  // title to the slug-derived value it saw at mount.
  const titleRef = useRef("");
  titleRef.current = title;
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

  // Continuous writing surface: editing is the default state for users with
  // access. "Done editing" still toggles to a read-only view, but the surface
  // does not start in a chrome-changing "view mode".
  const [isEditing, setIsEditing] = useState(true);

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

  // Plugin toggles (§ plugin registry) gate editing chrome and UI panels.
  // Schema-level extensions (baseEditorExtensions) stay registered regardless,
  // because the read-only ShareView and the collab seed schema must still be
  // able to parse pages saved with comment marks / mention nodes.
  const pluginState = usePluginState();
  const slashCommandsEnabled = pluginState["slash-commands"] ?? true;
  const wikiLinksEnabled = pluginState["wiki-links"] ?? true;
  const searchReplaceEnabled = pluginState["search-replace"] ?? true;
  const commentsEnabled = pluginState["page-comments"] ?? true;
  const backlinksEnabled = pluginState["backlinks"] ?? true;
  const historyEnabled = pluginState["page-history"] ?? true;

  const engineExtensions = getEditorExtensions().filter((ext) => {
    if (ext.name === "slashCommand") return slashCommandsEnabled;
    if (ext.name === "wikiLink") return wikiLinksEnabled;
    return true;
  });

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
    if (branchId && commentsEnabled) {
      api
        .getComments(branchId)
        .then((threads) => applyCommentMarksFromThreads(editor, threads))
        .catch(() => {});
    }
  }, [editor, commentsEnabled]);

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
        if (!searchReplaceEnabled) return;
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
  }, [editor, searchReplaceEnabled]);

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
    setUseCollabMode(false);
    setTitle("");
    api.getPage(branchId).then((p) => {
      setPage(p);
      setTitle(p.title ?? "");
      // Continuous surface: start editable whenever the user has access.
      const canEditPage = p.access === "editor" || p.access === "admin";
      setIsEditing(canEditPage);
      editor?.setEditable(canEditPage);
    });
    api.getAncestry(branchId).then(setAncestry).catch(() => setAncestry(null));
  }, [branchId]);

  useEffect(() => {
    if (!page) return;
    editor?.setEditable(isEditing && (page.access === "editor" || page.access === "admin"));
  }, [isEditing]);

  // UI overhaul B5: keep the browser tab title in sync with the page title.
  useEffect(() => {
    document.title = title.trim() ? `${title.trim()} — Wiki` : "Wiki";
    return () => { document.title = "Wiki"; };
  }, [title]);

  // UI overhaul B3: load the page icon from its `icon` attribute and keep it in
  // sync when the AttributesPanel changes it.
  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    const loadIcon = () => {
      fetch(`/api/branches/${branchId}/attributes`, { credentials: "include" })
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setPageIcon((d.attributes ?? []).find((a: { name: string }) => a.name === "icon")?.value ?? "");
        })
        .catch(() => {});
    };
    loadIcon();
    window.addEventListener("wiki-page-icon-changed", loadIcon);
    return () => { cancelled = true; window.removeEventListener("wiki-page-icon-changed", loadIcon); };
  }, [branchId]);

  // The "Upload file" slash command fires this event; route it to the same
  // hidden file input as the toolbar upload button.
  useEffect(() => {
    const onUploadRequest = () => fileInputRef.current?.click();
    window.addEventListener("wiki-upload-request", onUploadRequest);
    return () => window.removeEventListener("wiki-upload-request", onUploadRequest);
  }, []);

  const save = useCallback(async (content: unknown, opts?: { title?: string }) => {
    // Read from refs so the editor's onUpdate (which captures this callback at
    // editor-creation time) always acts on the latest page/title, never the
    // ones it saw on mount.
    const p = pageRef.current;
    if (!p) return;
    setStatus("saving");
    try {
      await api.savePage(p.pageId, p.branchId, content, p.updatedAt, {
        title: opts?.title ?? titleRef.current,
      });
      const fresh = await api.getPage(p.branchId);
      setPage(fresh);
      setTitle(fresh.title ?? "");
      setStatus("saved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStatus("conflict");
      } else {
        setStatus("error");
      }
    }
  }, []);

  // UI overhaul B5: title saves run on their own debounce and always send the
  // title explicitly (never letting the route re-derive it from the body H1).
  function handleTitleChange(next: string) {
    setTitle(next);
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = setTimeout(() => {
      const content = editorRef.current?.getJSON() ?? pageRef.current?.content;
      if (content) void save(content, { title: next });
    }, 600);
  }

  function commitTitle() {
    if (!titleSaveTimer.current) return;
    clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = undefined;
    const content = editorRef.current?.getJSON() ?? pageRef.current?.content;
    if (content) void save(content, { title });
  }

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
    if (!page || !historyEnabled) return;
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
    const ed = editor;
    if (ed) {
      if (file.type.startsWith("image/")) {
        // Always place the image on its own line — never "side by side" with
        // existing text. If the cursor is inside a non-empty paragraph, split
        // it first so the image gets a fresh paragraph; then split again after
        // the image so consecutive uploads stack on new lines instead of
        // interleaving with each other.
        //
        // Run these as separate commands, not chained: Tiptap chained commands
        // share one transaction, and `splitBlock` maps the transaction's
        // already-mapped selection through the mapping a second time, throwing
        // "Position N out of range" once an earlier step has changed the doc.
        // Dispatching each command separately remaps the selection exactly once.
        const parentEmpty = ed.state.selection.$from.parent.textContent.length === 0;
        if (!parentEmpty) ed.commands.splitBlock();
        ed.commands.setImage({ src: url, alt: result.filename });
        ed.commands.splitBlock();
      } else {
        // Real attachment node (icon + name + hover-to-see-full-name), not a
        // bare text link. Block-level, so ProseMirror splits the paragraph and
        // the file always lands on its own line.
        ed.chain()
          .focus()
          .insertContent({
            type: "attachment",
            attrs: { url, name: result.filename, mime: file.type, size: file.size },
          })
          .run();
      }
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
    if (!page || !editor || !commentsEnabled) return;
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
    <div className="page-editor" style={{ padding: 24 }}>
      {/* B8 breadcrumb trail: Space → ancestors → current page, each clickable
          (the current page renders as the non-clickable last segment). */}
      {ancestry && (
        <div className="wiki-breadcrumb-row">
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              <BreadcrumbItem>
                {ancestry.trail.length > 1 ? (
                  <BreadcrumbLink
                    className="inline-flex items-center gap-1"
                    onClick={() => navigate(`/pages/${ancestry.trail[0]!.id}`)}
                  >
                    <Layers aria-hidden className="breadcrumb-space-icon h-3.5 w-3.5" />
                    {ancestry.space.name}
                  </BreadcrumbLink>
                ) : (
                  <span className="inline-flex items-center gap-1 text-text-muted">
                    <Layers aria-hidden className="breadcrumb-space-icon h-3.5 w-3.5" />
                    {ancestry.space.name}
                  </span>
                )}
              </BreadcrumbItem>
              {ancestry.trail.map((seg, i) => {
                const isLast = i === ancestry.trail.length - 1;
                return (
                  <Fragment key={seg.id}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      {isLast ? (
                        <BreadcrumbPage className="inline-flex min-w-0 items-center gap-1">
                          {seg.icon && <span aria-hidden>{seg.icon}</span>}
                          <span className="truncate">{seg.title || seg.slug}</span>
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          className="inline-flex min-w-0 items-center gap-1"
                          onClick={() => navigate(`/pages/${seg.id}`)}
                        >
                          {seg.icon && <span aria-hidden>{seg.icon}</span>}
                          <span className="truncate">{seg.title || seg.slug}</span>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
          <span className="wiki-last-edited">Edited {fmtEdited(page.updatedAt)}</span>
        </div>
      )}
      {/* Header stays full-width; only the reading canvas narrows below. */}
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
        {backlinksEnabled && (
          <button onClick={() => setBacklinksOpen((v) => !v)} className={`wiki-page-action${backlinksOpen ? " primary" : ""}`} title="Pages that link to this page">Backlinks</button>
        )}
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
              {/* Hidden input: the toolbar "Upload file" button triggers it via
                  triggerUpload(). That button only renders while editing, so the
                  page cannot be modified from view mode. */}
              <input ref={fileInputRef} type="file" onChange={uploadFile} style={{ display: "none" }} />
              <button onClick={takeSnapshot} className="wiki-page-action">Snapshot</button>
            </>
          )}
          {historyEnabled && (
            <button onClick={toggleHistory} className="wiki-page-action">{history ? "Hide history" : "History"}</button>
          )}
        </div>
      </div>

      {permissionsOpen && <PermissionsDialog branchId={page.branchId} onClose={() => setPermissionsOpen(false)} />}
      {backlinksEnabled && backlinksOpen && <BacklinksPanel pageId={page.pageId} onNavigate={(bid) => navigate(`/pages/${bid}`)} />}
      {attributesOpen && <AttributesPanel branchId={page.branchId} />}

      {status === "conflict" && (
        <div className="wiki-banner">
          Someone else saved this page first.{" "}
          <button className="banner-btn" onClick={reloadAfterConflict}>Reload their version</button>
        </div>
      )}

      {historyEnabled && history && (
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
          <Toolbar editor={editor} onUploadFile={triggerUpload} onAddComment={commentsEnabled ? addCommentOnSelection : () => {}} onSearch={searchReplaceEnabled ? () => setSearchOpen(true) : () => {}} showSearch={searchReplaceEnabled} showComment={commentsEnabled} />
          {searchReplaceEnabled && searchOpen && editor && <SearchReplacePopup editor={editor} onClose={() => setSearchOpen(false)} />}
        </>
      )}

      {editor && canEdit && isEditing && (
        <BubbleMenu editor={editor}>
          <div className="wiki-bubble-menu">
            <BubbleBtn active={editor.isActive("bold")} icon={Bold} title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} />
            <BubbleBtn active={editor.isActive("italic")} icon={Italic} title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} />
            <BubbleBtn active={editor.isActive("underline")} icon={Underline} title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} />
            <BubbleBtn active={editor.isActive("link")} icon={LinkIcon} title="Link" onClick={() => {
              const prev = editor.getAttributes("link").href ?? "";
              const href = window.prompt("URL:", prev);
              if (href === null) return;
              if (href === "") editor.chain().focus().unsetLink().run();
              else editor.chain().focus().setLink({ href }).run();
            }} />
            {commentsEnabled && <BubbleBtn active={false} icon={MessageSquare} title="Add comment" onClick={addCommentOnSelection} />}
          </div>
        </BubbleMenu>
      )}

      {/* Reading canvas: the only part that narrows. Header + toolbar above stay
          full width. The comment panel is sticky so it follows the viewport
          instead of staying pinned to the top of the (possibly long) document. */}
      <div
        className="wiki-canvas"
        style={{
          maxWidth: editorWidth === "full" ? "none" : 780,
          margin: editorWidth === "full" ? 0 : "0 auto",
        }}
      >
        <div className="wiki-page-heading-row">
          {pageIcon && <span className="wiki-page-icon-large" aria-hidden>{pageIcon}</span>}
          <PageTitleInput
            value={title}
            onChange={handleTitleChange}
            editable={canEdit}
            onCommit={commitTitle}
          />
        </div>
        <div style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <EditorContent
              editor={editor}
              className="wiki-editor-content"
              style={{
                // Full-bleed writing surface: no card frame around the canvas.
                minHeight: 300,
              }}
            />
          </div>
          {commentsEnabled && activeCommentId && (
            <CommentPanel threadId={activeCommentId} branchId={page.branchId} onClose={() => setActiveCommentId(null)} />
          )}
        </div>
      </div>

      {/* Siyuan-style hover preview: hovering a highlight shows the comment
          inline; clicking the highlight (or the popup) opens the side panel. */}
      {commentsEnabled && (
        <CommentHoverPopup
          branchId={page.branchId}
          onOpen={(id) => setActiveCommentId(id)}
        />
      )}

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

function BubbleBtn({ active, icon: Icon, title, onClick }: { active: boolean; icon: LucideIcon; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={active ? "active" : ""}
    >
      <Icon aria-hidden />
    </button>
  );
}

function StatusLabel({ status }: { status: string }) {
  const label = { idle: "", saving: "Saving…", saved: "Saved", conflict: "Conflict", error: "Error saving" }[status] ?? "";
  const cls = status === "saved" ? "status-saved" : status === "saving" ? "status-saving" : status === "conflict" ? "status-conflict" : status === "error" ? "status-error" : "";
  return <span className={`wiki-status ${cls}`}>{label}</span>;
}

/** B8: relative "last edited" timestamp, e.g. "just now", "5m ago", "2h ago", "3d ago". */
function fmtEdited(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
