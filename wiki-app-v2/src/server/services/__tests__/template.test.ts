import { describe, it, expect } from "vitest";
import { mergeInheritedAttributes, type TemplateAttribute } from "../template.service.js";

function attr(
  name: string,
  value: string,
  position = 0,
  isPromoted = false,
): TemplateAttribute {
  return {
    id: `attr-${name}-${position}`,
    pageId: "page",
    name,
    value,
    valuePageId: null,
    isPromoted,
    position,
    templatePageId: "template",
    templateTitle: "T",
    depth: 1,
  };
}

function own(
  name: string,
  value: string,
  position = 0,
): TemplateAttribute {
  return { ...attr(name, value, position), templatePageId: "page", templateTitle: "", depth: 0 };
}

describe("mergeInheritedAttributes (slice-28, brief §13.3)", () => {
  it("returns an empty array when no inputs", () => {
    expect(mergeInheritedAttributes([], [])).toEqual([]);
  });

  it("passes through own attributes", () => {
    const out = mergeInheritedAttributes([own("a", "1", 0)], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("a");
    expect(out[0]!.depth).toBe(0);
  });

  it("inherits template attributes when no collision", () => {
    const t = { templatePageId: "T1", templateTitle: "Template 1", depth: 1, attributes: [attr("a", "v"), attr("b", "v")] };
    const out = mergeInheritedAttributes([], [t]);
    expect(out.map((a) => a.name).sort()).toEqual(["a", "b"]);
    expect(out[0]!.templateTitle).toBe("Template 1");
  });

  it("page's own attribute wins over inherited on name collision", () => {
    const t = { templatePageId: "T1", templateTitle: "T", depth: 1, attributes: [attr("a", "template-value")] };
    const out = mergeInheritedAttributes([own("a", "own-value")], [t]);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe("own-value");
    expect(out[0]!.templatePageId).toBe("page");
    expect(out[0]!.depth).toBe(0);
  });

  it("first template wins on collision between templates", () => {
    const t1 = { templatePageId: "T1", templateTitle: "T1", depth: 1, attributes: [attr("a", "v1")] };
    const t2 = { templatePageId: "T2", templateTitle: "T2", depth: 1, attributes: [attr("a", "v2")] };
    const out = mergeInheritedAttributes([], [t1, t2]);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe("v1");
    expect(out[0]!.templatePageId).toBe("T1");
  });

  it("deepest templates come last in the output (stable order by depth)", () => {
    const t1 = { templatePageId: "T1", templateTitle: "T1", depth: 1, attributes: [attr("a", "v1")] };
    const t2 = { templatePageId: "T2", templateTitle: "T2", depth: 2, attributes: [attr("b", "v2")] };
    const out = mergeInheritedAttributes([], [t1, t2]);
    expect(out.map((a) => a.depth)).toEqual([1, 2]);
  });

  it("merges across two depths and propagates depth correctly", () => {
    const t1 = { templatePageId: "T1", templateTitle: "T1", depth: 1, attributes: [attr("from-t1", "x")] };
    const t2 = { templatePageId: "T2", templateTitle: "T2", depth: 2, attributes: [attr("from-t2", "x")] };
    const out = mergeInheritedAttributes([], [t1, t2]);
    const t1Attr = out.find((a) => a.name === "from-t1")!;
    const t2Attr = out.find((a) => a.name === "from-t2")!;
    expect(t1Attr.depth).toBe(1);
    expect(t1Attr.templatePageId).toBe("T1");
    expect(t2Attr.depth).toBe(2);
    expect(t2Attr.templatePageId).toBe("T2");
  });

  it("handles multiple attributes per template, preserving both", () => {
    const t = {
      templatePageId: "T1", templateTitle: "T1", depth: 1,
      attributes: [attr("a", "1", 0), attr("b", "2", 1), attr("c", "3", 2)],
    };
    const out = mergeInheritedAttributes([], [t]);
    expect(out).toHaveLength(3);
    expect(out.map((a) => a.name)).toEqual(["a", "b", "c"]);
  });
});