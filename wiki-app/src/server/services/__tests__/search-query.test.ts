import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "../search.service.js";

describe("parseSearchQuery", () => {
  it("turns bare words into (stem OR prefix) groups joined by AND", () => {
    expect(parseSearchQuery("linux network code")).toBe("(linux OR linux*) AND (network OR network*) AND (code OR code*)");
  });

  it("keeps quoted phrases as adjacency-required phrases", () => {
    expect(parseSearchQuery('"linux network code"')).toBe('"linux network code"');
  });

  it("mixes phrases and bare words", () => {
    expect(parseSearchQuery('kernel "network stack" tuning')).toBe(
      '(kernel OR kernel*) AND "network stack" AND (tuning OR tuning*)'
    );
  });

  it("lowercases and strips FTS5 special characters from bare words", () => {
    // Parens, colon, caret are stripped; non-alphanumeric runs are split into
    // sub-tokens (the unicode61 tokenizer separates on them), so "C++" becomes
    // the single token "c" and "x86"/"net2" survive intact.
    expect(parseSearchQuery('C++ (x86): net^2')).toBe("(c OR c*) AND (x86 OR x86*) AND (net2 OR net2*)");
  });

  it("splits hyphenated bare words into AND'd sub-tokens instead of emitting invalid FTS5", () => {
    // "linux-only" would otherwise produce "no such column: only" from the
    // tokenizer; each sub-token is matched separately.
    expect(parseSearchQuery("linux-only")).toBe("(linux OR linux*) AND (only OR only*)");
    expect(parseSearchQuery("bsd OR linux-only")).toBe("(bsd OR bsd*) OR (linux OR linux*) AND (only OR only*)");
    expect(parseSearchQuery("linux-only -deprecated-notes")).toBe(
      "((linux OR linux*) AND (only OR only*)) NOT ((deprecated OR deprecated*) OR (notes OR notes*))"
    );
  });

  it("quotes operator keywords so they don't break the MATCH syntax", () => {
    // "and"/"not"/"near" are quoted as literal terms. A bare "or" is the OR
    // operator (covered below), so it can't appear here as a literal.
    expect(parseSearchQuery("AND NOT near")).toBe(
      '("and" OR and*) AND ("not" OR not*) AND ("near" OR near*)'
    );
  });

  it("splits doubled quotes gracefully without producing invalid FTS5", () => {
    // A doubled quote is FTS5's phrase-escape syntax; we don't special-case it,
    // but the output must stay a valid MATCH expression (never an error).
    expect(parseSearchQuery('say "he said ""hi"""')).toBe('(say OR say*) AND "he said" AND "hi"');
  });

  it("returns null for empty or all-special input", () => {
    expect(parseSearchQuery("")).toBeNull();
    expect(parseSearchQuery("   ")).toBeNull();
    expect(parseSearchQuery('"  "')).toBeNull();
    expect(parseSearchQuery("*():^")).toBeNull();
  });

  it("treats a bare unquoted 'or' as the OR operator", () => {
    expect(parseSearchQuery("linux OR bsd")).toBe("(linux OR linux*) OR (bsd OR bsd*)");
    expect(parseSearchQuery('"linux code" OR bsd')).toBe('"linux code" OR (bsd OR bsd*)');
  });

  it("keeps a quoted or negated 'or' as a literal word", () => {
    expect(parseSearchQuery('"or"')).toBe('"or"');
    expect(parseSearchQuery("linux -or bsd")).toBe('((linux OR linux*) AND (bsd OR bsd*)) NOT (("or" OR or*))');
  });

  it("drops leading and trailing OR with nothing on one side", () => {
    expect(parseSearchQuery("OR linux")).toBe("(linux OR linux*)");
    expect(parseSearchQuery("linux OR")).toBe("(linux OR linux*)");
  });

  it("collects negations into a NOT clause subtracted from the positives", () => {
    expect(parseSearchQuery("linux -deprecated")).toBe("(linux OR linux*) NOT ((deprecated OR deprecated*))");
    expect(parseSearchQuery("linux -old -deprecated")).toBe(
      "(linux OR linux*) NOT ((old OR old*) OR (deprecated OR deprecated*))"
    );
    expect(parseSearchQuery('linux -"code review"')).toBe('(linux OR linux*) NOT ("code review")');
  });

  it("falls back to a plain search when every token is negated", () => {
    expect(parseSearchQuery("-linux")).toBe("(linux OR linux*)");
    expect(parseSearchQuery('-"code review"')).toBe('"code review"');
  });

  it("mixes AND, OR, and negation in one query", () => {
    expect(parseSearchQuery("linux network OR bsd -deprecated")).toBe(
      "((linux OR linux*) AND (network OR network*) OR (bsd OR bsd*)) NOT ((deprecated OR deprecated*))"
    );
  });
});
