import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tree as ArboristTree, type NodeRendererProps } from "react-arborist";
import { ChevronRight, Copy, Edit3, MoveRight, Pin, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

import { api, type SpaceSummary, type TreeNode } from "../../api/client.js";
import { cn } from "@/lib/utils";

function useContainerSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * Flatten the tree's branches in source order (parent before children) so
 * the "Move to..." dialog can offer every other branch as a candidate
 * parent without recursing through the arborist internals at click time.
 */
function flattenBranches(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children?.length) flattenBranches(n.children, out);
  }
  return out;
}

type CtxTarget = {
  branchId: string;
  pageId: string;
  slug: string;
  hasChildren: boolean;
  x: number;
  y: number;
};

type Dialog =
  | { kind: "rename"; target: CtxTarget }
  | { kind: "move"; target: CtxTarget }
  | { kind: "delete"; target: CtxTarget }
  | null;

function WikiTreeNode({
  node,
  style,
  onContextMenu,
}: NodeRendererProps<TreeNode> & { onContextMenu: (target: CtxTarget) => void }) {
  return (
    <div
      style={{ ...style, margin: 0, display: "flex", alignItems: "center" }}
      className={cn("wiki-tree-item", node.isSelected && "selected")}
      onClick={() => { if (node.isInternal) node.toggle(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        node.select();
        onContextMenu({
          branchId: node.data.id,
          pageId: node.data.pageId,
          slug: node.data.slug,
          hasChildren: (node.data.children?.length ?? 0) > 0,
          x: e.clientX,
          y: e.clientY,
        });
      }}
      data-branch-id={node.data.id}
      data-slug={node.data.slug}
    >
      {node.isInternal ? (
        <button
          type="button"
          className={cn("tree-chevron", node.isOpen && "collapsed")}
          onClick={(e) => { e.stopPropagation(); node.toggle(); }}
          title={node.isOpen ? "Collapse" : "Expand"}
          aria-label={node.isOpen ? "Collapse" : "Expand"}
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      ) : (
        <span className="tree-chevron-spacer" aria-hidden />
      )}
      <span className="tree-label" title={node.data.slug}>
        {node.data.icon ? (
          <span className="tree-page-icon" aria-hidden>{node.data.icon}</span>
        ) : (
          <span className="tree-page-dot" aria-hidden />
        )}
        {node.data.slug}
      </span>
    </div>
  );
}

export function Tree() {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [activeSpace, setActiveSpace] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [containerRef, containerSize] = useContainerSize<HTMLDivElement>();

  const [ctx, setCtx] = useState<CtxTarget | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listSpaces().then((s) => {
      setSpaces(s);
      setActiveSpace((prev) => (prev && s.some((x) => x.id === prev) ? prev : (s[0]?.id ?? null)));
    }).catch(() => setSpaces([]));
  }, []);

  const refresh = useCallback(async () => {
    if (!activeSpace) return;
    try {
      const fresh = await api.getSpaceTree(activeSpace);
      setTree(fresh);
    } catch {
      // Best-effort refresh; the next action or page reload will recover.
    }
  }, [activeSpace]);

  useEffect(() => {
    if (activeSpace) api.getSpaceTree(activeSpace).then(setTree).catch(() => setTree([]));
  }, [activeSpace]);

  // Click outside + Escape for the floating context menu & dialogs.
  useEffect(() => {
    if (!ctx && !dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtx(null);
        setDialog(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const inMenu = ctx && target && document.querySelector("[data-tree-menu]")?.contains(target);
      const inDialog =
        dialog && target && (document.querySelector("[data-tree-dialog]")?.contains(target) ?? false);
      if (!inMenu && !inDialog) {
        setCtx(null);
        setDialog(null);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [ctx, dialog]);

  async function handleCreatePage() {
    if (!activeSpace) return;
    const slug = window.prompt("New page slug (letters, digits, - _ .):");
    if (!slug) return;
    try {
      const { branchId } = await api.createPage(activeSpace, { slug });
      await refresh();
      navigate({ to: "/w/$branchId", params: { branchId } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create page";
      toast.error(message);
    }
  }

  const flattened = useMemo(() => flattenBranches(tree), [tree]);

  return (
    <div className="wiki-sidebar">
      <div className="wiki-sidebar-controls">
        <div className="flex gap-1">
          <select
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            value={activeSpace ?? ""}
            onChange={(e) => setActiveSpace(e.target.value)}
            aria-label="Active space"
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleCreatePage}
            disabled={!activeSpace}
            className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-surface-hover disabled:opacity-50"
            title="New page in this space"
            data-testid="sidebar-new-page"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        </div>
      </div>

      <div className="wiki-tree" ref={containerRef}>
        {containerSize.width > 0 && containerSize.height > 0 && tree.length > 0 && (
          <ArboristTree<TreeNode>
            data={tree}
            width={containerSize.width}
            height={containerSize.height}
            rowHeight={28}
            indent={18}
            padding={4}
            openByDefault
            disableMultiSelection
            onActivate={(node) => navigate({ to: "/w/$branchId", params: { branchId: node.data.id } })}
            aria-label="Pages tree"
          >
            {(props) => <WikiTreeNode {...props} onContextMenu={setCtx} />}
          </ArboristTree>
        )}
        {tree.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">This space is empty.</div>
        )}
      </div>

      {activeSpace && (
        <button
          type="button"
          onClick={() => navigate({ to: "/trash/$spaceId", params: { spaceId: activeSpace } })}
          className="mt-1 flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-muted hover:text-foreground"
          data-testid="trash-sidebar-link"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Trash
        </button>
      )}
      <button
        type="button"
        onClick={() => navigate({ to: "/pinned" })}
        className="mt-1 flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-muted hover:text-foreground"
        data-testid="pinned-sidebar-link"
      >
        <Pin className="h-3.5 w-3.5" />
        Pinned
      </button>

      {ctx &&
        createPortal(
          <ContextMenu
            target={ctx}
            position={{ x: ctx.x, y: ctx.y }}
            onClose={() => setCtx(null)}
            onAction={(kind) => {
              setDialog({ kind, target: ctx });
              setCtx(null);
            }}
            onDuplicate={async () => {
              if (!activeSpace) return;
              try {
                await api.clonePage(ctx.branchId, {
                  targetSpaceId: activeSpace,
                  targetParentBranchId: null,
                });
                toast.success("Duplicated");
                await refresh();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Duplicate failed");
              } finally {
                setCtx(null);
              }
            }}
          />,
          document.body,
        )}

      {dialog &&
        createPortal(
          <ActionDialog
            dialog={dialog}
            candidates={flattened.filter(
              (n) => n.id !== dialog.target.branchId && !dialog.target.hasChildren,
            )}
            onClose={() => {
              setDialog(null);
              dialogRef.current = null;
            }}
            onCommitted={() => {
              setDialog(null);
              dialogRef.current = null;
              refresh();
            }}
            innerRef={dialogRef}
          />,
          document.body,
        )}
    </div>
  );
}

function ContextMenu({
  target,
  position,
  onClose,
  onAction,
  onDuplicate,
}: {
  target: CtxTarget;
  position: { x: number; y: number };
  onClose: () => void;
  onAction: (kind: "rename" | "move" | "delete") => void;
  onDuplicate: () => void;
}) {
  // Clamp position so the menu doesn't escape the viewport.
  const left = Math.min(position.x, window.innerWidth - 200);
  const top = Math.min(position.y, window.innerHeight - 200);

  return (
    <div
      data-tree-menu
      role="menu"
      aria-label="Page actions"
      className="fixed z-50 min-w-48 rounded-md border border-border bg-surface text-sm shadow-lg"
      style={{ left, top }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onAction("rename")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        <Edit3 className="h-3.5 w-3.5" /> Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDuplicate}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        <Copy className="h-3.5 w-3.5" /> Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onAction("move")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        <MoveRight className="h-3.5 w-3.5" /> Move to...
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        onClick={() => onAction("delete")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-danger hover:bg-danger/10"
        disabled={target.hasChildren}
        title={target.hasChildren ? "Remove children first" : undefined}
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
      <button
        type="button"
        onClick={onClose}
        className="sr-only"
        aria-hidden
        tabIndex={-1}
      >
        Close
      </button>
    </div>
  );
}

function ActionDialog({
  dialog,
  candidates,
  onClose,
  onCommitted,
  innerRef,
}: {
  dialog: NonNullable<Dialog>;
  candidates: TreeNode[];
  onClose: () => void;
  onCommitted: () => void;
  innerRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const target = dialog.target;

  // ---- shared error reporter so the four handlers stay short
  function report(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Action failed");
  }

  // ---- rename
  async function handleRename(slug: string) {
    if (!slug || slug === target.slug) return;
    try {
      await api.renamePage(target.pageId, target.branchId, slug);
      toast.success("Renamed");
      onCommitted();
    } catch (err) {
      report(err);
    }
  }

  // ---- move
  async function handleMove(newParentBranchId: string | null) {
    try {
      await api.moveBranch(target.branchId, { newParentBranchId });
      toast.success("Moved");
      onCommitted();
    } catch (err) {
      report(err);
    }
  }

  // ---- delete (remove placement; page persists if other placements exist)
  async function handleDelete() {
    try {
      await api.removeBranch(target.branchId);
      toast.success("Deleted");
      onCommitted();
    } catch (err) {
      report(err);
    }
  }

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dialog.kind === "rename") inputRef.current?.select();
  }, [dialog.kind]);

  // Build the dialog body per kind. Each block is its own form so Enter and
  // Cancel-Backdrop click semantics stay predictable.
  let body;
  if (dialog.kind === "rename") {
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const slug = inputRef.current?.value.trim() ?? "";
          handleRename(slug);
        }}
      >
        <p className="mb-2 text-sm">New slug for <code>{target.slug}</code>:</p>
        <input
          ref={inputRef}
          defaultValue={target.slug}
          autoFocus
          pattern="[A-Za-z0-9._\-]+"
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <DialogActions onCancel={onClose} submitLabel="Save" />
      </form>
    );
  } else if (dialog.kind === "move") {
    body = (
      <div>
        <p className="mb-2 text-sm">Move <code>{target.slug}</code> under:</p>
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          <button
            type="button"
            onClick={() => handleMove(null)}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
          >
            <span className="font-mono">/</span> (space root)
          </button>
          {candidates.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No other branches to move under.</div>
          )}
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => handleMove(c.id)}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
              aria-label={`Move under ${c.slug}`}
            >
              {c.slug}
            </button>
          ))}
        </div>
        <DialogActions onCancel={onClose} submitLabel={null} />
      </div>
    );
  } else {
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleDelete();
        }}
      >
        <p className="mb-3 text-sm">
          Delete the placement <code>{target.slug}</code>? The page itself stays
          if other placements remain; otherwise it moves to the trash.
        </p>
        <DialogActions onCancel={onClose} submitLabel="Delete" danger />
      </form>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={innerRef}
        data-tree-dialog
        role="dialog"
        aria-modal="true"
        aria-label={
          dialog.kind === "rename"
            ? "Rename page"
            : dialog.kind === "move"
              ? `Move ${target.slug} under...`
              : `Delete ${target.slug}`
        }
        className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold">
          {dialog.kind === "rename"
            ? "Rename page"
            : dialog.kind === "move"
              ? "Move page"
              : "Delete placement"}
        </h2>
        {body}
      </div>
    </div>
  );
}

function DialogActions({
  onCancel,
  submitLabel,
  danger = false,
}: {
  onCancel: () => void;
  submitLabel: string | null;
  danger?: boolean;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
      >
        Cancel
      </button>
      {submitLabel !== null && (
        <button
          type="submit"
          className={cn(
            "rounded-md px-3 py-1 text-sm font-medium",
            danger
              ? "bg-danger text-white hover:bg-danger/90"
              : "bg-primary text-white hover:bg-primary/90",
          )}
        >
          {submitLabel}
        </button>
      )}
    </div>
  );
}
