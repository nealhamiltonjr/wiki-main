import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Brief §5.3 — theming one-file-change test.
 *
 * The rule: every color, radius, font, and animation value the app renders
 * is sourced from `src/styles/tokens.css` and nothing else. Changing the
 * accent color, border radius, or font in tokens.css must propagate to the
 * chrome, the editor prose, and every shadcn/ui component with zero
 * component-code edits.
 *
 * This test enforces the rule mechanically:
 *   1. Source-tree scan — no hex color, no rgb()/rgba()/hsl(), no Tailwind
 *      named-color utility (e.g. `text-rose-600`) outside the two whitelisted
 *      files. A literal here means someone bypassed the token system.
 *   2. Token coverage — every value the rest of the app references via
 *      `var(--…)` must actually be defined in tokens.css under light, dark,
 *      or contrast themes.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const TOKENS_FILE = join(SRC_ROOT, "styles", "tokens.css");
const APP_CSS_FILE = join(SRC_ROOT, "styles", "app.css");

const WHITELIST = new Set<string>([
  relative(REPO_ROOT, TOKENS_FILE),
  relative(REPO_ROOT, APP_CSS_FILE),
]);

// Tailwind named-color palettes. Each entry is the palette segment that
// follows the prefix in a utility like `text-rose-600`.
const NAMED_COLOR_PALETTES = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple",
  "fuchsia", "pink", "rose",
];
const COLOR_PREFIXES = ["text", "bg", "border", "fill", "stroke", "ring", "outline", "divide", "from", "to", "via", "shadow", "decoration", "accent", "caret", "placeholder"];

const NAMED_COLOR_RE = new RegExp(
  `(?<![a-zA-Z0-9-])(${COLOR_PREFIXES.join("|")})-(${NAMED_COLOR_PALETTES.join("|")})-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\\/(?:\\d{1,3}))?`,
  "g",
);

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const RGB_COLOR_RE = /\brgba?\s*\(/g;
const HSL_COLOR_RE = /\bhsla?\s*\(/g;

interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      if (st.isDirectory()) walk(full);
      else if (/\.(?:tsx?|css|mjs|cjs|jsx?)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function scanFile(file: string): Violation[] {
  const rel = relative(REPO_ROOT, file);
  if (WHITELIST.has(rel)) return [];
  const raw = readFileSync(file, "utf8");
  // Strip /* ... */ block comments first so this test's own docstring doesn't
  // trip itself on patterns it describes.
  const noBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  const lines = noBlockComments.split(/\r?\n/);
  const out: Violation[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const stripped = line.replace(/\/\/.*$/, "");

    if (HEX_COLOR_RE.test(stripped)) {
      HEX_COLOR_RE.lastIndex = 0;
      out.push({ file: rel, line: i + 1, text: line.trim(), rule: "hex-color" });
    }
    if (RGB_COLOR_RE.test(stripped)) {
      RGB_COLOR_RE.lastIndex = 0;
      out.push({ file: rel, line: i + 1, text: line.trim(), rule: "rgb-color" });
    }
    if (HSL_COLOR_RE.test(stripped)) {
      HSL_COLOR_RE.lastIndex = 0;
      out.push({ file: rel, line: i + 1, text: line.trim(), rule: "hsl-color" });
    }
    const named = stripped.match(NAMED_COLOR_RE);
    if (named) {
      out.push({ file: rel, line: i + 1, text: line.trim(), rule: "named-color-utility" });
    }
  }
  return out;
}

describe("§5.3 theming — one-file-change enforcement", () => {
  const sourceFiles = listSourceFiles(SRC_ROOT);
  const allViolations = sourceFiles.flatMap(scanFile);

  it("no literal colors or named-color utilities outside tokens.css/app.css", () => {
    if (allViolations.length > 0) {
      const formatted = allViolations
        .map((v) => `  ${v.file}:${v.line} [${v.rule}]\n    ${v.text}`)
        .join("\n");
      throw new Error(
        `Found ${allViolations.length} literal-color violation(s) outside the token source:\n` +
          `${formatted}\n\n` +
          `Every color must live in src/styles/tokens.css. Use the existing\n` +
          `tokens (bg-primary, text-danger, etc.) or add a new one to tokens.css.`,
      );
    }
    expect(allViolations).toEqual([]);
  });

  it("all referenced var(--…) tokens are defined in tokens.css", () => {
    const tokenText = readFileSync(TOKENS_FILE, "utf8");
    const tokenDefRe = /--([a-zA-Z0-9-]+)\s*:/g;
    const defined = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = tokenDefRe.exec(tokenText)) !== null) defined.add(m[1] ?? "");

    const missing = new Map<string, Violation[]>();
    const refRe = /\bvar\(\s*--([a-zA-Z0-9-]+)\s*\)/g;
    for (const file of sourceFiles) {
      const rel = relative(REPO_ROOT, file);
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const re = new RegExp(refRe.source, "g");
        let rm: RegExpExecArray | null;
        while ((rm = re.exec(line)) !== null) {
          const name = rm[1] ?? "";
          if (defined.has(name)) continue;
          const list = missing.get(name) ?? [];
          list.push({ file: rel, line: i + 1, text: line.trim(), rule: "undefined-token" });
          missing.set(name, list);
        }
      }
    }

    if (missing.size > 0) {
      const formatted = [...missing.entries()]
        .map(([name, hits]) => `  --${name} (${hits.length} use${hits.length === 1 ? "" : "s"}):\n${hits.map((h) => `    ${h.file}:${h.line}`).join("\n")}`)
        .join("\n");
      throw new Error(
        `Tokens referenced via var(--…) but not defined in tokens.css:\n${formatted}`,
      );
    }
    expect(missing.size).toBe(0);
  });

  it("every light/dark/contrast theme defines the full set of color roles", () => {
    // §5 expects the three themes to cover the same semantic surface for
    // colors. If dark or contrast drops a color role that a component
    // references, that role falls back to the light value and a visual bug
    // sneaks in silently. Non-color roles (typography, spacing, radius,
    // shadow) are intentionally defined once in :root and inherited by every
    // theme — they don't need to be re-declared per theme.
    const tokenText = readFileSync(TOKENS_FILE, "utf8");
    const blocks = [":root", "[data-theme=\"dark\"]", "[data-theme=\"contrast\"]"];
    const roleRe = /^\s*--([a-zA-Z0-9-]+)\s*:/gm;

    // Roles that must be re-declared per theme (everything else — fonts,
    // radii, shadows, timing — lives in :root only).
    const COLOR_ROLE_PATTERNS = [
      /^background$/,
      /^surface(-hover|-elevated)?$/,
      /^foreground$/,
      /^text-(secondary|muted)$/,
      /^border(-strong)?$/,
      /^primary(-hover|-foreground)?$/,
      /^link$/,
      /^danger(-hover)?$/,
      /^success$/,
      /^warning$/,
      /^info(-hover|-bg|-border)?$/,
      /^focus-ring$/,
      /^selection$/,
      /^code-(bg|text)$/,
      /^inline-code-(bg|text)$/,
      /^blockquote-(bg|border)$/,
      /^table-header-bg$/,
      /^highlight-(bg|text)$/,
      /^scrim$/,
    ];

    const rolesByTheme: Record<string, Set<string>> = {};
    for (const sel of blocks) {
      const start = tokenText.indexOf(sel);
      if (start < 0) {
        throw new Error(`tokens.css is missing the ${sel} block`);
      }
      const slice = tokenText.slice(start);
      const end = slice.indexOf("\n}\n", start);
      const section = end > 0 ? slice.slice(0, end) : slice;
      const set = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = roleRe.exec(section)) !== null) set.add(m[1] ?? "");
      rolesByTheme[sel] = set;
    }

    const themes = Object.keys(rolesByTheme);
    const first = rolesByTheme[themes[0]!]!;
    const colorRolesInLight = [...first].filter((r) =>
      COLOR_ROLE_PATTERNS.some((p) => p.test(r)),
    );

    for (const role of colorRolesInLight) {
      for (const t of themes.slice(1)) {
        expect(rolesByTheme[t]!.has(role)).toBe(true);
      }
    }
  });
});
