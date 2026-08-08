# Agent Brief: Redesign & Partial Rewrite of the Wiki / Knowledge-Base App

**You are an AI coding agent (OpenHands) tasked with redesigning and rebuilding this application.**
It is not just a wiki — it's meant to be a full-featured documentation center and personal knowledge
base, in the spirit of Trilium Notes: hierarchical *and* cross-linked, richly structured, and
genuinely programmable, not just a page tree with a rich-text editor. §13 covers the specific
knowledge-base-depth features this implies; read it with the same weight as everything before it.
This is a **redesign from step one, with reuse of proven parts of the existing codebase** — not a
blind from-scratch build, and not a patch job on the current structure either. Read this brief fully
before writing any code. It tells you *what* to build, *in what order*, *what to keep*, *what to
throw away*, and *how to prove each step actually works* before moving to the next one.

The existing codebase (`wiki-app/`) and its `README.md` are your **reference implementation**. They
tell you what the product does today, what already works, and — just as importantly — a documented
history of real bugs that were found and fixed the hard way. Do not repeat them.

---

## 0. Why this redesign, in one paragraph

The current app works, but three structural decisions are fighting the product every day: routing
was hand-assembled and fragile (fixing one route broke another), styling is split across a hand-rolled
CSS system and Tailwind bolted on later (so a "look and feel" change touches dozens of files instead
of one), and the "plugin engine" is a hardcoded toggle map, not something a plugin can actually be
*installed into*. None of these are reasons to discard the product — the data model, the permission
algorithm, and the security hardening are sound and proven. They're reasons to rebuild the
*structure* around those proven parts so the same mistakes can't recur.

---

## 1. Non-negotiable outcomes

These are the specific things that went wrong before. Each one of them is a concrete, testable
acceptance criterion later in this document — not a vibe.

1. **Changing the look and feel must never require touching component code.** One token file
   controls color, spacing, radius, and type. Today it doesn't; fix that from step one.
2. **The plugin engine is real.** An admin uploads a plugin (a zip), the engine validates it,
   registers what it declares, and it runs — without editing core code. Today it's a toggle map;
   that is not a plugin engine, and this rebuild must not reproduce it.
3. **The editor canvas is a single pane.** One visual container, start to finish, in both view and
   edit mode. Nested boxes, stray outlines, and selection artifacts that "trap" the cursor are a
   *regression*, not an acceptable rendering quirk — this exact bug ate real time in the current app
   and the root structural cause (positioned overlay elements accidentally wrapping content instead
   of floating outside it) must be designed out, not patched around.
4. **Settings live in one place.** A single `/settings` area with clear sub-sections. No permission
   dialogs, attribute panels, or config UI scattered piecemeal across other parts of the app outside
   deliberate, deep-linked entry points.
5. **Code stays small and easy to extend.** No abstraction gets built until a second real consumer
   needs it. Comments explain invariants and past bugs, not the obvious.

---

## 2. What ships from the old app vs. what gets rebuilt

| Keep (port the logic, re-test it) | Rebuild (structural cause of past pain) |
|---|---|
| Pages/branches/spaces/groups data model | Client routing (React Router → TanStack Router) |
| The permission algorithm (`resolveAccess`) and its test suite | Styling (dual Tailwind+hand-rolled CSS → one token-driven system) |
| Block-ID stability approach | Plugin "system" (toggle map → real loader + manifest) |
| Git-backed export/versioning pipeline | Editor canvas DOM structure (nested containers → single pane + portal overlays) |
| Token engine (share links + API tokens, one engine, branch/space/account scope) | Settings UI (scattered panels → one consolidated area) |
| better-auth wiring, incl. rate limiting and trusted-origins config | — |
| Search (FTS5) — **including the snippet-escaping fix** | — |
| File-upload hardening (MIME allowlist, forced download, nosniff) | — |
| Baseline security headers (CSP, nosniff, frame-options) | — |
| MCP server (tools: list_spaces/get_page/search_pages/create_page/get_page_tree) | — |
| Collab single-placement rule (Hocuspocus/Yjs) | — |

The right column is not "these features are wrong" — it's "these are the four structural decisions
that caused the pain described in §0, plus the one DOM bug that cost the most debugging time." Ported
code should be **read and re-tested**, not copy-pasted blind — some of it references the old
client/server shape and needs adjusting to the new one.

---

## 3. Target stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict | Shared types between client and server via a `shared/` package |
| Client framework | **React 19** | Keeps the most mature Tiptap integration, `react-arborist` for the tree, and `shadcn/ui` for polish — all three are meaningfully weaker outside React (see §3.1) |
| Client router | **TanStack Router** (standalone/library mode — NOT TanStack Start) | Full compile-time type safety on routes, params, and loader data. This is what actually fixes "fix one route, break another": the router won't compile an ambiguous or overlapping route tree. Stable since Dec 2023, in wide production use. Do **not** reach for TanStack Start or Next.js — see §3.1. |
| Build tool | Vite | Already proven in this project; fast HMR, clean production builds |
| Server framework | **Fastify** (kept) | Already proven — permission middleware, error handling, and file/upload hardening are sound. Rebuild its *internal structure* (§3.2), not the framework choice |
| DB | SQLite + Drizzle, **one connection** | The old app opened a second raw `better-sqlite3` connection for collab persistence — don't repeat that. One `db/index.ts` module, imported everywhere, including the collab service |
| Auth | better-auth | Keep the existing config approach: explicit `rateLimit`, explicit `trustedOrigins` (the `192.168.*:*` wildcard is intentional — this runs in Docker with host-network mapping) |
| Editor | Tiptap 3 + Yjs + Hocuspocus | Framework-agnostic core; React bindings are the most mature of any framework's |
| Tree UI | `react-arborist` | Virtualized, drag-and-drop, inline rename, and search in one library — no real equivalent exists outside React |
| Styling | **Tailwind v4 + `shadcn/ui`, one system only** | See §5 for the token architecture that makes look-and-feel changes cheap |
| Validation | Zod, in a `shared/` module | Same schemas for client forms, server routes, and tests |
| Content VCS | `simple-git` (or whatever the current git.service.ts already proved out) | Keep the existing export/commit pipeline design |
| Tests | Vitest (unit + integration, real SQLite) + Playwright (real browser flows) | See §9 — this is the most important section in this document |

### 3.1 Why not SvelteKit, Next.js, or TanStack Start

This was evaluated and rejected deliberately, not by default:

- **SvelteKit** solves the routing problem too, but at a real cost specific to this app: Tiptap's
  official Svelte integration guide is documented (by Tiptap's own maintainers) as not updated for
  Svelte 5's runes model, and the most popular community wrapper had breaking compatibility issues
  when Svelte 5 shipped. There's no Svelte equivalent to `react-arborist`. This app's hardest,
  buggiest work has consistently been deep editor/tree customization — don't move that work onto
  thinner ice.
- **Next.js**'s core value (React Server Components, server-rendering non-interactive content) doesn't
  fit this app's shape. Almost the entire authenticated app is client-interactive — the editor, the
  tree, comments, live collab. You'd mark nearly everything `"use client"` and pay Next's conceptual
  overhead for little of its benefit.
- **TanStack Start** (the full-stack meta-framework built on TanStack Router) is still at
  release-candidate stage as of this brief, with experimental RSC support. Don't bet a project that
  already suffered from architectural fragility on a pre-1.0 framework. Use TanStack **Router** alone
  — it's the mature, stable part.

### 3.2 Server restructuring (within Fastify — not a framework change)

- **One SQLite connection.** `collab.service.ts` must import the same `db`/`sqlite` handle as every
  other service. No second `new Database(...)` call anywhere in the codebase — grep for it in CI if
  you want a hard guardrail.
- **Security headers, rate limiting, and file-serving hardening are day-one requirements, not
  retrofits.** Port these directly from the current app rather than rediscovering them:
  - Global `onSend` hook: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy: same-origin`, and a CSP (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`
    — inline *styles* only, never inline *script* — `object-src 'none'`, `frame-ancestors 'none'`).
  - File-serving: an inline-safe MIME allowlist (raster images only — **not** `image/svg+xml`, which
    can carry a script); anything outside the allowlist is served with
    `Content-Disposition: attachment`; `nosniff` on every file response regardless of type.
  - Search snippets: FTS5's `snippet()` output must be HTML-escaped before it reaches the client,
    with the highlight markers escaped separately so `<mark>` tags survive. Do not render raw page
    text into `dangerouslySetInnerHTML` — this was a real, working stored-XSS bug in the current app,
    found and fixed; port the fix, not the bug.
  - `better-auth`'s `rateLimit` explicitly enabled (don't rely on framework defaults), plus a small
    in-memory limiter on the public share-link password-check endpoint.
- **Every route declares its access config.** Keep the existing pattern: the permission middleware
  refuses to boot the server if a registered route has no `config.access` — this caught a real bug
  before and should stay a hard invariant, not a convention.

---

## 4. Plugin engine — full design

This is the single biggest structural gap in the old app: a toggle map is not a plugin engine.
Build the real thing.

### 4.1 What "real" means here

An admin can **upload a plugin as a zip through the settings UI**, the server validates it, extracts
it, and the plugin's declared capabilities become active — without a code change or redeploy.

### 4.2 Plugin package layout

```text
plugin.zip
├── plugin.json          # manifest — see §4.3
├── client/
│   └── index.js          # pre-built ESM bundle; the plugin author builds this themselves
└── server/               # optional — only if the plugin declares server capabilities
    └── index.js
```

On upload, the server:
1. Unzips into a temp directory.
2. Validates `plugin.json` against a Zod schema (id, name, version, declared capabilities — reject
   anything with a field it doesn't recognize rather than silently ignoring it).
3. Checks `id` is unique and filesystem-safe (no path traversal in the id or any declared file path —
   validate this explicitly, it's the obvious attack surface for a feature that accepts uploaded code).
4. Moves the validated package into `plugins/<id>/` and records it in a `plugins` table
   (`id`, `version`, `enabled`, `installed_at`).
5. Does **not** auto-enable it — an admin explicitly flips it on in the settings UI after install.

### 4.3 Manifest schema (`plugin.json`)

```json
{
  "id": "web-clipper",
  "name": "Web Clipper",
  "version": "1.0.0",
  "capabilities": {
    "tiptapExtensions": true,
    "slashCommands": true,
    "toolbarItems": false,
    "settingsPanel": true,
    "embedTypes": false,
    "serverRoutes": false
  }
}
```

Only declared capabilities may be registered — if a plugin's `client/index.js` calls
`registerServerRoute(...)` but `serverRoutes` wasn't declared `true`, the registration call throws.
This makes the manifest a real contract, not documentation.

### 4.4 Client-side registration API

The plugin's `client/index.js` default-exports a single `register(api: PluginAPI)` function. The
host app dynamically `import()`s each enabled plugin's bundle at startup from a served static path
(`/plugins/<id>/client/index.js`) and calls `register()` with a scoped API object:

```ts
interface PluginAPI {
  registerTiptapExtension(ext: Extension | Node | Mark): void;
  registerSlashCommand(cmd: SlashCommandDef): void;
  registerToolbarItem(item: ToolbarItemDef): void;
  registerSettingsPanel(panel: SettingsPanelDef): void;
  registerEmbedType(type: EmbedTypeDef): void;
}
```

Content-model extensions (new Tiptap nodes/marks) must **degrade gracefully when the plugin is
disabled later** — a page containing a disabled plugin's node type should still open and render
(even if just as inert/unstyled content), never throw and block the whole document from loading.
Test this explicitly: save a page with a plugin-provided node, disable the plugin, reload the page.

### 4.5 Server-side registration (only for plugins that declare `serverRoutes`)

A plugin's `server/index.js` exports a Fastify plugin function. It's registered under
`/api/plugins/<id>/*` and goes through **the exact same permission middleware as every core route** —
a plugin route with no `config.access` fails to boot, identically to a core route. Plugin server code
is only ever loaded from disk by the instance operator (the person who uploaded the zip) — v1 has no
remote/marketplace auto-install. Trust boundary: uploading a plugin is an admin-only action, and
admins are trusted operators of their own instance, same as installing any self-hosted software.

### 4.6 Reference plugins to build (prove the API, don't just design it)

Build these two as real, working plugins — not core code with a plugin label on it:

1. **Web clipper** — port the existing (weak) `clip.routes` functionality as the first real plugin.
   If it can't be built as a plugin with the API above, the API is wrong; fix the API, not the plugin.
2. **Draw.io embed** — a new embed type (Neal named this specifically as a "future feature" test
   case). This exercises `registerEmbedType` and proves the plugin engine can add genuinely new
   content types, not just UI chrome.

If both of these work without a single line of core-code change, the plugin engine is done. If
either needs a core-code change to work, that's a signal the plugin API is missing a capability —
add it to the API, not as a one-off special case for that plugin.

---

## 5. Theming architecture — so "look and feel" is a one-file change

### 5.1 Root cause of the old pain

The old app has a 2,300+ line hand-rolled `theme.css` *and* Tailwind utility classes in active use
side by side, added at different times for different reasons, never unified. Changing the accent
color meant hunting through both systems.

### 5.2 The fix: one token layer, everything reads from it

- A single CSS file defines every design token as a CSS custom property: color roles (not raw
  colors — `--color-accent`, `--color-surface`, `--color-border`, etc.), spacing scale, radius scale,
  font stack, type scale.
- Tailwind v4's CSS-based `@theme` config reads directly from these custom properties — Tailwind
  utility classes and hand-written CSS pull from the exact same source, not two parallel palettes.
- The editor's prose styles (headings, code blocks, blockquotes, task lists) consume the same tokens
  — no separate "editor theme."
- Light/dark mode is a token-value swap (`[data-theme="dark"] { --color-surface: ... }`), never a
  component-level `if (dark) {...}` branch.
- `shadcn/ui` components are themed via the same CSS variables it already expects (`--background`,
  `--foreground`, etc. mapped onto the token names above) — don't maintain a second theme
  configuration for shadcn separately from the rest of the app.

### 5.3 Acceptance test for this section

Changing the accent color, border radius, or font across the *entire app* — chrome, editor prose,
and every `shadcn/ui` component — must be achievable by editing values in **one file**. Write this as
an actual test/checklist item before calling theming "done": pick a token, change it, confirm it
propagates everywhere with zero component-code edits.

---

## 6. Editor canvas — single-pane requirement

### 6.1 The bug this section exists to prevent

The old app had a real, extensively-debugged issue where a second, blue-bordered box would appear
around editor content — most likely a ProseMirror `NodeSelection` (or a wrapping DOM element used to
anchor the drag-handle/hover UI) that didn't behave like the floating overlay it was supposed to be.
This is not a CSS polish issue, it's a structural DOM mistake, and it must be designed out from the
start:

### 6.2 Rules for any editor-adjacent UI (drag handle, bubble menu, slash command menu, comment
hover popup)

- **Never wrap editor content in an extra container element to anchor UI to it.** All positioned
  UI — the drag handle, the bubble/floating menu, the slash command popup — is a **sibling** element,
  positioned via `position: fixed` or `position: absolute` and `getBoundingClientRect()` coordinates
  (or a portal rendered outside the ProseMirror root entirely). It floats *next to* content, it never
  becomes a parent *of* content.
- **Exactly one visual container** exists around the writing surface — the outer `EditorContent`
  wrapper with its border — in both view mode and edit mode. No second container should ever appear
  as a side effect of focusing, typing, or any plugin's UI.
- If a feature needs to visually indicate "this block is targeted" (for drag-and-drop, for example),
  use a **decoration** (ProseMirror `Decoration.widget` or a CSS class toggled on the existing node's
  own element) — never an inserted wrapping element.

### 6.3 Acceptance test for this section

An automated test (Playwright or a DOM-structure assertion in a component test) that: opens a blank
page, clicks into the canvas, types several characters, and asserts **exactly one** bordered/outlined
container exists around the content the whole time. This is the direct regression test for the bug
described in §6.1 — write it before the editor is considered done, not after a user reports the bug
again.

---

## 7. Settings — single consolidated area

### 7.1 Information architecture

One route, `/settings`, with a left-hand sub-navigation:

- **Profile** — the signed-in user's own account settings
- **Appearance** — theme token overrides (if you choose to expose any to end users beyond admin)
- **Spaces** — space list, per-space default role
- **Groups & Permissions** — group membership, capabilities, the "no-expiration" grant group
- **Users** — admin user management, suspension, role changes
- **Plugins** — install (upload), enable/disable, per-plugin settings panels (rendered here via
  `registerSettingsPanel`, not as separate floating panels elsewhere in the app)
- **Integrations** — Git remote config, SSO provider config (Google/GitHub/Authentik)
- **Tokens** — API token management (share-link management can stay page-contextual, since a share
  link is tied to a specific page's share action — but *token policy* settings like "who can grant
  no-expiration" belongs here)
- **System** — encryption key status, storage paths, environment info (read-only diagnostics)
- **Admin / Danger zone** — anything destructive or instance-wide

### 7.2 The rule this section enforces

No settings-shaped UI exists **outside** `/settings` except where it's genuinely page-contextual (a
page's own Share dialog, a branch's own Permissions dialog reached via right-click) — and even those
should deep-link into the relevant `/settings` sub-section for anything beyond that one immediate
action, rather than duplicating controls. Before calling this section done, do an actual audit pass:
grep the component tree for anything that looks like a settings form or toggle living outside
`routes/settings/*`, and either move it or justify in a comment why it's deliberately page-contextual.

---

## 8. Implementation order

Work in vertical slices. **Each slice ends with a testing gate — do not start the next slice until
the current one's gate passes for real** (see §9 for what "for real" means).

1. **Skeleton** — Vite + React 19 + TanStack Router shell, Tailwind v4 + the token file from §5,
   `shadcn/ui` base install, empty authenticated/public layout split, a health-check route.
   *Gate:* typecheck clean; one Playwright test confirms the app loads with zero console errors.

2. **Server foundation** — Fastify skeleton, the single Drizzle/SQLite connection module, better-auth
   wired with explicit `rateLimit` and `trustedOrigins` from day one, the security headers from §3.2
   registered globally from day one (not bolted on later).
   *Gate:* integration test boots the real app via `.inject()`, signs up, logs in, gets a session.

3. **Schema + permission algorithm** — port the pages/branches/spaces/groups schema and the
   `resolveAccess` function, porting its existing test suite alongside it rather than re-deriving the
   test cases from memory.
   *Gate:* the ported permission test suite passes unmodified in its assertions (only import paths
   should need to change).

4. **Spaces + tree, read-only** — `react-arborist` rendering the accessible branch tree, no editor yet.
   *Gate:* Playwright: log in, see the tree populated with real data from a seeded test space.

5. **Page read + Tiptap editor** — read-only first, then editable with OCC save and block IDs, built
   to the single-pane rules in §6 from the start (not retrofitted).
   *Gate:* the DOM-structure test from §6.3, plus a Playwright test: type content, reload the page,
   confirm it persisted.

6. **Branch mutations** — create, rename, move, clone, delete placement, delete page. Port the
   regression tests for past bugs found in this area (nested page creation, sibling-branch access
   scoping, etc.) rather than re-discovering them.
   *Gate:* those ported regression tests pass.

7. **Files/uploads** — port the MIME-allowlist + forced-download + `nosniff` hardening from §3.2 as
   part of building the feature, not as a follow-up patch.
   *Gate:* port the file-hardening regression test (upload a file claiming `text/html`, confirm it's
   forced to download with `nosniff` set; confirm an allowlisted image type stays inline).

8. **Search** — FTS5 index, with the snippet-escaping fix from §3.2 built in from the start.
   *Gate:* port the stored-XSS regression test (literal HTML typed as plain page text must come back
   escaped in the snippet, with `<mark>` highlight tags still intact).

9. **Comments, backlinks, favorites, notifications** — core quality parity with the old app.
   *Gate:* integration tests per feature; a Playwright pass exercising each from the UI once.

10. **Git flush pipeline** — Markdown export + commit queue, history read API.
    *Gate:* `git log` on the test repo shows a real commit with the page's id in the message.

11. **Collab** — Hocuspocus wired to the *same* DB connection from step 2 (no second connection),
    single-placement rule enforced at `onAuthenticate`.
    *Gate:* collab auth test; a test confirming a multi-placement page is rejected for live collab.

12. **Plugin engine** — the loader, manifest validation, `PluginAPI`, and the admin upload UI from §4.
    *Gate:* upload a trivial "hello world" reference plugin through the real UI, confirm it registers
    and its effect (e.g., a slash command) actually works end-to-end in the running editor.

13. **First-party plugins** — web clipper and the Draw.io embed, built *as* plugins per §4.6.
    *Gate:* both work with zero core-code changes. If either needs one, fix the `PluginAPI` and retry.

14. **Settings consolidation** — build the full `/settings` IA from §7, including the audit pass for
    settings-shaped UI living elsewhere.
    *Gate:* the audit pass in §7.2 finds nothing left to move (or has a documented, deliberate
    exception for each page-contextual control that remains).

15. **Theming polish pass** — fill out the full token set, light/dark, run the acceptance test in
    §5.3 for real.
    *Gate:* the one-file-change test in §5.3 passes.

16. **Users/groups/admin UX polish.**

17. **Full regression pass** — the complete Vitest + Playwright suite, plus the manual "simulate real
    usage" checklist in §9.4.

Do not build settings UI polish, theming polish, or plugin UI chrome before save/tree/permissions
work in steps 1–8 is solid — the old app's own retrospective flagged exactly this ordering mistake.

---

## 9. Testing and quality mandates — read this section as carefully as §4

Theory is not sufficient here. This project's own history proves it: a prior AI-authored planning
document for this same app contained a fabricated claim of "208 tests passing" and a fictitious prior
audit — caught only because someone actually ran the tests and got a different number. Do not let
that happen again, in either direction (don't invent numbers, and don't take another agent's or your
own prior claim on faith without re-running it).

### 9.1 Rules

- **Every "passing" or "done" claim must be backed by a command you actually ran in this session**,
  with its real output. If you report a test count, it's because you ran the suite and counted, not
  because you estimated based on how many `it(...)` blocks you wrote.
- **Integration tests use a real SQLite file/temp DB**, not mocks, for every server-side feature —
  this is what caught the async-transaction-callback bug, the malformed-git-author-string bug, and
  the cross-page attribute-permission leak in the old app's history. Mocked tests would have missed
  all three.
- **After each vertical slice in §8, do a simulated real-usage pass** — actually run the dev server
  and click through the flow a real person would (via Playwright, or your own browser-use tooling if
  available), not just assert on API responses. This is explicitly how the "blue box" editor bug and
  the "new pages created with zero ProseMirror block nodes" bug were caught in the old app — neither
  showed up in API-level tests, because both were purely about what actually renders in a browser.
  Don't skip this step because the API tests are green.
- **No speculative abstraction.** Don't build a plugin hook, a settings section, or a config layer
  "for later" until a second real, current consumer needs it. This keeps the code small per the
  mission in §0.
- **Comments explain invariants and past bugs**, not obvious code. If you're porting a fix for a bug
  that was found the hard way in the old app, say so in a comment — that context is exactly what
  keeps the same bug from being reintroduced by a future change.
- **Typecheck clean under strict TypeScript** before any slice is considered complete.
- **Pin exact versions for the interdependent auth/ORM cluster** (better-auth, drizzle-orm,
  drizzle-kit, better-sqlite3) once step 2 is stable, verified via a from-scratch install with
  `node_modules` and the lockfile deleted — this exact problem (dependency version chasing) bit the
  old app once.

### 9.2 Security checklist — re-verify at the relevant step, don't assume it once and move on

- [ ] No `dangerouslySetInnerHTML` (or equivalent) renders unescaped user content — search snippets,
      the public HTML exporter, and anywhere else user text reaches the DOM as raw HTML.
- [ ] File uploads: MIME allowlist for inline rendering, forced download otherwise, `nosniff` always.
- [ ] CSP, `X-Frame-Options`, `Referrer-Policy` set globally from step 2 onward.
- [ ] Rate limiting on auth endpoints and the share-link password check.
- [ ] Every route (core or plugin) declares `config.access` — the server refuses to boot otherwise.
- [ ] No raw SQL string interpolation anywhere — Drizzle/parameterized queries only.
- [ ] No `eval`, `new Function`, or dynamic code execution outside the plugin loader's own sandboxed
      `import()` of an explicitly-uploaded, admin-approved bundle.

### 9.3 Definition of done, tied back to §1

The project is done when each item in §1 has a passing, reproducible test behind it — not a written
claim:

- [ ] §1.1 — the theming one-file-change test (§5.3) passes.
- [ ] §1.2 — the plugin-engine end-to-end test (§4.6, both reference plugins) passes with zero
      core-code changes.
- [ ] §1.3 — the single-pane DOM structure test (§6.3) passes.
- [ ] §1.4 — the settings-audit pass (§7.2) finds nothing left to consolidate.
- [ ] §1.5 — spot-check: pick three files at random each project review; each should be
      small/legible enough to explain in a sentence what it's for.

### 9.4 Manual "simulate real usage" checklist (run this at least once per major slice, not just
at the end)

- [ ] Log in, create a space, create a nested page three levels deep, type real content, reload —
      content persists.
- [ ] Right-click a tree node — the context menu appears and every action in it actually works.
- [ ] Drag a block within a page (once §6 lands) — it moves, no stray selection box appears, typing
      immediately afterward works normally.
- [ ] Upload an image — it renders inline. Upload a non-image file — it downloads, doesn't execute.
- [ ] Type literal HTML-looking text into a page, then search for a word in it — the search result
      renders the text safely, doesn't execute anything.
- [ ] Install a plugin via the settings UI upload flow — it appears, can be enabled, and its effect
      is visible in the running app without a restart (or with a documented, expected restart).
- [ ] Change one theming token — the whole app's look updates, editor included.
- [ ] Open the same page in two browser windows with single-placement collab enabled — both see each
      other's edits live.
- [ ] Clone a page into a second space — both placements are independently permission-scoped.
- [ ] Create a password-protected share link, open it in a private/incognito window — works with the
      password, fails without it, and repeated wrong-password attempts eventually get rate-limited.

---

## 10. Operating instructions

1. **Read** this brief in full, then the old app's `README.md`, `src/shared/permissions/`,
   `src/server/services/collab.service.ts`, `src/server/services/git.service.ts`,
   `src/client/features/editor/*`, and the integration tests under `src/server/__tests__/` — in that
   order, before writing any new code.
2. **Research** current best practice for TanStack Router, Tiptap 3 in React 19, Tailwind v4's
   `@theme` config, and Fastify + `shadcn/ui` interop — this brief gives you decisions and structure,
   not a copy-paste tutorial. Verify library APIs against their current docs rather than memory.
3. **Spike risky integrations before building features on top of them** — specifically: the plugin
   loader's dynamic `import()` mechanism, and Hocuspocus sharing the single DB connection.
4. **Follow the implementation order in §8.** Each slice's gate must pass, for real, with output you
   can show, before starting the next slice.
5. **Do the manual usage checklist in §9.4** at least once per major slice — don't wait until the
   very end to click through the app as a person would.
6. **Ask, or document the assumption inline in code/commit messages,** only when this brief and the
   old app's behavior genuinely conflict. Otherwise this brief plus the old tests define the intended
   behavior — don't guess when a definitive source already exists.

You are not producing an architecture diagram. You are shipping a working, tested wiki that keeps
everything in §2's left column and none of what's in its right column — polished, extensible by real
plugins, themeable from one file, with a single writing canvas, and settings that live in one place.

---

## 11. Data safety, plugin isolation, and operational resilience

The sections above cover architecture. This section covers the things that decide whether the real,
already-written content in this wiki survives the rebuild intact, and whether the app stays
debuggable and self-healing once it's running. None of these are optional polish — treat them with
the same weight as §9's testing mandates.

### 11.1 Migrate the real production data — don't just port the schema

Porting the schema and the permission algorithm (§2, §8 step 3) tells the agent how the *shape* of
data should look. It says nothing about the *actual pages already written* — the homelab docs, the
ham radio reference material, the hobby writing that exists today in the running instance. If the new
schema differs from the old one at all, even a renamed column, write and test a migration script
against a **real copy of the production database**, not just fresh test fixtures.
*Gate:* take a snapshot of the current production `wiki.db`, run the migration against the copy,
open every migrated space in the new app, and confirm content, tree structure, and page history are
all intact. Do this before the old app is decommissioned, not after.

### 11.2 Keep the raw export complete even as plugins add new content types

The original design goal — that everything can always be exported to plain Markdown/HTML with no
app required — gets a new wrinkle once plugins (§4) can register new content types (a draw.io embed,
whatever comes next). A plugin author's format choices could otherwise let the "no lock-in" guarantee
quietly break for pages that use their plugin.
*Requirement:* the raw export path must handle content from a disabled or uninstalled plugin
gracefully — at minimum a sensible placeholder or flattened representation (e.g., a rendered image
for a diagram embed), never a failed export or missing content.
*Fold into:* step 13 (first-party plugins) — test the raw export of a page containing a Draw.io
embed as part of that plugin's own acceptance test.

### 11.3 Plugin failure isolation

§4 describes how a plugin registers and runs. It doesn't yet say what happens when one misbehaves —
throws on every keystroke, infinite-loops, or a server-route plugin locks up a DB query. Once
arbitrary uploaded code can run inside the app, treat this as a required feature, not an edge case:
- Wrap each plugin's registration call and each of its handler invocations (client and server) in
  error boundaries that catch and log rather than crash the host app.
- Auto-disable a plugin after N consecutive failures (make N configurable; default something like 5),
  and surface *why* it was disabled in the Plugins settings sub-section from §7.
*Fold into:* step 12 (plugin engine). *Gate:* write a deliberately broken reference plugin (throws on
every call) and confirm it gets auto-disabled and the rest of the app keeps working throughout.

### 11.4 Real observability, not just tests

A meaningful share of the debugging done on the current app came down to "here's a screenshot, guess
what's wrong" — structured logs and a simple health view would have cut a lot of that time. Fastify
already ships with `pino`; use it properly (structured, leveled) rather than ad hoc `console.log`.
Add a small admin-only page under `/settings/system` showing: recent server errors, last successful
git-flush time, collab/queue health, and DB file size/WAL status.
*Fold into:* step 2 (server foundation) for logging infrastructure; step 16 (admin/system UX) for the
visible health page.

### 11.5 Resilience to real-world network loss while editing

This app runs on a laptop over wifi, on a LAN, from a phone on the go — connections will drop
mid-edit. Verify explicitly, don't assume OCC-aware autosave handles it gracefully:
*Gate:* a test that starts an edit, kills network access mid-save, restores it, and confirms either
(a) the edit is queued and retried with nothing lost, or (b) a genuine conflict is surfaced clearly to
the user rather than one edit silently overwriting the other. "Silently lost the last few sentences"
is a failing result no matter how it happens.
*Fold into:* step 5 (page read + editor), re-verified again at step 11 (collab).

### 11.6 A small seed/smoke-test dataset

Cheap to build, useful twice over: it gives a sane starting point on a fresh install (a couple of
spaces, a nested page tree, a page with comments and an attachment), and it doubles as the fixture
data for the manual usage checklist in §9.4 instead of hand-crafting test content by hand every pass.
*Fold into:* step 1 (skeleton), so it's available for every subsequent slice's manual testing pass.

---

## 12. Wiki-specific product additions

These are product gaps, not architecture gaps — things a wiki specifically needs that the current
feature set doesn't yet cover. Evaluate each on its own merits against the effort budget; they're
ordered roughly by how directly they protect content or reduce daily friction.

### 12.1 Trash with recovery, not just git history

Deleting a page today means "go find the right git commit" to get it back — technically possible,
practically unfriendly, and easy to get wrong under pressure right after an accidental delete. Add a
soft-delete: a deleted page moves to a per-space Trash view for some retention window before it's
truly gone, restorable in one click. Git history remains the long-term/complete record; Trash is the
fast, obvious path for the common case of "I didn't mean to delete that five minutes ago."
*Fold into:* step 6 (branch mutations) — delete becomes soft-delete-to-trash plus a separate
hard-delete/purge action, gated appropriately in the permission algorithm.

### 12.2 Redirects when a page is renamed or moved

Renaming or moving a page is already core functionality (§2, §8 step 6). Whatever currently links to
its old slug or path — internal wikilinks, and especially share links you may have already sent to
someone — should keep resolving rather than 404ing. Store the old slug/path as a redirect target when
a page's canonical slug changes, and resolve it transparently (through the same permission check as
the live page, so a redirect can't be used to bypass access control).
*Fold into:* step 6 (branch mutations), as part of the rename/move implementation itself, not a
follow-up feature.

### 12.3 A real diff view, not just snapshot browsing

Page history today lets you browse and restore whole snapshots one at a time. A proper diff between
any two versions — what actually changed, not just "here's version A, here's version B, spot it
yourself" — is far more useful, especially once multiple people are editing the same pages via collab.
*Fold into:* step 9 (comments/backlinks/etc. — core quality parity), alongside history browsing.

### 12.4 Cross-cutting views independent of the page tree

The tree is a single hierarchy, but your actual content spans several unrelated axes at once — a
homelab page and a ham radio page might both relate to "antenna feedline," a recipe and a homesteading
note might both be tagged "canning." A tree can only put a page in one place at a time (cloning aside).
The attributes system already in the product model (§2) is most of what's needed here — extend it
into a simple saved-filter/tag-browse view ("show me every page tagged `proxmox`" across every space
you have access to) so cross-cutting topics don't require restructuring the tree to surface them.
*Fold into:* step 9, building on the ported attributes system.

### 12.5 Offline readability for the pages that matter most

Worth calling out because it's a very specific irony of homelab documentation: the docs explaining
how to fix your Proxmox server are useless if they're *hosted on* the Proxmox server that's currently
down. A lightweight PWA/offline cache — even just "pin these pages for offline reading" rather than
full offline editing — means the exact moment you most need infrastructure docs is no longer the
moment they're least available.
*Fold into:* step 16 (polish), as a scoped addition — read-only offline cache for explicitly pinned
pages, not full offline editing/sync, to keep the scope small per §0's mission.

### 12.6 In-page table of contents

For the long-form writing this wiki is meant to hold (homesteading notes, brewing logs, real estate
research), an auto-generated, sticky table of contents built from a page's own headings — with
clickable anchors — is a small addition with an outsized readability payoff on anything longer than a
screen.
*Fold into:* step 5 (editor), as a read-mode rendering feature driven off the same heading nodes
already in the document — no new content model needed.

### 12.7 A maintenance report for orphaned pages and broken links

A personal wiki that grows organically over months accumulates pages nothing links to anymore, and
wikilinks that point at a page that got renamed or deleted before §12.2's redirect handling existed
(or a wikilink typo). A simple admin/maintenance report — orphaned pages (no backlinks), broken
wikilinks — turns "the wiki slowly rots" into a five-minute occasional cleanup pass.
*Fold into:* step 9, reusing the backlinks index that's already being built there.

---

## 13. Knowledge-base depth (Trilium-inspired capabilities)

The product model in §2 already borrows Trilium's best idea — note cloning, carried forward as the
pages/branches split. But what makes Trilium "superior" as a knowledge base, not just a wiki, is a
specific set of capabilities beyond page-and-tree: **typed relations between notes** (not just links),
**attribute-driven structure** (templates, tables/boards built from metadata), and a constrained,
**event-driven form of programmability** on top of notes. This section adds those, scoped to fit this
app's multi-user, security-hardened context rather than copied wholesale from a single-user desktop
tool.

### 13.1 Typed relations, not just links and backlinks

Trilium's most distinctive feature is the **relation** — a typed, directional connection between two
notes (e.g., "is a component of," "depends on," "supersedes"), separate from an ordinary in-text
wikilink, stored as a first-class attribute rather than inferred from document content. Build this on
top of the attributes system already in the product model (§2):
- A relation is an attribute whose value is a page reference rather than a string, with a
  user-defined type name.
- Relations are queryable in both directions (Trilium calls this owned vs. inherited/incoming) and
  feed the same permission checks as any other page reference — a relation to a page you can't access
  should not leak that page's existence.
*Fold into:* step 9 (backlinks), as a typed extension of the attribute system already landing there.

### 13.2 A relation/link graph view, alongside the tree

The tree answers "where does this page live." A **graph view** — nodes and edges built from wikilinks
and typed relations, not tree parent/child — answers "what does this page actually connect to,"
which is exactly the axis a strict hierarchy can't represent (see also §12.4, cross-cutting views —
this is that idea's visual form). Scope it to a single page's local neighborhood by default (its
direct links/relations, one hop out) rather than rendering the entire instance's graph at once, which
gets unreadable fast and expensive to compute as the wiki grows.
*Fold into:* step 9, reusing the same backlinks/relations index as §13.1 and §12.4.

### 13.3 Template pages via attribute inheritance

Trilium's `template` relation lets a page inherit another page's attributes without needing to be its
tree child. Extend the existing templates feature (already in the product model) this way: a page
can declare `template: <page>`, and inherits that template's attribute set at read time — so
updating the template's structure (e.g., adding a new promoted attribute to a "Ham Radio QSO Log"
template) propagates to every page using it, without touching each one individually.
*Fold into:* step 9, as an extension of the existing templates feature.

### 13.4 Attribute-driven table and board views

Promoted attributes (already in the product model) are more useful once they can be *viewed* as
structured data, not just displayed inline on each page. A saved view over a set of pages (by space,
tag/attribute, or template) rendered as a sortable table or a kanban-style board, driven entirely by
those pages' promoted attributes — this is the strongest version of the "cross-cutting view" idea in
§12.4, and it's a proven pattern (Trilium ships exactly this). Concretely useful for Neal's own
content: a table of every ham radio contact logged via a QSO template, sorted by date and band.
*Fold into:* step 9, as the fuller implementation of §12.4.

### 13.5 Event-driven automation — through the plugin engine, not raw per-page scripting

Trilium allows raw JavaScript attached directly to notes (`runOnNoteView`, `runOnAttributeChange`,
etc.), executed for any user who opens the note. **Do not port that model as-is** — on a shared,
multi-user instance with the security hardening already invested in this rebuild (§3.2, §9.2),
letting any editor-level user attach arbitrary executable script to a page they can edit is a direct
route back to the exact class of stored-code-execution risk that was deliberately closed in §3.2 and
§9.2. Get the same *capability* safely instead: expose page-level automation as **plugin-registered
hooks** through the `PluginAPI` from §4 —

```ts
registerHook(event: "pageLoad" | "attributeChange" | "pageSave", handler: HookHandler): void
```

— so "run this logic when a page with this template loads" is something an **admin-installed
plugin** can do (going through the same manifest/capability/isolation model as everything else in
§4), not something any editor can attach to any page. This gets Trilium's automation power without
reopening the trust boundary the rest of this brief works hard to keep closed.
*Fold into:* step 12 (plugin engine), as an additional `PluginAPI` capability alongside the ones in §4.4.

### 13.6 Dedicated code notes and first-class Mermaid diagrams

Two content-type additions worth building as core, not plugins, given how technical this wiki's own
content already is:
- **A dedicated "code page" type** — a whole page that *is* a syntax-highlighted code/config file
  (à la Trilium's code notes), distinct from a code block embedded inside a normal rich-text page.
  Useful for the exact content already in this wiki today — full shell scripts, config files — where
  the surrounding rich-text page is unnecessary overhead.
- **Mermaid diagrams as a first-class embed**, alongside the Draw.io plugin from §4.6. Worth calling
  out specifically: Mermaid diagrams are plain text, so unlike Draw.io's XML or a rasterized image,
  they get real, readable **git diffs** — directly in keeping with this project's git-backed-history
  philosophy (§2). Reach for Mermaid by default for flowcharts/sequence diagrams where the content is
  simple enough to describe as text; reserve the Draw.io plugin for diagrams that genuinely need
  freeform visual layout (network topology maps, physical wiring diagrams).
*Fold into:* step 5 (editor) for both — code pages as a page-type variant, Mermaid as a Tiptap node
that renders the diagram from its text source, consistent with how math rendering already works in
the current app.

### 13.7 Per-page encryption (protected pages)

Space- and branch-level permissions (§2) control *who can open* a page. Per-page encryption is a
different, complementary guarantee: content that's encrypted at rest, decrypted client-side only
after a per-session unlock (a second factor beyond normal login), so even a user with legitimate
branch access — or anyone with raw access to the SQLite file or a backup — can't read it without that
additional unlock. Useful for exactly the kind of content that sits in a broader shared space but
shouldn't be casually readable (financial notes, real estate research) even by other trusted users of
that space.
*Fold into:* step 16 (polish) — this is additive to the permission model in §2, not a prerequisite for
anything earlier, and shouldn't block core functionality from landing first.

---

*End of brief.*
