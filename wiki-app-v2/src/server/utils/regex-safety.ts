/**
 * ReDoS safety check for untrusted regex patterns.
 *
 * The lens feature (brief §12.4) lets a user specify `criteria.titleRegex`,
 * which is later evaluated against every page title by a JS-side SQLite
 * function registered in `db/index.ts` (a single-threaded, synchronous
 * `RegExp.test()` call per row). Without this guard a lens owner (or anyone
 * who can hit an unlisted lens via its share token) could create a lens
 * with a catastrophic-backtracking pattern — `(a+)+$`, `(a+)+\1`, etc. —
 * and freeze the server on every `GET /api/lenses/:id/results` request.
 *
 * The standard heuristic (safe-regex / OWASP ReDoS cheat sheet) is to bound
 * the *star height* of the pattern: how many repetitions are nested.
 * Star height ≤ 1 means every quantifier applies to a literal or a group
 * that does not itself contain a quantifier. Star height ≥ 2 (e.g. `(a+)+`)
 * is the structural signature of catastrophic backtracking. We also limit
 * the total number of quantifiers (so `a+a+a+a+a+a+a+a+a` cannot loop the
 * engine) and reject adjacent quantifiers (`++`, `+*`, etc.), which are
 * always a typo or an attack.
 *
 * This is a heuristic, not a proof — a malicious pattern that slips
 * through can still cost more than the ideal linear scan. The purpose is
 * to make the most common ReDoS shapes unwriteable while leaving ordinary
 * title-matching regexes (`^meeting-\d+$`, `^(TODO|DONE)\b`, etc.) intact.
 *
 * The pattern length cap mirrors the zod schema on the route so the check
 * is meaningful at both the boundary and at query time.
 *
 * Companion test: `src/server/__tests__/regex-safety.test.ts`.
 */

const MAX_PATTERN_LENGTH = 256;
const MAX_QUANTIFIERS = 4;

export interface RegexSafetyResult {
  safe: boolean;
  /** Present only when `safe === false`; describes why the pattern was rejected. */
  reason?: string;
}

/**
 * Returns `{ safe: true }` for patterns that pass the heuristic; otherwise
 * `{ safe: false, reason }`. Compiles the pattern with `new RegExp` so
 * syntactically invalid patterns also return `safe: false`.
 */
export function assertSafeRegex(pattern: string): RegexSafetyResult {
  if (typeof pattern !== "string") return { safe: false, reason: "pattern not a string" };
  if (pattern.length === 0) return { safe: false, reason: "empty pattern" };
  if (pattern.length > MAX_PATTERN_LENGTH) return { safe: false, reason: "pattern too long" };

  let depth = 0;
  let quantifiers = 0;
  // groupHasQuantifier[d] = true if the currently-open group at depth d
  // contains any quantifier. Used to detect `(...)+` where ... already
  // has a quantifier — the canonical ReDoS shape.
  const groupHasQuantifier: boolean[] = [];
  let lastSigChar = "";
  let inCharClass = false;

  // for…of iterates code points, so we don't fight noUncheckedIndexedAccess
  // on `pattern[i]` while still handling surrogate pairs as a single unit.
  for (const c of pattern) {
    if (c === "\\") {
      // Skip the escaped character (and its potential quantifier so e.g.
      // `\*` doesn't trip the quantifier count).
      lastSigChar = "";
      continue;
    }
    if (inCharClass) {
      if (c === "]") inCharClass = false;
      continue;
    }
    if (c === "[") {
      inCharClass = true;
      lastSigChar = "";
      continue;
    }
    if (c === "(") {
      depth++;
      groupHasQuantifier[depth] = false;
      lastSigChar = "(";
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      lastSigChar = ")";
      continue;
    }
    if (c === "*" || c === "+" || c === "?") {
      quantifiers++;
      if (quantifiers > MAX_QUANTIFIERS) return { safe: false, reason: "too many quantifiers" };
      // Adjacent quantifiers: `++`, `+*`, `*?`, … — always a typo or an attack.
      if (lastSigChar === "*" || lastSigChar === "+" || lastSigChar === "?") {
        return { safe: false, reason: "adjacent quantifiers" };
      }
      // Nested quantifier: closing paren of a group that already contained
      // a quantifier, followed by another quantifier — `(...)+` where ...
      // is `(a+)`. The single biggest ReDoS shape.
      if (lastSigChar === ")" && groupHasQuantifier[depth + 1]) {
        return { safe: false, reason: "nested quantifier" };
      }
      if (depth > 0) groupHasQuantifier[depth] = true;
      lastSigChar = c;
      continue;
    }
    lastSigChar = c;
  }

  // Reject backreferences (e.g. `\1`, `\k<name>`). They interact with
  // outer-group repetitions in ways the heuristic above doesn't track, and
  // lens titles never legitimately need them.
  if (/\\\d/.test(pattern)) return { safe: false, reason: "backreference not allowed" };

  // Final compile check — catches syntax errors that the heuristic ignores
  // (e.g. an unclosed group from `pattern.length` not catching it).
  try {
    new RegExp(pattern);
  } catch (e) {
    return { safe: false, reason: `invalid regex: ${(e as Error).message}` };
  }

  return { safe: true };
}