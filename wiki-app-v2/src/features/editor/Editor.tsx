import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Heading1, Heading2, Heading3,
  List, ListOrdered, Quote, Code, Undo2, Redo2, Workflow, Upload, Loader2, MessageSquare,
  ListChecks, AlignLeft, AlignCenter, AlignRight, AlignJustify, Highlighter, Search,
} from "lucide-react";

import { baseExtensions, stripWordHTML } from "./editorExtensions.js";
import { editingExtensions } from "./editingExtensions.js";
import { useCollab, type CollabUser } from "./useCollab.js";
import { useTiptapExtensions, useToolbarItems } from "@/plugins/registry";
import { SlashMenuExtension, SlashMenu } from "./SlashMenu.js";
import { insertMermaidDiagram } from "./extensions/mermaidInsert.js";
import { CommentHighlight, bumpCommentHighlights, type CommentThreadLite } from "./extensions/commentHighlight.js";
import { SearchReplacePopup } from "./SearchReplacePopup.js";
import { CommentHoverBubble } from "./CommentHoverBubble.js";
import { useMentionExtension } from "./extensions/mentionExtension.jsx";
import type { CommentThread } from "@/api/client";
import { api } from "@/api/client";
import { KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES, filterUnknownNodes } from "@/shared/blockIds";
import type { JSONBlock } from "@/shared/blockIds";
import { cn } from "@/lib/utils";

export interface PageEditorHandle {
  getJSON: () => unknown;
}

export interface InlineCommentSelection {
  blockId: string;
  rangeFrom: number;
  rangeTo: number;
  selection: string;
}

function captureInlineComment(editor: Editor): InlineCommentSelection | null {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    const id = node.attrs?.id;
    if (typeof id === "string") {
      const blockStart = $from.before(depth);
      return {
        blockId: id,
        rangeFrom: Math.max(0, from - blockStart),
        rangeTo: Math.max(0, to - blockStart),
        selection: state.doc.textBetween(from, to, " ").slice(0, 2000),
      };
    }
  }
  return null;
}

/**
 * The single-pane editor canvas (§6).
 *
 * STRUCTURAL RULE (this is the regression test from §6.3, enforced by design):
 * - Exactly ONE bordered container exists around the writing surface: the
 *   `.editor-canvas` wrapper around <EditorContent>. No second container
 *   appears on focus, on selection, or as a side effect of any plugin UI.
 * - All positioned UI (toolbar, bubble menu) is a SIBLING of the canvas, never
 *   a parent of the content. The bubble menu renders through a portal outside
 *   the ProseMirror root and positions itself with fixed coordinates.
 * - There is no drag-handle wrapper, no NodeSelection highlight box, nothing
 *   that wraps a node to "anchor" UI to it.
 */
export const PageEditor = forwardRef<PageEditorHandle, {
  content: unknown;
  editable: boolean;
  onUpdate?: () => void;
  branchId?: string;
  onInlineComment?: (sel: InlineCommentSelection) => void;
  commentThreads?: readonly CommentThreadLite[];
  onCommentThreadClick?: (threadId: string) => void;
  extensions?: ReturnType<typeof baseExtensions>;
  fullCommentThreads?: CommentThread[];
}>(function PageEditor({ content, editable, onUpdate, branchId, onInlineComment, commentThreads, onCommentThreadClick, extensions, fullCommentThreads }, ref) {
  const registryExtensions = useTiptapExtensions();
  const toolbarItems = useToolbarItems();
  // Phase 4 fix: wire the @mention suggestion popup. The schema-only Mention
  // in baseExtensions has suggestion: undefined (correct for read-only/collab-
  // seed paths). Here in the live editor we replace it with the popup-enabled
  // version so typing @ shows a user picker.
  const mentionExt = useMentionExtension();

  // Sanitize content: convert node types unknown to the current schema into
  // paragraphs so Tiptap never throws on a disabled plugin's saved nodes (§4.4).
  const sanitizedContent = useMemo(() => {
    if (!content) return content;
    const doc = content as JSONBlock;
    if (doc.type !== "doc") return content;
    const pluginNodeNames = new Set(registryExtensions.map(e => e.name));
    const blockTypes = new Set([...KNOWN_BLOCK_TYPES, ...pluginNodeNames]);
    return filterUnknownNodes(doc, blockTypes, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
  }, [content, registryExtensions]);

  const allExtensions = useMemo(() => {
    // Filter out the schema-only Mention from baseExtensions; replace with
    // the popup-enabled one from useMentionExtension.
    const base = (extensions ?? baseExtensions()).filter(e => e.name !== "mention");
    const e = [
      ...base,
      mentionExt,
      ...registryExtensions,
      SlashMenuExtension,
      CommentHighlight.configure({
        // `commentThreads` is read live on every PM transaction so a just-added
        // thread shows the highlight without an editor remount. The prop is
        // captured in the closure; updates bump it on re-render.
        getThreads: () => commentThreads ?? [],
      }),
      ...(editable ? editingExtensions() : []),
    ];
    return e;
  }, [extensions, registryExtensions, editable, mentionExt]);

  const editor = useEditor({
    extensions: allExtensions,
    content: sanitizedContent as never,
    editable,
    editorProps: {
      attributes: {
        class: "editor-content wiki-prose",
      },
      transformPastedHTML: stripWordHTML,
    },
    onUpdate: () => onUpdate?.(),
  });

  useImperativeHandle(ref, () => ({
    getJSON: () => editor?.getJSON() ?? content,
  }), [editor, content]);

  // Whenever the threads prop changes, nudge the plugin so the latest
  // reference (and any newly added thread) is reflected in decorations. The
  // dispatch is a no-op transaction; it never mutates the doc.
  useEffect(() => {
    const view = editor?.view;
    if (!view) return;
    bumpCommentHighlights(view, commentThreads ?? []);
  }, [editor, commentThreads]);

  // Phase 2.8 — Ctrl/Cmd+F opens the find & replace popup.
  const [showSearch, setShowSearch] = useState(false);
  useEffect(() => {
    if (!editable) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); setShowSearch(true); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editable]);

  // Capture clicks on highlighted ranges before the editor's own click handler
  // turns them into a selection that destroys the inline decoration.
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = editorHostRef.current;
    if (!root || !onCommentThreadClick) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId: string }>).detail;
      if (!detail?.threadId) return;
      onCommentThreadClick(detail.threadId);
    };
    root.addEventListener("comment-highlight-click", handler);
    return () => root.removeEventListener("comment-highlight-click", handler);
  }, [onCommentThreadClick]);

  return (
    <div className="flex min-h-0 flex-1 flex-col relative">
      {editable && editor && (
        <EditorToolbar editor={editor} pluginItems={toolbarItems} branchId={branchId} onOpenSearch={() => setShowSearch(true)} />
      )}
      {editable && editor && (
        <BubbleMenu editor={editor}>
          <InlineToolbar editor={editor} onComment={onInlineComment} />
        </BubbleMenu>
      )}
      {editable && editor && <SlashMenu editor={editor} />}
      {editable && editor && showSearch && (
        <SearchReplacePopup editor={editor} onClose={() => setShowSearch(false)} />
      )}
      {/* Phase 4.1 — Comment hover bubble. Shows a rich popup when hovering
          over commented text. Only mounted when full comment threads are
          available (the editable page view passes them; read-only doesn't). */}
      {editable && editor && fullCommentThreads && fullCommentThreads.length > 0 && (
        <CommentHoverBubble editor={editor} threads={fullCommentThreads} />
      )}
      {/* The scroll container is the OUTER wrapper; .editor-canvas owns the
          border + width, the drag handle, and must NOT be overflow-clipped
          (§6.2 — the block drag handle is positioned at left:-24px so the
          editor surface area must be visible outside the canvas box). */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="editor-canvas">
          <div ref={editorHostRef}>
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Live-collaboration variant (§8 step 11). Mounts a Hocuspocus session for the
 * branch and swaps the editor onto the Collaboration + CollaborationCaret
 * extensions over the SAME base schema the server seeds with, so node/mark
 * sets (including block ids) match exactly. Autosave is intentionally absent:
 * the server's onStoreDocument write-back persists collab content.
 */
export function CollabEditor({
  documentName,
  user,
}: {
  documentName: string;
  user: CollabUser;
}) {
  const session = useCollab(documentName);
  const registryExtensions = useTiptapExtensions();
  const extensions = useMemo(
    () => [
      ...baseExtensions(),
      ...registryExtensions,
      SlashMenuExtension,
      Collaboration.configure({ document: session.doc, field: "default" }),
      CollaborationCaret.configure({ provider: session.provider, user }),
    ],
    [session.doc, session.provider, user, registryExtensions],
  );

  const { status, isSynced } = session;
  const label =
    status === "connected" && isSynced
      ? "Live collaboration — synced"
      : status === "connected"
        ? "Live collaboration — syncing…"
        : "Live collaboration — reconnecting…";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageEditor content={undefined} editable extensions={extensions} />
      <div className="flex items-center gap-2 border-t border-border px-4 py-1 text-xs text-text-muted">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            status === "connected" && isSynced
              ? "bg-success"
              : status === "connected"
                ? "bg-warning"
                : "bg-danger",
          )}
          aria-hidden
        />
        <span>{label}</span>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors",
        "text-text-secondary hover:bg-surface-hover hover:text-foreground",
        active && "bg-primary/15 text-primary",
        disabled && "opacity-40 pointer-events-none"
      )}
    >
      {children}
    </button>
  );
}

function EditorToolbar({ editor, pluginItems, branchId, onOpenSearch }: {
  editor: Editor;
  pluginItems: ReturnType<typeof useToolbarItems>;
  branchId?: string;
  onOpenSearch?: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Editor width cycle: Narrow → Default → Wide → Full → Narrow
  const [editorWidth, setEditorWidth] = useState("72ch");
  useEffect(() => {
    void api.getUserSettings().then((rows) => {
      const row = rows.find((r) => r.key === "editor.width");
      if (row && typeof row.value === "string") setEditorWidth(row.value);
    }).catch(() => {});
  }, []);
  const cycleWidth = () => {
    const widths = ["60ch", "72ch", "90ch", "100%"];
    const idx = widths.indexOf(editorWidth);
    const next = widths[(idx + 1) % widths.length] ?? "72ch";
    setEditorWidth(next);
    document.documentElement.style.setProperty("--editor-width", next);
    void api.setUserSetting("editor.width", next);
  };
  const widthLabel: Record<string, string> = { "60ch": "Narrow", "72ch": "Default", "90ch": "Wide", "100%": "Full" };

  const handleFile = async (file: File | undefined) => {
    if (!file || !branchId) return;
    setUploading(true);
    try {
      const { id, filename } = await api.uploadFile(branchId, file);
      const url = `/api/branches/${branchId}/files/${id}`;
      const isImage = file.type.startsWith("image/");
      editor.chain().focus();
      if (isImage) {
        editor.chain().insertContent({ type: "image", attrs: { src: url, alt: filename, title: filename } }).run();
      } else {
        editor.chain().insertContent({ type: "attachment", attrs: { url, name: filename, mime: file.type, size: file.size } }).run();
      }
    } catch {
      // The ApiError detail is surfaced via the autosave/error toast elsewhere;
      // keep the editor usable if the upload fails.
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const buttons = (
    <>
      <ToolbarButton title="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {branchId && (
        <>
          <ToolbarButton title="Upload file" onClick={() => fileInputRef.current?.click()}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </ToolbarButton>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-label="Upload file"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        </>
      )}
      <ToolbarButton title="Heading 1" active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Heading 2" active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton title="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Inline code" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Underline" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton title="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Blockquote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Code block" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Mermaid diagram" onClick={() => insertMermaidDiagram(editor)}>
        <Workflow className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton title="Task list" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListChecks className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton title="Align left" active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()}>
        <AlignLeft className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Align center" active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}>
        <AlignCenter className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Align right" active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}>
        <AlignRight className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Justify" active={editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().setTextAlign("justify").run()}>
        <AlignJustify className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton title="Highlight" active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()}>
        <Highlighter className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Find & replace (Ctrl+F)" onClick={() => onOpenSearch?.()}>
        <Search className="h-4 w-4" />
      </ToolbarButton>
      {/* Editor width toggle — cycles Narrow → Default → Wide → Full */}
      <button
        type="button"
        onClick={cycleWidth}
        className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-text-secondary hover:bg-surface-hover transition-colors"
        title={`Editor width: ${widthLabel[editorWidth] ?? "Default"} (click to cycle)`}
        aria-label={`Editor width: ${widthLabel[editorWidth] ?? "Default"}`}
        data-testid="editor-width-toggle"
      >
        {widthLabel[editorWidth] ?? "Default"}
      </button>
      {pluginItems.length > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden />}
      {pluginItems.map(item => (
        <ToolbarButton
          key={item.id}
          title={item.label}
          active={item.isActive?.(editor)}
          onClick={() => item.onPress(editor)}
        >
          {item.icon ?? <span className="text-xs">{item.label}</span>}
        </ToolbarButton>
      ))}
    </>
  );

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-2 py-1" aria-label="Formatting toolbar">
      {buttons}
    </div>
  );
}

function InlineToolbar({ editor, onComment }: { editor: Editor; onComment?: (sel: InlineCommentSelection) => void }) {
  const comment = captureInlineComment(editor);
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-elevated px-1.5 py-1 shadow-lg">
      <ToolbarButton title="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Underline" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-4 w-4" />
      </ToolbarButton>
      {onComment && (
        <>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <ToolbarButton
            title="Add comment"
            disabled={!comment}
            onClick={() => comment && onComment(comment)}
          >
            <MessageSquare className="h-4 w-4" />
          </ToolbarButton>
        </>
      )}
    </div>
  );
}
