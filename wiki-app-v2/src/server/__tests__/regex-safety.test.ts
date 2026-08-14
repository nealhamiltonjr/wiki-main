import { describe, it, expect } from "vitest";
import { assertSafeRegex } from "../utils/regex-safety.js";

describe("assertSafeRegex", () => {
  describe("safe patterns", () => {
    it.each([
      ["literal", "hello"],
      ["anchors", "^Meeting notes$"],
      ["dot", "foo.bar"],
      ["star on literal", "ab*c"],
      ["plus on literal", "ab+c"],
      ["question on literal", "colou?r"],
      ["alternation", "(foo|bar)"],
      ["quantified alternation", "(foo|bar)+baz"],
      ["character class", "[a-z]+"],
      ["digits", "\\d{4}-\\d{2}-\\d{2}"],
      ["real title patterns", "^meeting-\\d+$"],
      ["word boundary", "^(TODO|DONE)\\b"],
      ["negated class", "[^a-z]+"],
      ["multiple quantifiers", "a+b+"],
      ["escaped quantifier", "a\\+b"],
      ["groups with non-quantified contents", "(abc)(def)"],
    ])("accepts %s (%s)", (_label, pattern) => {
      const result = assertSafeRegex(pattern);
      expect(result).toEqual({ safe: true });
    });
  });

  describe("rejects ReDoS shapes", () => {
    it.each([
      ["nested quantifier", "^(a+)+$"],
      ["nested quantifier 2", "(a+)+X"],
      ["alternation with inner quantifier", "(a+|b)+"],
      ["two levels nested", "((a+)+)+"],
      ["star on starred", "(a*)*"],
      ["star on plus", "(a+)*"],
      ["plus on star", "(a*)+"],
    ])("rejects %s (%s)", (_label, pattern) => {
      const result = assertSafeRegex(pattern);
      expect(result.safe).toBe(false);
      // We want a meaningful reason, not just `safe: false`.
      expect(result.reason).toMatch(/nested quantifier/i);
    });

    it("rejects adjacent quantifiers (++)", () => {
      expect(assertSafeRegex("a++").safe).toBe(false);
    });

    it("rejects adjacent quantifiers (*+)", () => {
      expect(assertSafeRegex("a*+").safe).toBe(false);
    });

    it("rejects adjacent quantifiers (?*)", () => {
      expect(assertSafeRegex("a?*").safe).toBe(false);
    });

    it("rejects too many quantifiers", () => {
      const result = assertSafeRegex("a+b+c+d+e+f+");
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/too many quantifiers/i);
    });

    it("rejects backreference (interacts with outer repetitions)", () => {
      expect(assertSafeRegex("(a+)+\\1").safe).toBe(false);
    });
  });

  describe("rejects invalid input", () => {
    it("rejects empty pattern", () => {
      expect(assertSafeRegex("").safe).toBe(false);
    });

    it("rejects too-long pattern", () => {
      expect(assertSafeRegex("a".repeat(257)).safe).toBe(false);
    });

    it("rejects non-string input", () => {
      // @ts-expect-error — runtime guard for untrusted callers
      expect(assertSafeRegex(123).safe).toBe(false);
    });

    it("rejects syntactically invalid regex", () => {
      // Unclosed group
      expect(assertSafeRegex("(abc").safe).toBe(false);
    });
  });

  it("the canonical `(a+)+$` attack actually backtracks under V8", () => {
    // Sanity check that the heuristic targets a real ReDoS shape. We only
    // run a tiny input here to keep this unit test fast — slice-41's
    // bootstrap test is the place for big-input demonstrations.
    const pattern = "^(a+)+$";
    const t0 = Date.now();
    new RegExp(pattern).test("a".repeat(20) + "X");
    const elapsed = Date.now() - t0;
    // V8 starts blowing up well before the 256-char input cap on real data.
    expect(elapsed).toBeGreaterThan(50);
  });
});