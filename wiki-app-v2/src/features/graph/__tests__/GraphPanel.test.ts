import { describe, it, expect } from "vitest";
import { computeLayout, computeEdgeLayout } from "../GraphPanel";
import type { GraphNode, GraphEdge } from "@/api/client";

const CX = 100;
const CY = 100;
const R = 50;

const node = (id: string, opts: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  branchId: `b-${id}`,
  isCenter: false,
  ...opts,
});

describe("computeLayout (graph panel, slice-27 §13.2)", () => {
  it("places the center node at (cx, cy) when there are no neighbors", () => {
    const center = node("A", { isCenter: true });
    const result = computeLayout({ nodes: [center], cx: CX, cy: CY, radius: R });
    expect(result.empty).toBe(true);
    expect(result.positions.get("A")).toEqual({ id: "A", x: CX, y: CY });
  });

  it("distributes N neighbors evenly on a circle around the center", () => {
    const nodes = [
      node("A", { isCenter: true }),
      node("B"), node("C"), node("D"), node("E"),
    ];
    const result = computeLayout({ nodes, cx: CX, cy: CY, radius: R });
    expect(result.empty).toBe(false);
    expect(result.positions.size).toBe(5);
    // First neighbor at angle 0 → directly to the right of center.
    const b = result.positions.get("B")!;
    expect(b.x).toBeCloseTo(CX + R);
    expect(b.y).toBeCloseTo(CY);
    // Second at π/2 → directly below.
    const c = result.positions.get("C")!;
    expect(c.x).toBeCloseTo(CX);
    expect(c.y).toBeCloseTo(CY + R);
  });

  it("is deterministic across calls (no Math.random)", () => {
    const nodes = [
      node("A", { isCenter: true }),
      node("B"), node("C"), node("D"),
    ];
    const r1 = computeLayout({ nodes, cx: CX, cy: CY, radius: R });
    const r2 = computeLayout({ nodes, cx: CX, cy: CY, radius: R });
    for (const k of r1.positions.keys()) {
      expect(r1.positions.get(k)).toEqual(r2.positions.get(k));
    }
  });

  it("reports empty=true when no center is supplied", () => {
    const result = computeLayout({
      nodes: [node("B"), node("C")],
      cx: CX, cy: CY, radius: R,
    });
    expect(result.empty).toBe(true);
    expect(result.positions.size).toBe(0);
  });

  it("computes a bbox that fits all positioned nodes", () => {
    const nodes = [
      node("A", { isCenter: true }),
      node("B"), node("C"), node("D"), node("E"),
    ];
    const result = computeLayout({ nodes, cx: CX, cy: CY, radius: R });
    const { minX, minY, width, height } = result.bbox;
    // Bbox should span roughly 2R × 2R (from -R to +R around the center).
    expect(width).toBeGreaterThan(0.9 * 2 * R);
    expect(height).toBeGreaterThan(0.9 * 2 * R);
    expect(minX).toBeLessThanOrEqual(CX - R);
    expect(minY).toBeLessThanOrEqual(CY - R);
  });
});

describe("computeEdgeLayout", () => {
  const e = (id: string, from: string, to: string, opts: Partial<GraphEdge> = {}): GraphEdge => ({
    id, from, to,
    kind: "backlink",
    label: null,
    direction: "out",
    ...opts,
  });

  it("emits one layout row per edge, with a path between positions", () => {
    const positions = new Map([
      ["A", { id: "A", x: 0, y: 0 }],
      ["B", { id: "B", x: 10, y: 0 }],
    ]);
    const layout = computeEdgeLayout([e("e1", "A", "B")], positions);
    expect(layout).toHaveLength(1);
    expect(layout[0]!.path).toBe("M 0.00 0.00 L 10.00 0.00");
    expect(layout[0]!.labelX).toBe(5);
    expect(layout[0]!.labelY).toBe(-4);
  });

  it("drops edges whose endpoints are not in the position map", () => {
    const positions = new Map([["A", { id: "A", x: 0, y: 0 }]]);
    const layout = computeEdgeLayout([e("e1", "A", "MISSING")], positions);
    expect(layout).toHaveLength(0);
  });
});