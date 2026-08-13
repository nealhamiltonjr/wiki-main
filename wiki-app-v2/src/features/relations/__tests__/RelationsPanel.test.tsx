import { describe, it, expect } from "vitest";
import { validateRelationType } from "../RelationsPanel.js";

describe("validateRelationType (RelationsPanel, slice-26)", () => {
  it("accepts a normal printable type", () => {
    expect(validateRelationType("depends on")).toBeNull();
    expect(validateRelationType("is a component of")).toBeNull();
    expect(validateRelationType("references")).toBeNull();
  });

  it("rejects an empty / whitespace-only input", () => {
    expect(validateRelationType("")).toBe("relation type is required");
    expect(validateRelationType("   ")).toBe("relation type is required");
  });

  it("rejects types longer than 64 characters", () => {
    const t = "x".repeat(65);
    expect(validateRelationType(t)).toMatch(/≤ 64/);
    // exactly 64 is fine
    expect(validateRelationType("x".repeat(64))).toBeNull();
  });

  it("rejects types containing control characters", () => {
    expect(validateRelationType("bad\u0000type")).toMatch(/control/);
    expect(validateRelationType("bad\ntype")).toMatch(/control/);
    expect(validateRelationType("bad\ttype")).toMatch(/control/);
  });

  it("trims surrounding whitespace before validating length", () => {
    // Whitespace-only is rejected via the empty path; otherwise trim
    // shouldn't shift the boundary check.
    expect(validateRelationType("  depends on  ")).toBeNull();
  });
});