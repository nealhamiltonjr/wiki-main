import { useEffect, useState } from "react";
import { api, type SpaceSummary, type TreeNode } from "../../api/client.js";

export function Tree({
  onSelectBranch,
  selectedBranchId,
}: {
  onSelectBranch: (branchId: string, spaceId: string) => void;
  selectedBranchId: string | null;
}) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [activeSpace, setActiveSpace] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [newPageSlug, setNewPageSlug] = useState("");
  // Found missing entirely: there was no way to create a page UNDER an
  // existing one - every "+ page" click always passed parentBranchId: null.
  // The backend always supported arbitrary nesting via branches.parentBranchId;
  // the tree UI just never exposed it. This tracks which node (if any) the
  // next created page should be placed under.
  const [parentTarget, setParentTarget] = useState<{ id: string; slug: string } | null>(null);

  useEffect(() => {
    api.listSpaces().then((s) => {
      setSpaces(s);
      if (s.length > 0 && !activeSpace) setActiveSpace(s[0]!.id);
    });
  }, []);

  useEffect(() => {
    if (activeSpace) api.getSpaceTree(activeSpace).then(setTree);
    setParentTarget(null); // switching spaces invalidates any chosen parent from the old space
  }, [activeSpace]);

  async function refreshTree() {
    if (activeSpace) {
      const t = await api.getSpaceTree(activeSpace);
      setTree(t);
    }
  }

  async function createSpace() {
    if (!newSpaceName.trim()) return;
    const space = await api.createSpace(newSpaceName.trim());
    setSpaces((s) => [...s, space]);
    setActiveSpace(space.id);
    setNewSpaceName("");
  }

  async function createPage() {
    if (!activeSpace || !newPageSlug.trim()) return;
    await api.createPage({ slug: newPageSlug.trim(), spaceId: activeSpace, parentBranchId: parentTarget?.id ?? null });
    setNewPageSlug("");
    refreshTree();
    // Deliberately NOT clearing parentTarget here - adding several children
    // under the same parent in a row (e.g. "test-scripts" -> multiple pages)
    // is a normal flow; the explicit "x" below is how you clear it.
  }

  return (
    <div style={{
      width: "var(--sidebar-width)",
      borderRight: "1px solid var(--color-border)",
      padding: "var(--space-3)",
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      color: "var(--color-text)",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
      overflowY: "auto",
    }}>
      <div className="wiki-sidebar-controls">
        <select
          value={activeSpace ?? ""}
          onChange={(e) => setActiveSpace(e.target.value)}
        >
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <div className="row">
          <input
            placeholder="New space"
            value={newSpaceName}
            onChange={(e) => setNewSpaceName(e.target.value)}
          />
          <button onClick={createSpace} title="Create space" className="wiki-icon-btn">+</button>
        </div>
      </div>

      <div className="wiki-tree">
        {tree.length === 0 && (
          <div className="tree-empty">No pages yet</div>
        )}
        {tree.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            onSelectBranch={onSelectBranch}
            activeSpace={activeSpace!}
            selectedBranchId={selectedBranchId}
            onAddChild={(id, slug) => setParentTarget({ id, slug })}
            onChanged={refreshTree}
            spaces={spaces}
          />
        ))}
      </div>

      <div className="wiki-sidebar-controls" style={{ borderTop: "1px solid var(--color-border-light)", paddingTop: 8 }}>
        {parentTarget ? (
          <div className="parent-hint">
            <span>New page under: <strong>{parentTarget.slug}</strong></span>
            <button onClick={() => setParentTarget(null)} className="wiki-icon-btn" title="Create as a top-level page instead">x</button>
          </div>
        ) : (
          <div className="parent-hint">New top-level page</div>
        )}
        <div className="row">
          <input
            placeholder="new-page-slug"
            value={newPageSlug}
            onChange={(e) => setNewPageSlug(e.target.value)}
          />
          <button onClick={createPage} title="Create page" className="wiki-icon-btn">+ page</button>
        </div>
      </div>
    </div>
  );
}

function TreeItem({
  node, depth, onSelectBranch, activeSpace, selectedBranchId, onAddChild, onChanged, spaces,
}: {
  node: TreeNode;
  depth: number;
  onSelectBranch: (branchId: string, spaceId: string) => void;
  activeSpace: string;
  selectedBranchId: string | null;
  onAddChild: (branchId: string, slug: string) => void;
  onChanged: () => Promise<void>;
  spaces: SpaceSummary[];
}) {
  const selected = node.id === selectedBranchId;
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneTarget, setCloneTarget] = useState(spaces[0]?.id ?? "");

  async function handleRename() {
    const slug = window.prompt("New slug:", node.slug);
    if (!slug || slug === node.slug) return;
    try {
      await api.renamePage(node.pageId, node.id, slug.trim());
      await onChanged();
    } catch (err) {
      window.alert((err as any)?.body?.error ?? "Rename failed");
    }
  }

  async function handleMove() {
    const target = window.prompt(
      "Move to which parent branch ID? (blank = top level of the current space)",
      ""
    );
    if (target === null) return;
    try {
      await api.moveBranch(node.id, target.trim() || null);
      await onChanged();
    } catch (err) {
      window.alert((err as any)?.body?.error ?? "Move failed");
    }
  }

  async function handleClone() {
    // Inline picker (cloneOpen) instead of a raw space-UUID prompt - space
    // IDs are opaque random strings, useless for choosing a destination.
    if (!cloneTarget) return;
    try {
      await api.cloneBranch(node.id, { targetSpaceId: cloneTarget, targetParentBranchId: null });
      setCloneOpen(false);
      await onChanged();
    } catch (err) {
      window.alert((err as any)?.body?.error ?? "Clone failed");
    }
  }

  async function handleDeletePlacement() {
    if (!window.confirm(`Remove this placement of "/${node.slug}"? The content persists if it's placed elsewhere.`)) return;
    try {
      await api.removePlacement(node.id);
      await onChanged();
    } catch (err) {
      window.alert((err as any)?.body?.error ?? "Remove failed");
    }
  }

  async function handleDeleteEverywhere() {
    if (!window.confirm(`Delete "/${node.slug}" EVERYWHERE? This removes all placements and the page itself. This cannot be undone.`)) return;
    try {
      await api.deletePageEverywhere(node.pageId, node.id);
      await onChanged();
    } catch (err) {
      window.alert((err as any)?.body?.error ?? "Delete failed");
    }
  }

  return (
    <div>
      <div className={`wiki-tree-item${selected ? " selected" : ""}`} style={{ paddingLeft: depth * 14 }}>
        <span
          onClick={() => onSelectBranch(node.id, activeSpace)}
          className="tree-label"
          title={node.slug}
        >
          {node.slug}
        </span>
        <span className="tree-actions">
          <button onClick={handleRename} title="Rename" className="wiki-icon-btn">✎</button>
          <button onClick={() => setCloneOpen((v) => !v)} title="Clone to another space" className="wiki-icon-btn" style={{ background: cloneOpen ? "var(--color-bg-tertiary)" : "var(--color-surface)" }}>⧉</button>
          <button onClick={handleMove} title="Move to another parent" className="wiki-icon-btn">⇄</button>
          <button onClick={handleDeletePlacement} title="Remove this placement" className="wiki-icon-btn">🗑</button>
          <button onClick={handleDeleteEverywhere} title="Delete everywhere" className="wiki-icon-btn danger">✕</button>
          <button onClick={() => onAddChild(node.id, node.slug)} title={`Add a page under "${node.slug}"`} className="wiki-icon-btn">+</button>
        </span>
      </div>
      {cloneOpen && (
        <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0 4px 14px", fontSize: 12 }}>
          <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>Clone into:</span>
          <select
            value={cloneTarget}
            onChange={(e) => setCloneTarget(e.target.value)}
            autoFocus
            style={{ flex: 1, padding: "3px 4px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)" }}
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button onClick={handleClone} className="wiki-icon-btn" title="Clone page into the selected space">Clone</button>
          <button onClick={() => setCloneOpen(false)} className="wiki-icon-btn" title="Cancel">✕</button>
        </div>
      )}
      {node.children.map((child) => (
        <TreeItem
          key={child.id}
          node={child}
          depth={depth + 1}
          onSelectBranch={onSelectBranch}
          activeSpace={activeSpace}
          selectedBranchId={selectedBranchId}
          onAddChild={onAddChild}
          onChanged={onChanged}
          spaces={spaces}
        />
      ))}
    </div>
  );
}
