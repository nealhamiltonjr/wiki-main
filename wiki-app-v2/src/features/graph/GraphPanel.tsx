import { useEffect, useMemo, useState } from "react";
import { Network, Loader2, ArrowRight, ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  api,
  ApiError,
  type GraphEdge,
  type GraphNode,
  type PageGraphResponse,
} from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * Graph view panel — brief §13.2. Visualizes the local neighborhood of
 * the current page: nodes = the page + every page one hop out via
 * either a backlink or a typed relation; edges = the connecting
 * backlink / relation rows. Nodes are laid out on a circle around the
 * center; edges are drawn as SVG path arcs with arrows. Hand-rolled,
 * no external graph library (intentional — the brief scopes this to a
 * small neighborhood and the security-sensitive plugin engine prefers
 * fewer dependencies).
 *
 * Permission boundaries: the API endpoint already drops nodes/edges
 * referring to unreadable pages (no existence leak), so the panel
 * simply renders what it gets. If the response has only the center
 * node with `branchId: null` we render a "no connections" empty
 * state.
 */

interface NodeLayout {
  id: string;
  x: number;
  y: number;
}

interface EdgeLayout {
  id: string;
  from: string;
  to: string;
  kind: GraphEdge["kind"];
  label: string | null;
  labelX: number;
  labelY: number;
  path: string;
}

/** Pure layout helper exported for unit testing. Positions the center
 *  node at the canvas origin (cx, cy) and distributes the other nodes
 *  evenly on a circle around it. The first node is at angle 0 (right)
 *  and subsequent nodes go counter-clockwise so the layout is
 *  deterministic across renders. */
export interface LayoutInput {
  nodes: GraphNode[];
  cx: number;
  cy: number;
  radius: number;
}

export interface LayoutResult {
  positions: Map<string, NodeLayout>;
  bbox: { minX: number; minY: number; width: number; height: number };
  empty: boolean;
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const { nodes, cx, cy, radius } = input;
  const center = nodes.find((n) => n.isCenter);
  const others = nodes.filter((n) => !n.isCenter);

  const positions = new Map<string, NodeLayout>();
  if (!center) {
    return {
      positions,
      bbox: { minX: cx, minY: cy, width: 0, height: 0 },
      empty: true,
    };
  }
  positions.set(center.id, { id: center.id, x: cx, y: cy });

  if (others.length === 0) {
    return {
      positions,
      bbox: { minX: cx, minY: cy, width: 0, height: 0 },
      empty: true,
    };
  }

  // Deterministic angle: start at 0 (right), distribute evenly.
  for (let i = 0; i < others.length; i++) {
    const angle = (2 * Math.PI * i) / others.length;
    positions.set(others[i]!.id, {
      id: others[i]!.id,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  }
  return {
    positions,
    bbox: bbox(positions),
    empty: false,
  };
}

/** Builds the SVG paths/label positions for the edges. Separate from
 *  node layout so each can be unit-tested in isolation. */
export function computeEdgeLayout(
  edges: GraphEdge[],
  positions: Map<string, NodeLayout>,
): EdgeLayout[] {
  const out: EdgeLayout[] = [];
  for (const e of edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    out.push({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label,
      labelX: mx,
      labelY: my - 4,
      path: `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
    });
  }
  return out;
}

function bbox(positions: Map<string, NodeLayout>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, width: 0, height: 0 };
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

const NODE_RADIUS = 28;
const CANVAS_RADIUS = 110;

export function GraphPanel({ pageId }: { pageId: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<PageGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getPageGraph(pageId)
      .then((g) => {
        if (cancelled) return;
        setData(g);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load graph");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const { positions, edgeLayout, nodesById, hasConnections, hasCenter } = useMemo(() => {
    const empty = {
      positions: new Map<string, NodeLayout>(),
      edgeLayout: [] as EdgeLayout[],
      nodesById: new Map<string, GraphNode>(),
      hasConnections: false,
      hasCenter: false,
    };
    if (!data) return empty;
    const nodesByIdLocal = new Map<string, GraphNode>();
    for (const n of data.nodes) nodesByIdLocal.set(n.id, n);
    const cx = CANVAS_RADIUS + NODE_RADIUS + 8;
    const cy = CANVAS_RADIUS + NODE_RADIUS + 8;
    const layout = computeLayout({
      nodes: data.nodes,
      cx,
      cy,
      radius: data.nodes.length <= 1 ? 0 : CANVAS_RADIUS,
    });
    const edges = computeEdgeLayout(data.edges, layout.positions);
    return {
      positions: layout.positions,
      edgeLayout: edges,
      nodesById: nodesByIdLocal,
      hasConnections: data.nodes.length > 1,
      hasCenter: data.nodes.some((n) => n.isCenter),
    };
  }, [data]);

  return (
    <div
      className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface/50"
      data-testid="graph-panel"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-primary" aria-hidden />
          <h3 className="text-xs font-medium">Graph</h3>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 p-6 text-xs text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading graph…
        </div>
      )}

      {error && !loading && (
        <p className="p-4 text-center text-xs text-text-muted">{error}</p>
      )}

      {!loading && !error && data && (
        <div className="px-4 py-4">
          <div className="mb-3 flex items-center gap-3 text-[11px] text-text-muted">
            <Legend kind="backlink" />
            <Legend kind="relation" />
          </div>
          {!hasConnections ? (
            <p className="p-4 text-center text-xs text-text-muted">
              {!hasCenter ? "Page not found." : "No connections yet."}
            </p>
          ) : (
            <GraphSvg
              positions={positions}
              edges={edgeLayout}
              nodesById={nodesById}
              onNodeClick={(branchId) => {
                if (branchId) navigate({ to: "/w/$branchId", params: { branchId } });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ kind }: { kind: GraphEdge["kind"] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "h-1.5 w-4 rounded-full",
          kind === "backlink" ? "bg-text-muted/60" : "bg-primary/70",
        )}
      />
      <span>{kind}</span>
    </span>
  );
}

interface GraphSvgProps {
  positions: Map<string, NodeLayout>;
  edges: EdgeLayout[];
  nodesById: Map<string, GraphNode>;
  onNodeClick: (branchId: string | null) => void;
}

function GraphSvg({ positions, edges, nodesById, onNodeClick }: GraphSvgProps) {
  const viewW = 2 * (CANVAS_RADIUS + NODE_RADIUS) + 16;
  const viewH = viewW;
  return (
    <svg
      role="img"
      aria-label="Page graph view"
      viewBox={`0 0 ${viewW} ${viewH}`}
      width="100%"
      height={viewH}
      className="mx-auto block"
    >
      <defs>
        <marker
          id="graph-arrow-backlink"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-text-muted/60" />
        </marker>
        <marker
          id="graph-arrow-relation"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-primary/70" />
        </marker>
      </defs>

      {edges.map((e) => (
        <g key={e.id}>
          <path
            d={e.path}
            fill="none"
            strokeWidth={1.5}
            className={cn(
              e.kind === "backlink" ? "stroke-text-muted/60" : "stroke-primary/70",
            )}
            markerEnd={`url(#graph-arrow-${e.kind})`}
          />
          {e.label && (
            <text
              x={e.labelX}
              y={e.labelY}
              textAnchor="middle"
              className="fill-text-muted text-[10px]"
            >
              {e.label}
            </text>
          )}
        </g>
      ))}

      {[...positions.values()].map((p) => {
        const node = nodesById.get(p.id);
        const isCenter = node?.isCenter ?? false;
        const title = node?.title ?? "(unknown)";
        const branchId = node?.branchId ?? null;
        const initials = (title.trim().slice(0, 2) || "??").toUpperCase();
        return (
          <g
            key={p.id}
            transform={`translate(${p.x.toFixed(2)},${p.y.toFixed(2)})`}
            className="cursor-pointer"
            onClick={() => onNodeClick(branchId)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onNodeClick(branchId);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Open page ${title}`}
            data-testid={isCenter ? "graph-node-center" : "graph-node"}
          >
            <circle
              r={NODE_RADIUS}
              className={cn(
                "stroke-2",
                isCenter ? "fill-primary/20 stroke-primary" : "fill-surface stroke-border",
              )}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              className={cn(
                "select-none text-[11px] font-semibold",
                isCenter ? "fill-primary" : "fill-text",
              )}
            >
              {initials}
            </text>
            <title>{title}</title>
            <text
              textAnchor="middle"
              y={NODE_RADIUS + 12}
              className="fill-text-muted text-[10px]"
            >
              {truncate(title, 18)}
            </text>
          </g>
        );
      })}

      {/* direction icons reserved for future per-edge decoration */}
      <ArrowRight style={{ display: "none" }} aria-hidden />
      <ArrowLeft style={{ display: "none" }} aria-hidden />
    </svg>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}