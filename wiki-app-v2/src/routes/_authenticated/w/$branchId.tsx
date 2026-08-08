import { useState, useCallback, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Pencil, Eye, Loader2 } from "lucide-react";

import { api, type PageData } from "@/api/client";
import { PageEditor, type PageEditorHandle } from "@/features/editor/Editor";
import { useAutosave, saveStateLabel } from "@/features/editor/useAutosave";
import { useQuery } from "@/lib/useQuery";

export const Route = createFileRoute("/_authenticated/w/$branchId")({
  component: PageView,
});

function PageView() {
  const { branchId } = Route.useParams();
  const [editMode, setEditMode] = useState(false);

  const { data: page, loading, error, reload } = useQuery(
    () => api.getPage(branchId),
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

  return (
    <div className="flex h-full flex-col">
      <PageHeader page={page} icon={iconAttr?.value} editMode={editMode} onToggleEdit={() => setEditMode((m) => !m)} />
      {editMode ? (
        <EditableCanvas page={page} key={page.id} onConflict={() => reload()} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="editor-canvas">
            <div className="wiki-prose">
              <ReadOnlyContent page={page} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PageHeader({
  page,
  icon,
  editMode,
  onToggleEdit,
}: {
  page: PageData;
  icon?: string;
  editMode: boolean;
  onToggleEdit: () => void;
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

function ReadOnlyContent({ page }: { page: PageData }) {
  return <PageContentRenderer content={page.content} />;
}

// ---------------------------------------------------------------------------
// Simple server-rendering-safe content renderer. Walks Tiptap JSON nodes into
// semantic HTML. No editor instance, no dangerouslySetInnerHTML.
// ---------------------------------------------------------------------------

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function PageContentRenderer({ content }: { content: unknown }) {
  const doc = content as PMNode | null;
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return null;

  return <>{doc.content.map((node, i) => <BlockNode key={i} node={node} />)}</>;
}

function InlineNode({ node }: { node: PMNode }) {
  if (node.type === "text") {
    let text: React.ReactNode = node.text ?? "";
    if (node.marks) {
      for (const m of node.marks) {
        if (m.type === "bold") text = <strong>{text}</strong>;
        if (m.type === "italic") text = <em>{text}</em>;
        if (m.type === "underline") text = <u>{text}</u>;
        if (m.type === "strike") text = <s>{text}</s>;
        if (m.type === "code") text = <code>{text}</code>;
        if (m.type === "link") {
          const href = (m.attrs?.href as string) ?? "#";
          text = <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{text}</a>;
        }
      }
    }
    return <>{text}</>;
  }
  if (node.type === "hardBreak") return <br />;
  return null;
}

function BlockNode({ node }: { node: PMNode }) {
  const children = Array.isArray(node.content)
    ? node.content.map((n, i) => <InlineNode key={i} node={n} />)
    : null;

  switch (node.type) {
    case "paragraph":
      return children ? <p>{children}</p> : <p>&nbsp;</p>;
    case "heading": {
      const level = (node.attrs?.level as number) ?? 2;
      if (level === 1) return children ? <h1 id={node.attrs?.id as string | undefined}>{children}</h1> : null;
      if (level === 2) return children ? <h2 id={node.attrs?.id as string | undefined}>{children}</h2> : null;
      if (level === 3) return children ? <h3 id={node.attrs?.id as string | undefined}>{children}</h3> : null;
      return children ? <h4 id={node.attrs?.id as string | undefined}>{children}</h4> : null;
    }
    case "bulletList":
      return <ul>{node.content?.map((n, i) => <BlockNode key={i} node={n} />)}</ul>;
    case "orderedList":
      return <ol>{node.content?.map((n, i) => <BlockNode key={i} node={n} />)}</ol>;
    case "listItem":
      return <li>{children}</li>;
    case "blockquote":
      return <blockquote>{node.content?.map((n, i) => <BlockNode key={i} node={n} />)}</blockquote>;
    case "codeBlock":
      return <pre><code>{node.content?.map((n) => n.text).join("\n")}</code></pre>;
    case "horizontalRule":
      return <hr />;
    default:
      return children ? <div>{children}</div> : null;
  }
}

// ---------------------------------------------------------------------------
// Editable canvas — Tiptap editor with OCC autosave.
// ---------------------------------------------------------------------------

function EditableCanvas({ page, onConflict }: { page: PageData; onConflict: () => void }) {
  const editorRef = useRef<PageEditorHandle>(null);

  const getContent = useCallback(() => editorRef.current?.getJSON() ?? page.content, [page.content]);
  const getTitle = useCallback(() => undefined, []);

  const { state: saveState, scheduleSave, saveNow } = useAutosave({
    branchId: page.branchId,
    initialUpdatedAt: new Date(page.updatedAt),
    getContent,
    getTitle,
    onSaved: (_next: Date) => {},
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
        content={page.content}
        editable
        onUpdate={handleUpdate}
      />
      <div className="flex items-center justify-between border-t border-border px-4 py-1 text-xs text-text-muted">
        <span>{saveStateLabel(saveState)}</span>
        <div className="flex items-center gap-3">
          <span>{page.slug}</span>
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
