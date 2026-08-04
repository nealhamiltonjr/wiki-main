import { describe, it, expect } from "vitest";
import { buildFtsQuery } from "../search.service.js";

describe("buildFtsQuery", () => {
  it("turns bare words into (stem OR prefix) groups joined by AND", () => {
    expect(buildFtsQuery("linux network code")).toBe("(linux OR linux*) AND (network OR network*) AND (code OR code*)");
  });

  it("keeps quoted phrases as adjacency-required phrases", () => {
    expect(buildFtsQuery('"linux network code"')).toBe('"linux network code"');
  });

  it("mixes phrases and bare words", () => {
    expect(buildFtsQuery('kernel "network stack" tuning')).toBe(
      '(kernel OR kernel*) AND "network stack" AND (tuning OR tuning*)'
    );
  });

  it("lowercases and strips FTS5 special characters from bare words", () => {
    // Parens, colon, caret are stripped; `+` is not FTS5 syntax so it is kept
    // verbatim (the tokenizer treats it as a separator).
    expect(buildFtsQuery('C++ (x86): net^2')).toBe("(c++ OR c++*) AND (x86 OR x86*) AND (net2 OR net2*)");
  });

  it("quotes operator keywords so they don't break the MATCH syntax", () => {
    expect(buildFtsQuery("AND OR NOT near")).toBe(
      '("and" OR and*) AND ("or" OR or*) AND ("not" OR not*) AND ("near" OR near*)'
    );
  });

  it("splits doubled quotes gracefully without producing invalid FTS5", () => {
    // A doubled quote is FTS5's phrase-escape syntax; we don't special-case it,
    // but the output must stay a valid MATCH expression (never an error).
    expect(buildFtsQuery('say "he said ""hi"""')).toBe('(say OR say*) AND "he said" AND "hi"');
  });

  it("returns empty string for empty or all-special input", () => {
    expect(buildFtsQuery("")).toBe("");
    expect(buildFtsQuery("   ")).toBe("");
    expect(buildFtsQuery('"  "')).toBe("");
    expect(buildFtsQuery("*():^")).toBe("");
  });
});
