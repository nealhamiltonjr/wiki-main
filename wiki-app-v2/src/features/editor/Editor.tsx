import { forwardRef, useImperativeHandle, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Heading1, Heading2,
  List, ListOrdered, Quote, Code, Undo2, Redo2, Workflow,
} from "lucide-react";

import { baseExtensions, stripWordHTML } from "./editorExtensions.js";
import { useCollab, type CollabUser } from "./useCollab.js";
import { useTiptapExtensions, useToolbarItems } from "@/plugins/registry";
import { SlashMenuExtension, SlashMenu } from "./SlashMenu.js";
import { insertMermaidDiagram } from "./extensions/mermaidInsert.js";
import { KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES, filterUnknownNodes } from "@/shared/blockIds";
import type { JSONBlock } from "@/shared/blockIds";
import { cn } from "@/lib/utils";

export interface PageEditorHandle {
  getJSON: () => unknown;
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
  extensions?: ReturnType<typeof baseExtensions>;
}>(function PageEditor({ content, editable, onUpdate, extensions }, ref) {
  const registryExtensions = useTiptapExtensions();
  const toolbarItems = useToolbarItems();

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

  const allExtensions = useMemo(() => [
    ...(extensions ?? baseExtensions()),
    ...registryExtensions,
    SlashMenuExtension,
  ], [extensions, registryExtensions]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col relative">
      {editable && editor && (
        <EditorToolbar editor={editor} pluginItems={toolbarItems} />
      )}
      {editable && editor && (
        <BubbleMenu editor={editor}>
          <InlineToolbar editor={editor} />
        </BubbleMenu>
      )}
      {editable && editor && <SlashMenu editor={editor} />}
      <div className="editor-canvas min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} />
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

function EditorToolbar({ editor, pluginItems }: { editor: Editor; pluginItems: ReturnType<typeof useToolbarItems> }) {
  const buttons = (
    <>
      <ToolbarButton title="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton title="Heading 1" active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Heading 2" active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-4 w-4" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
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

function InlineToolbar({ editor }: { editor: Editor }) {
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
    </div>
  );
}
