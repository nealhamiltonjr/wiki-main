import { createContext, useContext, useLayoutEffect, useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { toast } from "sonner";
import { Tree as ArboristTree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { api, type SpaceSummary, type TreeNode } from "../../api/client.js";
import { cn } from "../../lib/utils.js";
import {
  ArrowUpDown, ChevronRight, Copy, FilePlus2, FileText, FolderMinus, Link2, MoreHorizontal, Pencil, Plus, Share2, Trash2,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem,
} from "../../components/ui/dropdown-menu.js";
import {
  ContextMenu, ContextMenuContent, ContextMenuTrigger, ContextMenuItem,
} from "../../components/ui/context-menu.js";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../../components/ui/select.js";
import { PageCreateDialog } from "./PageCreateDialog.js";
import { RenameDialog, MoveDialog, ShareDialog, copyText } from "./PageActionDialogs.js";
import { EmptyState } from "../../components/EmptyState.js";

interface TreeActions {
  onSelectBranch: (branchId: string) => void;
  openCreateDialog: (parentBranchId: string | null, parentLabel?: string | null) => void;
  openCloneDialog: (node: TreeNode) => void;
  openRenameDialog: (node: TreeNode) => void;
  openMoveDialog: (node: TreeNode) => void;
  openShareDialog: (node: TreeNode) => void;
  copyPageLink: (node: TreeNode) => void;
  refreshTree: () => Promise<void>;
}

const TreeActionsContext = createContext<TreeActions | null>(null);

function useTreeActions(): TreeActions {
  const ctx = useContext(TreeActionsContext);
  if (!ctx) throw new Error("TreeActionsContext missing");
  return ctx;
}

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

function FavoritesSection({ onSelect }: { onSelect: (branchId: string) => void }) {
  const [favorites, setFavorites] = useState<{ id: string; branchId: string; slug: string }[]>([]);
  useEffect(() => {
    api.getFavorites().then(setFavorites).catch(() => {});
  }, []);
  if (favorites.length === 0) return null;
  return (
    <div className="favorites-section">
      <div className="section-title">★ Favorites</div>
      {favorites.map((f) => (
        <button key={f.id} className="fav-item" onClick={() => onSelect(f.branchId)}>
          <span className="fav-star">★</span>
          <span>{f.slug}</span>
        </button>
      ))}
    </div>
  );
}

interface MenuAction {
  key: string;
  label: string;
  icon: ElementType;
  danger?: boolean;
  onSelect: () => void;
}

/** Shared action list for the row's ⋯ DropdownMenu AND right-click ContextMenu. */
function buildMenuActions(node: NodeApi<TreeNode>): MenuAction[] {
  const {
    onSelectBranch, openCreateDialog, openCloneDialog, openRenameDialog, openMoveDialog, openShareDialog, copyPageLink, refreshTree,
  } = useTreeActions();
  const d = node.data;

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshTree();
    } catch (err) {
      window.alert((err as any)?.body?.error ?? "Operation failed");
    }
  };

  return [
    { key: "open", label: "Open", icon: FileText, onSelect: () => onSelectBranch(d.id) },
    { key: "add-child", label: "Add subpage…", icon: Plus, onSelect: () => openCreateDialog(d.id, d.slug) },
    { key: "rename", label: "Rename…", icon: Pencil, onSelect: () => openRenameDialog(d) },
    { key: "move", label: "Move…", icon: ArrowUpDown, onSelect: () => openMoveDialog(d) },
    { key: "clone", label: "Clone to space…", icon: Copy, onSelect: () => openCloneDialog(d) },
    { key: "share", label: "Share…", icon: Share2, onSelect: () => openShareDialog(d) },
    { key: "copy-link", label: "Copy link", icon: Link2, onSelect: () => copyPageLink(d) },
    { key: "remove-placement", label: "Remove placement", icon: FolderMinus, danger: true, onSelect: () => {
      if (!window.confirm(`Remove this placement of "/${d.slug}"? The content persists if it's placed elsewhere.`)) return;
      void guard(() => api.removePlacement(d.id).then(() => {}));
    } },
    { key: "delete", label: "Delete everywhere", icon: Trash2, danger: true, onSelect: () => {
      if (!window.confirm(`Delete "/${d.slug}" EVERYWHERE? This removes all placements and the page itself. This cannot be undone.`)) return;
      void guard(() => api.deletePageEverywhere(d.pageId, d.id).then(() => {}));
    } },
  ];
}

function PageMenuItems({ node, Item }: { node: NodeApi<TreeNode>; Item: ElementType }) {
  const actions = buildMenuActions(node);
  return (
    <>
      {actions.map((a) => (
        <Item key={a.key} onSelect={a.onSelect} className={cn(a.danger && "text-danger")}>
          <a.icon aria-hidden />
          {a.label}
        </Item>
      ))}
    </>
  );
}

function WikiTreeNode({ node, style }: NodeRendererProps<TreeNode>) {
  const { onSelectBranch } = useTreeActions();
  const isLeaf = node.isLeaf;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
          <span
            className="tree-label"
            title={node.data.slug}
            onClick={(e) => { e.stopPropagation(); onSelectBranch(node.data.id); }}
          >
            {node.data.icon ? (
              <span className="tree-page-icon" aria-hidden>{node.data.icon}</span>
            ) : (
              <span className="tree-page-dot" aria-hidden />
            )}
            {node.data.slug}
          </span>
          <span className="tree-actions">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="wiki-icon-btn"
                  title="Page actions"
                  aria-label={`Actions for ${node.data.slug}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <PageMenuItems node={node} Item={DropdownMenuItem} />
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PageMenuItems node={node} Item={ContextMenuItem} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CloneDialog({
  target, spaces, onClose, onCloned,
}: {
  target: TreeNode;
  spaces: SpaceSummary[];
  onClose: () => void;
  onCloned: () => void;
}) {
  const [space, setSpace] = useState(spaces[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function clone() {
    if (!space || busy) return;
    setBusy(true);
    try {
      await api.cloneBranch(target.id, { targetSpaceId: space, targetParentBranchId: null });
      toast.success(`Cloned “${target.slug}”`);
      onClose();
      onCloned();
    } catch (err) {
      toast.error((err as any)?.body?.error ?? "Clone failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Clone “{target.slug}”</DialogTitle>
          <DialogDescription>Copy this page (and its subtree) into another space.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>Destination space</Label>
          <Select value={space} onValueChange={setSpace}>
            <SelectTrigger><SelectValue placeholder="Select space" /></SelectTrigger>
            <SelectContent>
              {spaces.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void clone()} disabled={!space || busy}>{busy ? "Cloning…" : "Clone"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Tree({
  onSelectBranch,
  selectedBranchId,
}: {
  onSelectBranch: (branchId: string, spaceId?: string) => void;
  selectedBranchId: string | null;
}) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [activeSpace, setActiveSpace] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [newSpaceName, setNewSpaceName] = useState("");
  // B7: the title-first creation dialog (null parent = top-level).
  const [createTarget, setCreateTarget] = useState<{ parentBranchId: string | null; parentLabel?: string | null } | null>(null);
  const [cloneTarget, setCloneTarget] = useState<TreeNode | null>(null);
  // B6: Rename / Move / Share use real dialogs instead of window.prompt.
  const [renameTarget, setRenameTarget] = useState<TreeNode | null>(null);
  const [moveTarget, setMoveTarget] = useState<TreeNode | null>(null);
  const [shareTarget, setShareTarget] = useState<TreeNode | null>(null);
  const [containerRef, containerSize] = useContainerSize<HTMLDivElement>();

  useEffect(() => {
    api.listSpaces().then((s) => {
      setSpaces(s);
      setActiveSpace((prev) => prev && s.some((x) => x.id === prev) ? prev : (s[0]?.id ?? null));
    });
  }, []);

  useEffect(() => {
    if (activeSpace) api.getSpaceTree(activeSpace).then(setTree).catch(() => setTree([]));
  }, [activeSpace]);

  // B3: reflect icon changes made in the AttributesPanel without a reload.
  useEffect(() => {
    const onIconChange = () => { void refreshTree(); };
    window.addEventListener("wiki-page-icon-changed", onIconChange);
    return () => window.removeEventListener("wiki-page-icon-changed", onIconChange);
  }, [activeSpace]);

  async function refreshTree() {
    if (activeSpace) {
      try {
        setTree(await api.getSpaceTree(activeSpace));
      } catch { /* keep last known tree */ }
    }
  }

  async function createSpace() {
    if (!newSpaceName.trim()) return;
    const space = await api.createSpace(newSpaceName.trim());
    setSpaces((s) => [...s, space]);
    setActiveSpace(space.id);
    setNewSpaceName("");
  }

  async function handleMove({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) {
    const id = dragIds[0];
    if (!id) return;
    try {
      await api.moveBranch(id, parentId);
      toast.success("Moved");
      await refreshTree();
    } catch (err) {
      toast.error((err as any)?.body?.error ?? "Move failed");
      await refreshTree(); // revert the optimistic tree state
    }
  }

  const actions: TreeActions = {
    onSelectBranch: (id) => onSelectBranch(id, activeSpace ?? undefined),
    openCreateDialog: (parentBranchId, parentLabel) => setCreateTarget({ parentBranchId, parentLabel }),
    openCloneDialog: (node) => setCloneTarget(node),
    openRenameDialog: (node) => setRenameTarget(node),
    openMoveDialog: (node) => setMoveTarget(node),
    openShareDialog: (node) => setShareTarget(node),
    copyPageLink: async (node) => {
      const ok = await copyText(`${window.location.origin}/pages/${node.id}`);
      if (ok) toast.success("Link copied");
      else toast.error("Could not copy the link");
    },
    refreshTree,
  };

  return (
    <div className="wiki-tree-column" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div className="wiki-sidebar-controls">
        <select value={activeSpace ?? ""} onChange={(e) => setActiveSpace(e.target.value)} aria-label="Active space">
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <div className="row">
          <input
            placeholder="New space"
            value={newSpaceName}
            onChange={(e) => setNewSpaceName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createSpace(); }}
            aria-label="New space name"
          />
          <button onClick={() => void createSpace()} title="Create space" className="wiki-icon-btn">+</button>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="justify-start"
          onClick={() => setCreateTarget({ parentBranchId: null })}
        >
          <FilePlus2 aria-hidden />
          New page
        </Button>
      </div>

      <FavoritesSection onSelect={(id) => onSelectBranch(id, activeSpace ?? undefined)} />

      <TreeActionsContext.Provider value={actions}>
        <div className="wiki-tree" ref={containerRef}>
          {containerSize.width > 0 && containerSize.height > 0 && (
            <ArboristTree<TreeNode>
              data={tree}
              width={containerSize.width}
              height={containerSize.height}
              rowHeight={28}
              indent={18}
              padding={4}
              openByDefault
              disableMultiSelection
              onMove={handleMove}
              onActivate={(node) => onSelectBranch(node.data.id, activeSpace ?? undefined)}
              aria-label="Pages tree"
            >
              {WikiTreeNode}
            </ArboristTree>
          )}
          {tree.length === 0 && containerSize.height > 0 && (
            <EmptyState
              compact
              icon={FilePlus2}
              title="Create your first page"
              description="This space is empty."
              action={<Button size="sm" onClick={() => setCreateTarget({ parentBranchId: null })}>New page</Button>}
            />
          )}
        </div>
      </TreeActionsContext.Provider>

      {createTarget !== null && activeSpace && (
        <PageCreateDialog
          open
          onOpenChange={(open) => { if (!open) setCreateTarget(null); }}
          spaces={spaces}
          spaceId={activeSpace}
          parentBranchId={createTarget.parentBranchId}
          parentLabel={createTarget.parentLabel ?? null}
          onCreated={(branchId) => {
            void refreshTree();
            onSelectBranch(branchId, activeSpace);
          }}
        />
      )}

      {cloneTarget && (
        <CloneDialog
          target={cloneTarget}
          spaces={spaces}
          onClose={() => setCloneTarget(null)}
          onCloned={() => void refreshTree()}
        />
      )}

      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => void refreshTree()}
        />
      )}

      {moveTarget && (
        <MoveDialog
          target={moveTarget}
          tree={tree}
          onClose={() => setMoveTarget(null)}
          onMoved={() => void refreshTree()}
        />
      )}

      {shareTarget && (
        <ShareDialog
          target={shareTarget}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
