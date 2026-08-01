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
    api.getSpaceTree(activeSpace).then(setTree);
    // Deliberately NOT clearing parentTarget here - adding several children
    // under the same parent in a row (e.g. "test-scripts" -> multiple pages)
    // is a normal flow; the explicit "x" below is how you clear it.
  }

  return (
    <div style={{ width: 260, borderRight: "1px solid #ddd", padding: 12, fontFamily: "system-ui", fontSize: 14 }}>
      <select value={activeSpace ?? ""} onChange={(e) => setActiveSpace(e.target.value)} style={{ width: "100%", marginBottom: 8 }}>
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <input placeholder="New space" value={newSpaceName} onChange={(e) => setNewSpaceName(e.target.value)} style={{ flex: 1 }} />
        <button onClick={createSpace}>+</button>
      </div>

      <div>
        {tree.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            onSelectBranch={onSelectBranch}
            activeSpace={activeSpace!}
            selectedBranchId={selectedBranchId}
            onAddChild={(id, slug) => setParentTarget({ id, slug })}
          />
        ))}
      </div>

      <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 8 }}>
        {parentTarget ? (
          <div style={{ fontSize: 12, color: "#555", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
            <span>New page under: <strong>{parentTarget.slug}</strong></span>
            <button onClick={() => setParentTarget(null)} style={{ fontSize: 11 }} title="Create as a top-level page instead">
              x
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>New top-level page</div>
        )}
        <div style={{ display: "flex", gap: 4 }}>
          <input placeholder="new-page-slug" value={newPageSlug} onChange={(e) => setNewPageSlug(e.target.value)} style={{ flex: 1 }} />
          <button onClick={createPage}>+ page</button>
        </div>
      </div>
    </div>
  );
}

function TreeItem({
  node, depth, onSelectBranch, activeSpace, selectedBranchId, onAddChild,
}: {
  node: TreeNode;
  depth: number;
  onSelectBranch: (branchId: string, spaceId: string) => void;
  activeSpace: string;
  selectedBranchId: string | null;
  onAddChild: (branchId: string, slug: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingLeft: depth * 14,
          background: node.id === selectedBranchId ? "#eef" : "transparent",
          borderRadius: 4,
        }}
      >
        <span onClick={() => onSelectBranch(node.id, activeSpace)} style={{ cursor: "pointer", padding: "4px 0", flex: 1 }}>
          {node.slug}
        </span>
        <button
          onClick={() => onAddChild(node.id, node.slug)}
          title={`Add a page under "${node.slug}"`}
          style={{ fontSize: 11, padding: "1px 5px", marginRight: 4, background: "none", border: "1px solid #ccc", borderRadius: 3, cursor: "pointer" }}
        >
          +
        </button>
      </div>
      {node.children.map((child) => (
        <TreeItem
          key={child.id}
          node={child}
          depth={depth + 1}
          onSelectBranch={onSelectBranch}
          activeSpace={activeSpace}
          selectedBranchId={selectedBranchId}
          onAddChild={onAddChild}
        />
      ))}
    </div>
  );
}
