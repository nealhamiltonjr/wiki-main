import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tree as ArboristTree, type NodeRendererProps } from "react-arborist";
import { ChevronRight, Pin, Trash2 } from "lucide-react";
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

function WikiTreeNode({ node, style }: NodeRendererProps<TreeNode>) {
  return (
    <div
      style={{ ...style, margin: 0, display: "flex", alignItems: "center" }}
      className={cn("wiki-tree-item", node.isSelected && "selected")}
      onClick={() => { if (node.isInternal) node.toggle(); }}
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

  useEffect(() => {
    api.listSpaces().then((s) => {
      setSpaces(s);
      setActiveSpace((prev) => (prev && s.some((x) => x.id === prev) ? prev : (s[0]?.id ?? null)));
    }).catch(() => setSpaces([]));
  }, []);

  useEffect(() => {
    if (activeSpace) api.getSpaceTree(activeSpace).then(setTree).catch(() => setTree([]));
  }, [activeSpace]);

  return (
    <div className="wiki-sidebar">
      <div className="wiki-sidebar-controls">
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
            {WikiTreeNode}
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
    </div>
  );
}
