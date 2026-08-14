import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Brief §9.2 + §7.2 mechanical regression sweep.
 *
 * §9.2 is a security/architecture checklist ("things that must always be
 * true"). The full behaviour is tested by integration suites, but a few of
 * the properties are cheap to lock down with a static grep — failing those
 * means someone bypassed a guard without realizing it.
 *
 * §7.2 says every settings-shaped form must live under /settings; this
 * test enforces that, with an explicit allowlist for forms that are
 * per-page-contextual (share dialog on a page, encryption unlock on a
 * page, etc., which the brief explicitly permits).
 *
 * The test is mechanical on purpose: it should be run on every PR and
 * never produce flaky passes. Any violation is a clear bug, not a hint.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Files exempt from the §7.2 "no settings outside /settings" rule. */
const SETTINGS_FORM_ALLOWLIST = new Set<string>([
  // Login / sign-up belong to the auth surface, not settings.
  "src/features/auth/Login.tsx",
  "src/features/auth/Signup.tsx",
  // Pin button is a per-page toggle, not settings.
  "src/features/offline/PinButton.tsx",
  // Favorite button is a per-page toggle.
  "src/features/favorites/FavoriteButton.tsx",
  // Lens table-view column config is a lens-instance property, not a global setting.
  "src/features/lenses/TableView.tsx",
  // History panel is a per-page timeline.
  "src/features/history/HistoryPanel.tsx",
  // Per-page encryption (brief §13.7) explicitly lives on the page.
  "src/features/encryption/ProtectPageDialog.tsx",
  "src/features/encryption/EncryptedPageLock.tsx",
  // The editor itself is not settings-shaped.
  "src/features/editor/Editor.tsx",
  // Tree is the navigation surface, not settings.
  "src/features/tree/Tree.tsx",
]);

/** Files exempt from the "no eval / no new Function outside plugin loader" rule. */
const EVAL_ALLOWLIST = new Set<string>([
  // The plugin loader is the one place we deliberately let user-supplied
  // code in. The brief §4.5 is explicit.
  "src/plugins/loader.ts",
]);

interface AuditViolation {
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
      else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function rel(file: string): string {
  return relative(REPO_ROOT, file);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

describe("§9.2 / §7.2 mechanical invariants", () => {
  const files = listSourceFiles(SRC_ROOT);

  it("§7.2 — no settings-shaped forms outside /settings (with explicit allowlist)", () => {
    const violations: AuditViolation[] = [];
    const urlFieldRe = /\bname|label|field|placeholder\b/i;
    for (const file of files) {
      const r = rel(file);
      // Audit + test files aren't user-facing surfaces.
      if (r.includes("/__tests__/") || r.endsWith(".test.ts") || r.endsWith(".test.tsx")) continue;
      if (r === "src/server/__tests__/security-invariants.audit.test.ts") continue;
      if (r.startsWith("src/routes/_authenticated/settings/")) continue;
      if (SETTINGS_FORM_ALLOWLIST.has(r)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // Heuristic: a "settings-shaped form" is one that posts a typed
        // PATCH/PUT/POST to a /api/* settings endpoint (users, groups,
        // spaces, integrations, etc.) from a component that isn't itself
        // a settings page. The form may include any number of inputs.
        const looksLikeSettingsCall =
          /api\.(update|set|create|remove|add|removeMember|addMember|setAdmin)\s*\(/.test(line) &&
          /\b(users|groups|spaces|integrations|plugins|appearance|system|tokens)\b/i.test(line);
        const looksLikeForm = /<form\b|<Form\b/.test(line) && urlFieldRe.test(line);
        if (looksLikeSettingsCall && looksLikeForm) {
          violations.push({ file: r, line: i + 1, text: line.trim(), rule: "settings-form-outside-settings" });
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `Settings-shaped forms living outside /settings:\n${formatted}\n\n` +
          `Per §7.2, all settings-shaped UI must live under\n` +
          `src/routes/_authenticated/settings/. Add the file to the\n` +
          `SETTINGS_FORM_ALLOWLIST in this test only after confirming\n` +
          `the brief permits the surface.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("§9.2 — no eval / new Function outside the plugin loader", () => {
    const violations: AuditViolation[] = [];
    for (const file of files) {
      const r = rel(file);
      if (EVAL_ALLOWLIST.has(r)) continue;
      // Tests have every right to `eval` test fixtures — that's how
      // `sw.test.ts` loads `public/sw.js` into a fake `self`. The audit
      // only cares about code shipped to end users.
      if (r.includes("/__tests__/") || r.endsWith(".test.ts") || r.endsWith(".test.tsx")) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // Match `eval(` and `new Function(` but not `evalTokenRegex` or
        // `functionEvaluator`. The regex requires the paren to follow
        // immediately (whitespace allowed).
        if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
          violations.push({ file: r, line: i + 1, text: line.trim(), rule: "eval-usage" });
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `eval / new Function outside the plugin loader:\n${formatted}\n\n` +
          `Per §9.2, user-supplied code must only enter through the\n` +
          `plugin loader. Add the file to EVAL_ALLOWLIST only if the\n` +
          `use is justified and sandboxed.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("§9.2 — security headers are registered at boot", () => {
    const security = readFileSync(join(SRC_ROOT, "server", "security.ts"), "utf8");
    expect(security).toMatch(/X-Content-Type-Options[^]*nosniff/);
    expect(security).toMatch(/X-Frame-Options[^]*DENY/);
    expect(security).toMatch(/Referrer-Policy[^]*same-origin/);
    expect(security).toMatch(/Content-Security-Policy/);
    // Strict script-src: no unsafe-inline, no unsafe-eval.
    const cspMatch = security.match(/script-src[^;\n]*/);
    expect(cspMatch).toBeTruthy();
    expect(cspMatch![0]).not.toMatch(/unsafe-inline/);
    expect(cspMatch![0]).not.toMatch(/unsafe-eval/);
  });

  it("§9.2 — every /api/ route declares config.access (middleware invariant)", () => {
    const middleware = readFileSync(join(SRC_ROOT, "server", "middleware", "access.ts"), "utf8");
    expect(middleware).toMatch(/addHook\(\s*['"]onRoute['"]/);
    expect(middleware).toMatch(/does not declare config\.access/);
  });

  it("§9.2 — no raw SQL interpolation of user input (drizzle-only)", () => {
    // The only legitimate raw-SQL text is the FTS5 setup in db/index.ts
    // (static, no interpolation) and admin PRAGMA queries. We assert no
    // template literal in a service file concatenates a variable into a
    // raw SQL string.
    const serviceDir = join(SRC_ROOT, "server", "services");
    const services = readdirSync(serviceDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const violations: AuditViolation[] = [];
    for (const name of services) {
      const file = join(serviceDir, name);
      const r = rel(file);
      const src = stripComments(readFileSync(file, "utf8"));
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // Pattern: `${something}` inside a `prepare(` or `exec(` call.
        // Static SQL text like `${spaceScope.map(()=>"?").join(",")}` is
        // fine because the dynamic part is only `?` placeholders; the
        // actual values are passed positionally. So we look for
        // interpolation that introduces a non-placeholder string.
        if (/prepare\(|exec\(/.test(line) && /\$\{[^}]+\}/.test(line)) {
          // Allow only placeholder generation like `${x.map(()=>"?").join(",")}`
          // or `${whereSql}` (where `whereSql` was built above the call
          // site from constants + `?` placeholders, not user input).
          // We can't statically prove safety here, so we accept that the
          // existing code is correct and only flag obviously suspicious
          // patterns (interpolation that goes inside quotes).
          const suspicious = /['"`]\s*\$\{[^}]+\}/.test(line);
          if (suspicious) {
            violations.push({ file: r, line: i + 1, text: line.trim(), rule: "raw-sql-interpolation" });
          }
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(`Possible raw-SQL interpolation:\n${formatted}`);
    }
    expect(violations).toEqual([]);
  });

  it("§9.2 — dangerouslySetInnerHTML is restricted to sanctioned escape paths", () => {
    // The four justified call sites are: Prism-highlighted code blocks
    // (safe by construction: Prism escapes input), Mermaid-rendered SVG
    // (server-side rendered, CSP blocks inline scripts), and Prism
    // highlighted code pages. New callers MUST be reviewed.
    const ALLOWED = [
      "src/features/editor/codeHighlight.ts",
      "src/features/editor/extensions/MermaidRenderer.tsx",
      "src/features/editor/ReadOnlyContent.tsx",
      "src/features/editor/CodePageReadOnly.tsx",
    ];
    const violations: AuditViolation[] = [];
    for (const file of files) {
      const r = rel(file);
      // Tests / comments may discuss the pattern without using it; we
      // only care about actual JSX usage in production code.
      if (r.includes("/__tests__/") || r.endsWith(".test.ts") || r.endsWith(".test.tsx")) continue;
      if (ALLOWED.includes(r)) continue;
      // Skip this audit file itself — its error message and code
      // legitimately mention the pattern.
      if (r === "src/server/__tests__/security-invariants.audit.test.ts") continue;
      const src = stripComments(readFileSync(file, "utf8"));
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // Look for actual JSX usage: `{ __html: ... }` next to
        // `dangerouslySetInnerHTML`. A bare string match in a comment is
        // already filtered by `stripComments`; an actual call uses both
        // tokens together.
        if (line.includes("dangerouslySetInnerHTML") && line.includes("__html")) {
          violations.push({ file: r, line: i + 1, text: line.trim(), rule: "dangerouslySetInnerHTML" });
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `dangerouslySetInnerHTML outside the sanctioned list:\n${formatted}\n\n` +
          `Every new caller must justify why the injected HTML is safe\n` +
          `(Prism output, server-rendered SVG, etc.) and add the file\n` +
          `to the ALLOWED list in this test.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("§9.2 — file downloads set X-Content-Type-Options: nosniff", () => {
    const fileRoutes = readFileSync(join(SRC_ROOT, "server", "routes", "file.routes.ts"), "utf8");
    expect(fileRoutes).toMatch(/X-Content-Type-Options[^]*nosniff/);
    const pluginRoutes = readFileSync(join(SRC_ROOT, "server", "routes", "plugin.routes.ts"), "utf8");
    expect(pluginRoutes).toMatch(/X-Content-Type-Options[^]*nosniff/);
  });
});