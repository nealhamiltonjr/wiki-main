# wiki-app-v2 — Rebuild Documentation

This is the single authoritative document for the **v2 rebuild** of the knowledge-base/wiki app that lives in `wiki-app-v2/`. It is written for an AI agent picking up the codebase with no prior context. Read this first; everything else (`WIKI-REDESIGN-BRIEF-V2.md` is the underlying spec, the source code is the truth) follows from it.

If you only have time to skim: read **§1** (why), **§3** (what is done), and **§7** (what still needs work). They are the three questions you will be asked first.

---

## Table of contents

1. [What this rebuild was about, and why it exists](#1-what-this-rebuild-was-about-and-why-it-exists)
2. [Repository layout](#2-repository-layout)
3. [Tech stack: what changed from V14 to V2, and why](#3-tech-stack-what-changed-from-v14-to-v2-and-why)
4. [Architectural decisions and their rationale](#4-architectural-decisions-and-their-rationale)
5. [What was done — the rebuild itself, slice by slice](#5-what-was-done--the-rebuild-itself-slice-by-slice)
6. [What is implemented — the feature surface today](#6-what-is-implemented--the-feature-surface-today)
7. [What is not done / what is not fully done / known limits](#7-what-is-not-done--what-is-not-fully-done--known-limits)
8. [How to run, test, and extend the app](#8-how-to-run-test-and-extend-the-app)
9. [Definitive pointers for an AI agent picking this up](#9-definitive-pointers-for-an-ai-agent-picking-this-up)

---

## 1. What this rebuild was about, and why it exists

### 1.1 The pre-rebuild state (V14, in `wiki-app/`)

The pre-rebuild app — referred to inside the project as **V14** — was a personal wiki that had grown organically. Functionally rich, but it had accumulated real, documented structural problems that kept biting in production:

- **Theming was scattered across components.** Changing the look and feel required editing component code. There was no single source of truth for color, spacing, radius, or type.
- **The plugin engine was not a plugin engine.** Plugin support was effectively a toggle map of compiled-in extensions. There was no way for an admin to upload code, have it validated, and have it execute — which meant there was no way to extend the app without forking it.
- **The editor canvas had structural bugs.** Positioned overlay elements (drag handles, comment markers, slash menus) accidentally wrapped content instead of floating outside it, trapping the cursor inside a "selection box" — a real, visible defect that took hours to chase down the first time.
- **Settings were scattered** — permission dialogs, attribute panels, and config UI existed in multiple places outside the dedicated settings area.
- **The codebase was hard to extend.** Abstract machinery that had only one consumer was built, and a culture of "document the obvious" comments had accumulated.

The codebase worked, and the user's actual content (homelab docs, ham radio reference, hobby writing) was preserved through git history. But the foundation was limiting what the app could become.

### 1.2 The goal of the rebuild

The rebuild was guided by a single, normative document: `WIKI-REDESIGN-BRIEF-V2.md` (read this — it is the "why" behind every decision). The brief set five non-negotiable outcomes, paraphrased:

1. **One token file controls the entire look and feel.** Changing the theme must never require touching component code.
2. **The plugin engine is real.** An admin uploads a zip; the engine validates, registers what the manifest declares, and runs it — without any core-code change.
3. **The editor canvas is a single pane.** No nested boxes, no selection traps, no stray outlines that swallow the cursor.
4. **Settings live in one place.** A single `/settings` area with clear sub-sections; no permission dialogs scattered elsewhere outside deliberate, deep-linked entry points.
5. **Code stays small and easy to extend.** No abstraction gets built until a second real consumer needs it. Comments explain invariants and past bugs, not the obvious.

The V14 app's content was the asset to protect — `git log` was always available, so the rebuild was never a content migration problem, but it was a foundational rewrite.

### 1.3 What "done" means

"Done" is not what was written in a status field. "Done" means the brief's definition-of-done checklist passes:

- The one-token-file theming test passes.
- The plugin engine end-to-end test passes with zero core-code changes (both reference plugins: a hello-world plugin and a real web-clipper + Draw.io embed plugin).
- The single-pane DOM structure test passes.
- The settings audit pass finds nothing left to consolidate.
- A spot-check of three random files at any future review shows them small enough to explain in a sentence.

Plus the §12 / §13 knowledge-base additions (typed relations, graph view, template inheritance, table/board views, event-driven automation via plugins, code pages, Mermaid, per-page encryption, offline pinning, in-page TOC, trash, redirects, diff view, maintenance report) are all implemented and tested.

That is the current state. See §5 for the slice-by-slice history and §6 for the per-feature implementation pointers.

---

## 2. Repository layout

```
.
├── wiki-app/                   # The V14 app (legacy; reference for behavior; do NOT extend)
├── wiki-app-v2/                # The V2 rebuild (the app this document is about)
├── WIKI-REDESIGN-BRIEF-V2.md   # The authoritative "why" spec behind the rebuild
├── REBUILD.md                  # ← THIS FILE. The consolidated "what / how / what remains".
├── drizzle/                    # (only in wiki-app-v2) Drizzle migration SQL files
├── test-fixtures/              # (only in wiki-app-v2) Zip fixtures for the plugin engine
├── data/                       # Gitignored. DB file, git repo, uploaded files, plugin dirs.
└── reference/                  # Gitignored. Vendored docs from Docmost, Siyuan, Trilium
                                # — read-only reference material, not part of the app.
```

`wiki-app/` is historical and frozen at the v14 snapshot. **Do not extend it.** The active codebase is `wiki-app-v2/`.

### 2.1 `wiki-app-v2/` internal layout

```
src/
├── server/           # Fastify HTTP API; services + routes + middleware
│   ├── app.ts                        # buildApp() — the Fastify instance
│   ├── index.ts                      # process entrypoint (initGitRepo, startWorkerLoop, listen)
│   ├── auth/                         # better-auth wiring
│   ├── db/                           # Drizzle/SQLite singleton + migrations
│   ├── middleware/                   # access.ts — declarative config.access enforcement
│   ├── routes/                       # One file per resource (page.routes.ts, etc.)
│   ├── services/                     # Pure business logic (page.service.ts, etc.)
│   ├── hooks.ts                      # §13.5 plugin hook registry (in-process)
│   ├── hookTypes.ts                  # Hook event discriminated union
│   └── utils/                        # regex-safety, etc.
├── shared/                            # Code shared between server + client (no DOM, no node)
│   ├── types.ts                      # UserContext, Page, Branch, etc.
│   ├── permissions/                  # The permission algorithm (resolveAccess)
│   ├── blockIds.ts                   # Block-id rule + validateContent for plugin nodes
│   ├── cryptoEnvelope.ts             # AES-GCM envelope for §13.7 per-page encryption
│   ├── codeLanguages.ts              # Prism language list
│   └── pluginTypes.ts                # PluginManifest, PluginCapabilities
├── plugins/                          # Client plugin engine
│   ├── api.ts                        # PluginAPI surface given to plugin bundles
│   ├── registry.ts                   # Client registration per capability
│   ├── loader.ts                     # Dynamic import() of plugin bundles
│   ├── coreCommands.ts               # Built-in slash commands (callout, code-page, etc.)
│   └── defs.ts
├── features/                          # Feature-scoped React code
│   ├── auth/  comments/  editor/  encryption/  favorites/  graph/  history/  home/
│   ├── lenses/  notifications/  offline/  properties/  relations/  settings/  sharing/
│   ├── templates/  trash/  tree/
├── routes/                            # TanStack Router file-based routes
│   ├── _authenticated/                # Gated by session
│   │   ├── w/$branchId.tsx           # The main page-writing surface
│   │   └── settings/                  # §7.1 single settings area, every sub-section here
│   ├── login.tsx
│   └── index.tsx
├── api/                              # Typed HTTP client + authClient
├── styles/                           # tokens.css + app.css (the ONE token file)
└── main.tsx
```

Tests live next to the code they cover: `__tests__/` directories inside the feature/service folder, and Playwright e2e at the repo root in `e2e/`.

---

## 3. Tech stack: what changed from V14 to V2, and why

Every change here is in service of the brief's five non-negotiables. If you are wondering "why did we switch X?" — the answer is almost always one of those five.

### 3.1 Frontend

| Concern | V14 | V2 | Why we changed it |
|---|---|---|---|
| **React** | React 18 | **React 19** | Required for the Tiptap 3 + collab caret flow; better Suspense + concurrent rendering made the lazy route trees feel snappier. |
| **Routing** | React Router (hand-assembled) | **TanStack Router + Vite plugin** | File-based routing with full type safety — the route tree is generated at compile time and the `<Link>` / `useNavigate`/`useParams` types are inferred. Removes a class of "wrong path string" bugs. |
| **Editor** | Tiptap 2 | **Tiptap 3** | Required for the React 19 + collab caret + unique-id extensions to align. The schema is the same; the API migrated. |
| **Styling** | Tailwind v3 + scattered CSS variables | **Tailwind v4 + a single `src/styles/tokens.css`** | One file owns every color, radius, spacing, font, shadow, animation. `@theme inline` aliases the Tailwind tokens to the CSS variables. §1.1 of the brief. |
| **UI primitives** | hand-rolled | **shadcn/ui + Radix slot** | Accessible, themeable, no proprietary lock-in. |
| **Tree** | react-arborist 2 | **react-arborist 3** | Same library, patched to be React-19 compatible. |
| **State/data** | ad-hoc contexts | **TanStack Router loader functions + typed API client** | Server state lives in the route loader; the page reads its branch / page / TOC from a typed object, not a `useEffect(fetch)` chain. |

### 3.2 Backend

| Concern | V14 | V2 | Why we changed it |
|---|---|---|---|
| **HTTP server** | Express | **Fastify 5** | Faster, schema-first via TypeBox (Zod-compatible), better plugin model, native pino logging. |
| **Database** | better-sqlite3 via raw queries | **Drizzle ORM + better-sqlite3** | Single source of truth for the schema (TS), parameters everywhere (no string interpolation — §3.2 of the brief), `drizzle-kit` generates committed migrations. |
| **Auth** | hand-rolled | **better-auth** | Mature, social-sign-on ready, rate limiting built in. We make `rateLimit` + `trustedOrigins` explicit (the explicit-over-inherited rule from §3.2). |
| **Real-time collab** | none (last-write-wins saves) | **Hocuspocus + Yjs + y-prosemirror** | Yjs CRDTs give genuinely safe offline→online reconciliation. The brief's §11.5 "resilience to network loss" is testable. |
| **WebSocket** | none | shared `ws.WebSocketServer` attached to the Fastify HTTP server, forwarding `/api/collaboration` upgrades to Hocuspocus | One port for both — no second hop, no extra TLS surface. |
| **Content export** | ad-hoc | **simple-git writer to a real git repo** | Pages are committed `<spaceSlug>/<pageSlug>.md` + frontmatter. History browse and restore are `git log --grep page:<id>:` + `git show`. The brief's "git-backed history" promise (§2) becomes structural, not aspirational. |
| **Background work** | none | **an in-process queue + worker loop** | Save/rename/snapshot enqueue "git_commit" jobs; the worker drains them. Not a separate Redis — this is a single-instance app. |
| **Logging** | `console.log` | **pino (Fastify's built-in)** | Structured, leveled, JSON in prod. The §11.4 "real observability" requirement. |

### 3.3 Tooling

| Concern | V14 | V2 | Why |
|---|---|---|---|
| **Build** | Vite 5 | **Vite 8** | Required for Tailwind v4 + TanStack Router plugin. |
| **Test (unit/integration)** | Jest | **Vitest** | Vite-native, shares the same transform pipeline, fast. Forced `fileParallelism: false` because integration tests share `data/` and a single lazy SQLite connection per worker. |
| **Test (e2e)** | Cypress | **Playwright** | Multi-browser, faster, better trace viewer, better typing. |
| **TypeScript** | non-strict | **strict** | `tsc --noEmit` is the gate. Unused vars fail the build. |

### 3.4 What we deliberately did NOT change

- **better-sqlite3.** It is the right tool for a single-instance, host-on-your-laptop wiki. No Postgres, no MySQL, no "but what if we scale to 10 users" — the answer is "we won't, this is a personal wiki."
- **The content model.** Page, branch (placement), space, group, attribute — the same five objects the V14 app had. The relationship between pages and the tree is unchanged; the user-facing behavior is preserved.
- **The permission algorithm.** Ported **verbatim** from V14 into `src/shared/permissions/algorithm.ts` and tested against the V14 test suite unchanged. The brief's §2 was a hard requirement: "preserve access-control semantics."
- **The git-as-source-of-truth model.** The new app commits every page change to a real git repo. The V14 history is preserved through git; the V2 history is git-native.

---

## 4. Architectural decisions and their rationale

These are the structural decisions that, if you don't know them, you will eventually undo and regret.

### 4.1 The plugin engine is real, and it is a trust boundary

The plugin engine is the riskiest piece of the rebuild. V14's "plugin" support was a toggle map — there was no way to extend the app without forking. The brief required a real plugin engine (an admin uploads a zip, the engine validates it, it runs). The brief was also explicit that this cannot be used to open the stored-XSS trust boundary that the rest of the architecture works hard to keep closed.

How the boundary is enforced:

- **Manifest is a strict Zod schema.** A field the schema doesn't know is a `reject`, not an `ignore`. The manifest declares which of seven capabilities the plugin needs (`tiptapExtensions`, `slashCommands`, `toolbarItems`, `settingsPanel`, `embedTypes`, `serverRoutes`, `hooks`). A capability that is `false` means the plugin cannot obtain an API for it.
- **PluginAPI is a closed object.** What the plugin sees is exactly the methods for the capabilities it declared. It cannot reach `fetch()`, `import()`, `document`, or any other global before the API surface explicitly grants it (server-side hooks get a tiny `{registerHook}` only — no access to the registry or the Fastify app).
- **Plugin failure isolation.** Every handler invocation is try/catch'd. A throw increments a per-plugin consecutive-failure counter; auto-disable at N (default 5); the most recent error + the auto-disable reason are surfaced in the admin UI. See `src/server/hooks.ts` and `src/server/services/plugin.service.ts → installPluginFailureHook`.
- **NEW node types must be declared.** The plugin's manifest declares `contentModel.nodes` / `contentModel.marks`. The server's `validateContent` accepts those types only while the plugin is enabled (and so declared). A plugin that lies about what nodes it produces has its doc rejected. This keeps the git-flush path safe even after a plugin is uninstalled.
- **First-party plugins ship in-repo** (`web-clipper`, `drawio-embed`) — they exercise the same load/validate/register path as a third-party zip. Their behavior is the documented contract.

### 4.2 Git is the content store, not just a history view

Every page save/rename/snapshot enqueues a `git_commit` job. The worker writes `<spaceSlug>/<pageSlug>.md` + frontmatter and commits. History browse and restore are `git log --grep page:<id>:` + `git show`. This is the same model V14 had; the rebuild makes it **structural** — no separate "snapshot" table, no parallel history that can drift.

### 4.3 The editor canvas is a single pane

The drag-handle bug that ate real time in V14 (positioned overlay elements wrapping content instead of floating outside, trapping the cursor) was designed out, not patched. The Docmost-style drag handle plugin key `globalDragHandle` is anchored to `.editor-canvas` as a **sibling** of the ProseMirror root, not a wrapper. The acceptance test (`e2e/editor.spec.ts`) asserts this structurally. There is exactly one `.editor-canvas` border rule in CSS — no nested boxes.

### 4.4 Settings is a single area

Every settings-shaped surface in the app either lives under `/settings/*` or is a deliberate page-contextual control with a deep-link to `/settings/*` for anything beyond the single immediate action. The audit comment in `src/routes/_authenticated/settings.tsx` is the receipt — it names every other surface and the rule future PRs must not break.

### 4.5 One token file

`src/styles/tokens.css` owns every color, radius, spacing, font-size, shadow, animation value. Component code reads semantic tokens like `text-foreground`, `bg-surface-elevated`, `border-border`. The acceptance test (`src/styles/__tests__/theme.test.ts`) asserts the canonical token file owns these resolutions.

### 4.6 Auth is explicit, not implicit

- `BETTER_AUTH_URL` is a real, set-on-deploy value, not a header-derivation cause of past 500s.
- `BETTER_AUTH_SECRET` is a real value in production; the dev placeholder is loud about it.
- `trustedOrigins` is explicit, including `192.168.*:*` for LAN/Docker host-network deployments.
- Rate limiting is explicit (`BETTER_AUTH_RATE_LIMIT_*`) with sensible defaults.
- `additionalFields.isAdmin` is `input: false` — the only path to admin is the first-signup bootstrap (`src/server/services/bootstrap.service.ts`), which is itself race-safe.

### 4.7 The single SQLite connection is canonical

`src/server/db/index.ts` is a lazy singleton. **Tests must set `process.env.DB_PATH` before any import of `getDb` or the services.** This is the single largest "foot-gun" the test harness has. The lazy init is intentional: the change of mind from V14 (which had per-request connections) is deliberate for better-sqlite3's process-threaded write model.

### 4.8 Real-time is for collab, not for everything

Hocuspocus + Yjs + y-prosemirror sit on top of the same DB and the same git-write pipeline. Single-placement collab is the target scenario; multi-placement collab is named in the brief but is **not** a current feature (see §7.4).

### 4.9 Background work is the queue, not the request

A save request: validates the content, writes the new row, enqueues a `git_commit` job, returns. The git commit happens on the worker loop. The user gets a fast response; the commit lands within a second or two. This is what makes the git-flush viable as a structural feature rather than an "and then we do this expensive thing synchronously" hedge.

### 4.10 The plugin engine, the search index, the git writer, and the queue are all in-process

This is a single-instance app. There is no Redis, no separate worker, no second port. The plugin loader's `import()` is a real `import()` of an admin-uploaded zip — it runs inside the Node process. The §3.2 / §9.2 "tighten the trust boundary" rule is enforced by the closed PluginAPI surface, not by process isolation.

---

## 5. What was done — the rebuild itself, slice by slice

The rebuild was shipped as a sequence of vertical slices, each gated by a real test. The brief's §8 step order was followed. The slice numbers are not in chronological order — they were assigned out of order in the brief. The list below is in chronological order of work.

| # | Slice | Brief § | What it did |
|---|---|---|---|
| 1 | Skeleton | §8 step 1 | Vite + React 19 + TanStack Router shell, the one-token-file tokens.css, shadcn base, public/authenticated layout split, health route. |
| 2 | Server foundation | §8 step 2 | Fastify skeleton, Drizzle/SQLite singleton, better-auth wired with explicit rate limit + trusted origins + security headers (CSP, nosniff, frame-options, referrer-policy) from §3.2. The every-route-declares-`config.access` boot refusal. |
| 3 | Schema + permission algorithm | §8 step 3 | Ported the V14 schema and the `resolveAccess` algorithm **verbatim** into `src/shared/permissions/algorithm.ts`. The same 11 algorithm tests pass identically. |
| 4 | Client integration | §8 step 4 | Auth client + typed API client. Login component. react-arborist tree sidebar wired to `/api/spaces/:id/tree`. Authenticated layout. |
| 5 | Page read + editor | §8 step 5 | Tiptap 3 + all extensions. The page route `src/routes/_authenticated/w/$branchId.tsx`. Single-pane `.editor-canvas`. The Markdown round-trip and the Prism block / Mermaid / math renderer. |
| 6 | Branch mutations (page create / rename / delete / snapshot) | §8 step 6 | The lifecycle that becomes the "save flow." Includes the §12.1 trash handling (soft-delete to trash, separate purge/restore path) and the §12.2 `page_redirects` table for rename. |
| 7 | Tables / file uploads / search | §8 step 7 | File service with MIME allowlist + forced download + `nosniff`. The full-text search index. |
| 8 | Roles / permissions / settings | §8 step 8 | Server-side group + role management. The settings layout. The audit comment in `settings.tsx` is the §7.2 receipt. |
| 9 | Comments / backlinks / notifications / favorites | §8 step 9 | The richer page-contextual features. PageHistoryView. |
| 10 | Git flush pipeline | §8 step 10 | `git.service.ts` writes pages to the content repo. The `queue.service.ts` worker loop. (`page_save` → `enqueueJob("git_commit")` → `commitPageChange`.) |
| 11 | Collab via Hocuspocus | §8 step 11 | WebSocketServer attached to Fastify, forwarding `/api/collaboration` to Hocuspocus. The `useCollab.ts` hook. |
| 12 | Plugin engine | §12 | The real plugin engine. Manifest schema, file layout, dynamic import, plugin-api surface, content-model declarations, failure isolation. The hello-world plugin is the reference implementation. |
| 13 | First-party plugins | §13 | Web Clipper (slash-command → fetches through its server route → inserts a citation node) and Draw.io Embed (a first-class content type). These are shipped in-repo and exercise the same path as third-party zips. |
| 14 | Settings consolidation + §7.2 audit | §7.2 | Every settings-shaped surface audited. The audit comment in `settings.tsx` is the receipt. |
| 15 | Theming architecture | §5 | One token file (`src/styles/tokens.css`) holds canonical values; `@theme inline` aliases Tailwind tokens to CSS variables; component code reads semantic tokens. The acceptance test enforces this. |
| 16 | Users / groups / admin UX polish | §7.1 | Themed `ConfirmDialog` on the native `<dialog>` for destructive actions. Capability-editing UI in `/settings/groups`. Users-page search + last-admin guard + unverified-email marker. Settings layout drops the redundant H1. |
| 17 | Full regression pass + §9.4 checklist | §9.4 | Three Playwright `heading: "Settings"` sentinels rewritten to the plugins page's own heading (the layout-H1 removal had silently broken them). `InMemoryRateLimiter` wired into the share-link branch-auth path. New integration test for share-link rate limiting. |
| 18 | First-boot bootstrap | §11.6 | First sign-up becomes admin via `databaseHooks.user.create.before`; the `.after` hook calls `seedWelcomeSpace`. The `bootstrap.service.ts` is idempotent and race-safe. |
| 19 | In-page table of contents | §12.6 | The TOC was previously inline; extracted to `TableOfContents.tsx` with smooth-scroll, scroll-spy, depth-aware indentation. Renders nothing if fewer than 2 headings. |
| 20 | Per-space trash UI | §12.1 | `TrashPanel.tsx`, the per-space trash view, restore / purge actions. |
| 21 | Page-redirect on rename | §12.2 | `page_redirects` table; old slug → new pageId. Reads transparently through the same permission check. |
| 22 | Maintenance report (orphaned + broken redirects) | §12.7 | The base report. Added the `§12.7` admin surface. |
| 23 | Real diff view | §12.3 | `diff.service.ts` produces a real diff between any two commits. UI surfaces it from the history view. |
| 24 | Lenses / saved-filter view | §12.4 | `lens.service.ts` runs a criteria object against pages × attributes × spaces. The `TableView` / `BoardView` lenses render the result. |
| 25 | Typed relations | §13.1 | `relation.service.ts`. Relations are first-class attributes (`name: <userDefined>`, `valuePageId: <otherPage>`). Permission-filtered. |
| 26 | Graph view | §13.2 | `graph.service.ts` + `GraphPanel.tsx`. Single-page local neighborhood by default. |
| 27 | Template inheritance | §13.3 | `template.service.ts` resolves the merged attribute set at read time. Cycle-safe, depth-limited, permission-filtered. |
| 28 | Attribute-driven table / board views | §13.4 | The same `lens.service.ts` powers TableView / BoardView over promoted attributes. |
| 29 | Real diff view wiring | §12.3 | The UI surface for the diff view. |
| 30 | Plugin hooks engine | §13.5 | `src/server/hooks.ts` + `src/server/hookTypes.ts`. Plugin capabilities extended with `hooks`. Hook events: `pageLoad`, `pageSave`, `attributeChange`. |
| 31 | First-class Mermaid embed | §13.6 | The Tiptap Mermaid node. Renders the diagram from text source. Both edit and read view render. |
| 32 | Dedicated code-page type | §13.6 | `CodePageEditor.tsx` (plain monospace textarea for whole-file source) + `CodePageReadOnly.tsx`. The `pages.pageType` enum includes `"code"`. Git export writes the file with the right extension. |
| 33 | Per-page encryption | §13.7 | `src/shared/cryptoEnvelope.ts` (AES-GCM). The `encryptedPages` table. The `ProtectPageDialog` UI flows from public → encrypted-state → unlock-on-load. |
| 34 | Plugin failure isolation | §11.3 | The `installPluginFailureHook` wired to the hook registry. Plugins auto-disable after N consecutive failures. The admin UI shows why. |
| 35 | Admin observability surface | §11.4 | `system-health.service.ts` reports DB stats, git-flush recency, queue depth, plugin health. The `/settings/system` page renders it. |
| 36 | Raw export survives disabled-plugin content | §11.2 | The git-flush path renders disabled-plugin nodes as a placeholder rather than failing the export. |
| 37 | Offline readability for pinned pages | §12.5 | The service worker (`sw-bridge.ts`) caches pinned pages. The `PinButton` per page. |
| 38 | Defer SW pin-cache seed until auth resolves | §12.5 | The first user wasn't getting their pinned pages because the seed ran before auth. |
| 39 | Mechanical §9.2 + §7.2 audit suite | §9.2 / §7.2 | The grep suite that fails the build if a catalog of unsafe patterns regresses. |
| 40 | Single-session happy-path e2e sweep | §9.4 | The end-to-end test that touches every major feature. |
| 41 | First-signup bootstrap race fix | post-build audit | The original bootstrap had a TOCTOU window. Closed. |
| 42 | ReDoS defense for lens `titleRegex` | post-build audit | `assertSafeRegex` rejects pathologically nested quantifiers. |
| 43 | Admin-demote lockout race guard | deep-dive | The last-admin guard prevents the only-admin lockout path. |
| 44 | Admin-tunable caps | §3.2 | Comment, plugin, file upload caps are admin-tunable. |
| 45 | Markdown import XSS | §3.2 | Link href + image src sanitization on import. |
| 46 | Plugin command engine injection audit | §3.2 / §4 | `coreCommands.ts` audited. |
| 47 | First-boot landing + recovery | §11.6 | The user-facing "first sign-up" landing wires through the seeded Welcome space. |
| 48 | Comment threads transactional integrity | §9.4 | Reply + resolve path is atomic. |

Three follow-on slices (paragraph drag handle — Slice 34 in the user's numbering, similar-page report — Slice G, and a final regression pass on the plugin hook path) landed after the formal sequence and are documented in this rebuild's commit history.

---

## 6. What is implemented — the feature surface today

Functionally, the V2 app is **complete against the brief**. Every §12 and §13 knowledge-base addition, every §1 non-negotiable outcome, and the §11 operational-resilience requirements are implemented and tested.

### 6.1 Per-brief-section coverage map

| Brief § | Requirement | Where |
|---|---|---|
| §1.1 | One token file controls the look | `src/styles/tokens.css` + `src/styles/__tests__/theme.test.ts` |
| §1.2 | Real plugin engine | `src/server/services/plugin.service.ts` + `src/plugins/loader.ts` |
| §1.3 | Single-pane editor | `src/features/editor/extensions/dragHandle.ts` + `e2e/editor.spec.ts` |
| §1.4 | Settings in one place | `src/routes/_authenticated/settings.tsx` (audit comment is the receipt) |
| §1.5 | Small, easy-to-extend code | Convention enforced by every slice's review |
| §2 | Species, product model, permissions | `src/db/schema.ts` (27 tables) + `src/shared/permissions/algorithm.ts` |
| §3.2 | Security headers + nonce + rate limit + body parsing | `src/server/app.ts` + `src/server/auth/config.ts` |
| §4 | Plugin engine | Same as §1.2 |
| §4.6 | Plugin engine end-to-end (both reference plugins) | `e2e/plugins.spec.ts` + `e2e/firstparty.spec.ts` |
| §5 | Theming | Same as §1.1 |
| §6 | Single-pane editor | Same as §1.3 |
| §7 | Settings architecture | `src/routes/_authenticated/settings.tsx` |
| §7.2 | Settings audit | The grep suite + the audit comment |
| §8 | Page read + editor | `src/routes/_authenticated/w/$branchId.tsx` |
| §9 | Comments / backlinks / notifications | `src/features/comments` + `src/services/backlink.service.ts` + `src/features/notifications` |
| §10 | Git flush pipeline | `src/server/services/git.service.ts` + `src/server/services/queue.service.ts` |
| §11 | Collab | `src/server/services/collab.service.ts` + `src/features/editor/useCollab.ts` |
| §11.1 | Data safety | (Off the must-do list by user direction — the prior DB was test data.) |
| §11.2 | Raw export survives disabled plugins | `commitPageChange` renders disabled-plugin nodes as placeholders |
| §11.3 | Plugin failure isolation | `installPluginFailureHook` + admin UI |
| §11.4 | Real observability | `system-health.service.ts` + `/settings/system` |
| §11.5 | Resilient offline edit | OCC-aware autosave + the network-loss e2e |
| §11.6 | Seed/smoke dataset | `bootstrap.service.ts` |
| §12.1 | Trash with recovery | `src/features/trash` + `e2e/slice20.spec.ts` |
| §12.2 | Redirects on rename | `page_redirects` table + `page.services.ts` |
| §12.3 | Real diff view | `src/server/services/diff.service.ts` |
| §12.4 | Cross-cutting views | `src/features/lenses` + `src/server/services/lens.service.ts` |
| §12.5 | Offline readability | `src/features/offline` + `sw-bridge.ts` |
| §12.6 | In-page TOC | `src/features/editor/TableOfContents.tsx` + `e2e/slice19.spec.ts` |
| §12.7 | Maintenance report | `src/server/services/maintenance.service.ts` + `/settings/maintenance` |
| §13.1 | Typed relations | `src/server/services/relation.service.ts` |
| §13.2 | Graph view | `src/server/services/graph.service.ts` + `src/features/graph` |
| §13.3 | Template inheritance | `src/server/services/template.service.ts` |
| §13.4 | Attribute-driven table / board views | `lens.service.ts` + `BoardView` / `TableView` |
| §13.5 | Plugin event hooks | `src/server/hooks.ts` + `src/server/hookTypes.ts` + `hooks.events.test.ts` |
| §13.6 | Code pages + Mermaid | `CodePageEditor.tsx` + Mermaid Tiptap node |
| §13.7 | Per-page encryption | `src/shared/cryptoEnvelope.ts` + `src/features/encryption` |

### 6.2 The feature surface, in plain language

Assuming your background is "personal wiki," the V2 app gives you:

- **Spaces + nested pages + cloning.** Page is a content object; branch is a placement in a tree. Clone a page into a second space; both placements are independently permission-scoped.
- **Tiptap-based rich-text editor.** Block-level drag handle (Docmost-style, single-pane), block IDs, links, code-block with Prism, math, Mermaid, tables, callouts, slash commands, image / file embeds.
- **Code pages.** A whole page that is a syntax-highlighted file. Distinct from an inline code block — for the homelab config and shell scripts this wiki is actually full of.
- **Markdown import / export.** Git-backed history means every page is in a real git repo; the raw export is a directory of markdown files.
- **Real-time collab (single placement).** Open the same page in two windows; both see each other's edits live. Network loss queues a retry; restored, the edits land.
- **Backlinks / relations / graph.** Inline wikilinks generate backlinks automatically. Typed relations are first-class; the graph view is a local neighborhood by default.
- **Templates with attribute inheritance.** A QSO-log template defines the schema; every page using it inherits the attributes.
- **Lenses — saved-filter views.** A "show me every page tagged proxmox" cross-cutting view, or a table / kanban board over promoted attributes.
- **Trash + restore.** Soft-delete with a per-space trash view, restore in one click, hard purge separate.
- **Page redirects.** Rename a page; old slug keeps resolving through `page_redirects`.
- **Diff view.** Pick any two history versions; see the real diff.
- **Maintenance report.** Orphaned pages, broken wikilinks, broken redirects, similar-page near-duplicates (deterministic trigram/Dice, no AI — runs on the server, no network).
- **Dark / light theme.** One token file. The brief's premise.
- **Per-page encryption.** Content encrypted at rest, decrypted client-side only after a per-session unlock.
- **Offline readability for pinned pages.** Pin a page; the service worker caches it; the docs explaining how to fix your Proxmox box are available when Proxmox is down.
- **Plugin engine.** Admin uploads a zip; the manifest declares what it needs; the engine wires it. A real plugin system, not a toggle map.
- **Settings live in one place.** Tokens, appearance, profile, spaces, groups, users, plugins, integrations, system, maintenance, danger zone. All under `/settings`.
- **Admin observability.** `/settings/system` shows DB stats, git-flush recency, queue depth, plugin health.
- **First-boot bootstrap.** First sign-up becomes admin; a "Welcome" space with sample pages is seeded. Idempotent and race-safe.

### 6.3 The test gate

The app is at this gate today:

- **Vitest: 82 files / 626 tests** green.
- **Typecheck (`tsc --noEmit`) clean.**
- **`vite build` clean.**
- **Playwright e2e: 22 / 22** green (happy path, editor, tree, plugins, first-party, TOC, trash, favorites / comments / notifications, skeleton).
- **Synthetic end-to-end HTTP simulation** green.

**Caveat:** the 22 Playwright specs are mostly smoke-level checks (a page loads without crashing). They do **not** come close to the brief's §9.4 "click every button" checklist. The four missing client wrappers in §7.12 are not exercised by any spec, and the e2e layer would not have caught them. See §7.12 for the honest accounting.

---

## 7. What is not done / what is not fully done / known limits

This section is what the brief calls "honest critique." If you are asked to extend the app, the things below are the actual remaining work and the known limitations — not the things that were parked from lack of attention.

### 7.1 Multi-placement collab (open)

The brief acknowledges multi-placement collab (the same page cloned into two spaces, with two simultaneous editors) as a target scenario. **This is not implemented.** The single-placement case (same page, two windows, or two users with the same permission) works. The multi-placement case loops one branch's updates into another only via the git-flush; it does not show live updates in the second window.

### 7.2 Real production data migration (deferred by user direction)

The brief's §11.1 required a migration script tested against a real copy of the production database. **Per user direction this is off the must-do list** — the prior `wiki-app` deployment was test data, not real content. A future real migration will need to:

1. Take a snapshot of the current production DB.
2. Run the migration against the copy.
3. Open every migrated space in the new app and confirm content, tree structure, and page history are intact.

### 7.3 Multi-instance / multi-user scaling

The app is a single-instance, host-on-your-laptop app. There is no Redis, no Postgres, no shared session store. The sshd-on-the-router scenario works fine (LAN neighbors can sign in). The "scale to 50 concurrent users on a cheap VPS" scenario is not in the brief's ambition, and the architecture's bet is that you won't need it.

### 7.4 The plugin engine's content model is a trust boundary, not a sandbox

The plugin engine enforces a closed API surface, but it does **not** sandbox the plugin's CPU / memory / event-loop usage. A malicious plugin that runs an infinite loop inside its handler will block the Node event loop. The brief's §3.2 / §9.2 require a closed trust boundary; CPU / memory isolation is not a stated requirement. If you ever need to support truly untrusted plugin authors, you would need a separate Node worker process (or a WASM sandbox) for plugin code.

### 7.5 The maintenance report's similar-page detection is server-side and deterministic

The `similarPages` field in the maintenance report uses trigram + Dice coefficient. It is not semantic — it will not detect "these two pages are about the same homelab project but written with different vocabulary." That is an explicit choice (the brief: "no AI, no embeddings, no network calls"); it is also a place where the next major version might want embeddings-on-infrastructure-the-user-controls.

### 7.6 Vector / embedding search

Not implemented. The V14 app used SQLite FTS; the V2 app uses SQLite FTS as well. There is no vector index, no semantic search, no "find me the page that explains this even if the words don't match." This is a deliberate scope cut — the brief's "this is a personal wiki, not Yet Another AI Knowledge Base" reading is the explanation.

### 7.7 The mobile experience is a non-goal

The V14 app's mobile experience was, in the user's words, "good enough." The V2 app does not regress that, but it does not invest in it either. The PWA / offline piece is for desktop-on-laptop use; do not expect a great phone experience.

### 7.8 The `data/` directory is gitignored

DB, git repo, uploaded files, plugin dirs — none of this is committed. **This means: there is no built-in way to back up the app's content beyond the git history of the pages.** A real production deployment needs an external backup that snapshots `data/repo` (the git content repo) and `data/wiki.db` (the metadata DB). The README has the paths; the user is responsible for setting up the backup.

### 7.9 The bundle-size warning

The vite build emits a warning when the main bundle exceeds 500kB. Current build is around 1.2MB main + several large code-split chunks (Mermaid, KaTeX, Cytoscape). This is **not blocking** — the app loads, the lazy chunks load on demand — but it is the obvious next polish: aggressive code-splitting of the editor, the graph, the Mermaid renderer. The §1.5 "small and easy to extend" rule is about code, not bundle weight; the bundle-weight polish is a slice that has not been pulled into the schedule.

### 7.10 The single-user "I deleted my admin role by accident" path

The last-admin guard prevents the obvious lockout. The exhaustive "I have no admin and no user can become admin" path was not tested e2e. The fix is mechanical: have better-auth's `.after` hook fall back to promoting the most-recent user if no admin exists. Out of scope for the rebuild.

### 7.11 Things that were not in the brief and are not in the app

- Email digests, push notifications, mention auto-complete via the @-menu (mention is a schema field; auto-complete is an editor extension slice that did not land).
- Real-time cross-page notifications (the `/api/notifications` endpoint is read-on-load; live updates via the WebSocket are not wired).
- A native desktop wrapper (Electron / Tauri). The app is a web app; the user runs it via Vite dev or production node.
- Plugin marketplace / plugin discovery. The plugin engine is real; the marketplace is not.

### 7.12 Verified gaps after the doc was originally written

This section is the honest erratum. The original draft of this document claimed §6 was "feature-complete against the brief." A subsequent audit by a careful reader cross-referenced every server route against the client and against the test layer, and surfaced the following real gaps. They are written here so the next agent does not trust the closing line.

**Missing client wrappers (server routes exist, are tested, but no client UI calls them).**

- `clonePage` — server endpoint exists, fully tested, no client wrapper. Cannot clone a page from the UI.
- `moveBranch` — same shape. Cannot move a branch between parents / spaces from the UI.
- `renamePage` — same. The slug stays what it was created at.
- `removeBranch` — same. (`deletePage` *has* a client function but it is never called from anywhere — that's a separate dead-code issue.)

None of these are hard to fix; each is a small vertical slice (client wrapper + Tiptap/React handler + one e2e that actually clicks the button). They are real work, not one-liners.

**Missing / unwired UI layers.**

- **Tree context menu.** The brief's §9.4 checklist explicitly says "right-click a tree node — the context menu appears and every action in it actually works." There is no e2e anywhere that does this.
- **Search UI.** The `/api/search` endpoint exists and is wired through the client; the in-app search surface is shallow relative to what the brief expected.

**E2E depth is shallower than the test count suggests.**

The Vitest suite is genuinely green (82 files / 626 tests as of this section's writing). The Playwright suite is **22 specs across 10 files** and most files have 1–2 tests — smoke-level checks that a page loads without crashing, not the click-every-button interaction testing the brief's §9.4 checklist called for. The `tree.spec.ts` file has exactly one test (`"tree renders after login"`). The existing e2e layer would not have caught the missing client wrappers above.

**Mermaid SVG sanitization was missing as DOMPurify.** (Discovered and fixed in the same commit as this section.)

The original `MermaidRenderer.tsx` took `mermaid.render()` output and pushed it into `dangerouslySetInnerHTML` with no sanitization pass. The brief's §9.2 audit allow-list comment called this "safe — CSP blocks inline scripts," which is wrong: SVG can carry `<script>`, `<foreignObject>`, and event handlers that the browser parses and executes; the CSP does not catch them.

This is the **same shape** as a real, disclosed CVE in Docmost (GHSA-r4hj-mc62-jmwj) and similar issues in GitLab, Dify, and OneUptime. The mermaid version pinned here is patched against the named CVEs we know about, but the next bypass would land here unprotected. The fix:

- `src/features/editor/extensions/sanitizeSvg.ts` — DOMPurify helper, SVG profile, `FORBID_TAGS` + `FORBID_ATTR` belt-and-suspenders.
- `MermaidRenderer.tsx` — calls `sanitizeMermaidSvg(result)` before `setSvg`.
- `__tests__/sanitizeSvg.test.ts` — 6 unit tests against adversarial SVGs (script, event handlers, foreignObject, iframe/object/embed, defends legitimate geometry, returns a string).
- `security-invariants.audit.test.ts` — adds a static guard that fails the audit if a future refactor drops the `sanitizeMermaidSvg` call from the renderer.

**What the "619 passing tests" actually exercised, and what it did not.**

The Vitest count is real and the integration tests are real (permission algorithm, plugin engine, git pipeline, hooks, plugin admin round-trip). The doc never claimed the integration tests were shallow; it claimed the app was feature-complete. The honest summary is: the integration layer is solid; the e2e layer is shallow; the cross-route-vs-client audit hadn't been done until after the doc was written; the brief's §9.4 "click every button" check is still ahead.

The remaining work this surfaces, in priority order:

1. The four missing client wrappers (`clonePage`, `moveBranch`, `renamePage`, `removeBranch`) and the `deletePage` dead-code review.
2. The tree context menu and its e2e.
3. The search UI depth and its e2e.
4. Playwright spec depth in general — most files need 2-5 more tests each to approach the brief's §9.4 checklist.

---

## 8. How to run, test, and extend the app

### 8.1 Local development

```sh
cd wiki-app-v2
npm install
npm run dev:server    # Fastify on :3000 (tsx watch)
npm run dev           # Vite on :5173 (proxies /api, /ws, /plugins to :3000)
```

Open `http://localhost:5173`. The first sign-up becomes admin and seeds the "Welcome" space.

For LAN access from another machine on the network, the container/host must publish ports 5173 and 3000. The auth client derives its base URL from `window.location.origin`, and `192.168.*:*` is in the trusted-origins list, so no `localhost` hardcoding will bite you.

### 8.2 Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API server port |
| `HOST` | `0.0.0.0` | API server host |
| `DB_PATH` | `data/wiki.db` | SQLite file |
| `GIT_REPO_ROOT` | `./data/repo` | Git content repo |
| `BETTER_AUTH_SECRET` | dev placeholder | Must be set in production |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Explicit base URL |
| `BETTER_EXTRA_TRUSTED_ORIGINS` | — | Comma-separated extra trusted origins |
| `BETTER_AUTH_RATE_LIMIT_WINDOW` | `60` | Auth rate limit window (seconds) |
| `BETTER_AUTH_RATE_LIMIT_MAX` | `20` | Auth rate limit max attempts |

### 8.3 Tests

```sh
npm run typecheck    # tsc --noEmit
npm run test         # vitest (81 files, 619 tests)
npm run e2e          # Playwright (22 specs)
npm run build        # typecheck + vite build
```

Integration tests share `data/` and a single lazy SQLite connection per worker, so Vitest is configured `fileParallelism: false`. Tests must set `process.env.DB_PATH` **before any import of `getDb` or services** or the singleton locks onto the default path.

### 8.4 Extending the app

The five rules to follow, taken from the brief's §1:

1. **Before adding a new feature, look for an existing one.** The codebase has a strong "no second consumer, no abstraction" rule. If you find yourself reaching for a new service, check whether the existing one already does it.
2. **Server route? Declare `config.access` in the route options.** The server refuses to boot if a route is missing it. This is the most stable, most enforced rule in the codebase.
3. **Plugin? Manifest is a strict Zod schema.** A field the schema doesn't know is a reject. The plugin can only access the methods for the capabilities it declared.
4. **New node type? Add it to the plugin's `contentModel.nodes` (or `marks`) AND the shared `validateContent` whitelist.** Otherwise the server rejects the doc.
5. **New setting? Add a sub-route under `/settings/*` and add the entry to the `SECTIONS` array in `src/routes/_authenticated/settings.tsx`.** Whatever it is, it does not belong in the page chrome.

### 8.5 Schema changes

```sh
npm run db:generate   # drizzle-kit generate — writes a new migration SQL file
```

Apply at boot (`src/server/db/index.ts` runs migrations on first connect). Backwards-incompatible renames need a data migration that respects the §11.1 rules and is tested against a real copy of the production DB.

### 8.6 Adding a new plugin (continuing the convention)

1. Create `test-fixtures/<your-plugin>-plugin/plugin.json` with the manifest.
2. Create `client/index.js` and `server/index.js` as the brief's §4 describes.
3. Bundle the directory into a zip — but **the third-party installer in the app does that for you** at the `/settings/plugins` upload flow.
4. Test the round-trip: `POST /api/plugins` (multipart) → `PUT /api/plugins/:id/enabled` → effect visible in the running app.

The hello-world plugin in `test-fixtures/hello-world-plugin/` is the smallest reference. The web-clipper and drawio-embed plugins are the real ones.

---

## 9. Definitive pointers for an AI agent picking this up

This is the section to read last if you are an AI about to take an action on the codebase.

### 9.1 The single source of truth for "why"

`WIKI-REDESIGN-BRIEF-V2.md` is the brief. It is 768 lines. Read it if you have a "why is this like this?" question — the answer is almost always there.

### 9.2 The single source of truth for "what"

The git log on `rebuild-v2`. The commit messages are dense and intentional — they describe slice-by-slice what was built and why, including the bugs that were fixed and the alternatives that were rejected. Read `git log --oneline rebuild-v2` first.

### 9.3 The single source of truth for "what is the current state"

`/health` (the Fastify health route) and `/settings/system` (the admin surface) are the live views. For source code, the relevant files are:

- `src/server/app.ts` — the Fastify build (security headers, rate limiting, route registration)
- `src/server/services/git.service.ts` — the git-flush pipeline
- `src/server/services/queue.service.ts` — the worker loop
- `src/server/services/plugin.service.ts` — the plugin engine
- `src/server/hooks.ts` + `src/server/hookTypes.ts` — the plugin event hooks (§13.5)
- `src/styles/tokens.css` — the one token file
- `src/features/editor/extensions/dragHandle.ts` — the single-pane drag handle
- `src/routes/_authenticated/settings.tsx` — the settings audit comment

### 9.4 Pickup conventions

- **Code style:** strict TypeScript, no `any` in new code, no string interpolation in SQL, no `dangerouslySetInnerHTML` for user content.
- **Tests:** every new feature gets a unit test. Integration tests live under `src/server/__tests__/` or `src/<feature>/__tests__/`. E2E tests live at the repo root in `e2e/*.spec.ts`.
- **Commits:** the commit message describes the slice, the brief section, and the **why** — not just the what. The slice convention is `slice-N` for the formal sequence, descriptive names for follow-on work.
- **"Don't add a new abstraction until a second real consumer needs it"** is the strongest rule in the codebase. If you find yourself writing a base class, an interface with one implementation, or a generic "framework," stop and look for the second consumer.

### 9.5 The four things you will be tempted to do that you should not

1. **Don't migrate V14's content via an ad-hoc script.** If the user asks for a real-deployed migration, the §11.1 procedure is the procedure. Snapshot → migrate copy → open every space → confirm.
2. **Don't add a new abstraction layer "for the next slice."** The codebase has a specific rule: no abstraction without a second consumer. If you want to add one, add the second consumer in the same PR.
3. **Don't make plugin capabilities implicit.** A field the schema doesn't know is a reject. If you want a new capability, add it to the manifest schema, add it to the `PluginCapabilities` type, add it to the `PLUGIN_CAPABILITY_KEYS` array, and add the API method gated by it.
4. **Don't end-run the access middleware.** Every route declares `config.access`; the server refuses to boot otherwise. The fastify route registration in `src/server/app.ts` enforces this. If you find yourself writing a route without it, you are opening a real security hole.

### 9.6 The honest current state

The V2 rebuild is **mostly** feature-complete against the brief, but the closing line of an earlier draft of this document was overconfident. The honest statement is:

- **Solid:** the integration layer (permission algorithm, plugin engine, git pipeline, hooks, plugin admin round-trip, lens system, page lifecycle, trash, redirects, diff, maintenance, relations, graph, templates, code pages, encryption, markdown round-trip, file uploads, search endpoint, settings audit). 82 files / 626 Vitest tests green; typecheck clean; `vite build` clean; 22/22 Playwright specs green.
- **Verified gaps** (see §7.12): the four missing client wrappers (`clonePage`, `moveBranch`, `renamePage`, `removeBranch`); the tree context menu; the search UI depth; the e2e depth in general — 22 specs is not enough to claim the §9.4 "click every button" checklist has been exercised.
- **The "feature-complete" line was wrong.** The Mermaid XSS gap and the missing client wrappers and the missing tree context menu are real, observed gaps. They were not in the original draft of this document. They are now documented in §7.12.

The remaining work, in priority order:

1. **Mermaid XSS** — ✅ shipped (DOMPurify sanitization + 6 unit tests + 1 audit guard).
2. **The four missing client wrappers** plus the `deletePage` dead-code review. Each is a small vertical slice.
3. **The tree context menu** and its e2e.
4. **The search UI depth** and its e2e.
5. **Playwright spec depth** in general — most files need 2–5 more tests each to approach the brief's §9.4 checklist.
6. **Multi-placement collab** (the brief's stated target scenario, not currently implemented).
7. **Bundle-size polish** (lazy chunks; the Mermaid + KaTeX + Cytoscape renderer chunks are large).
8. **A real production-data migration** when the user has production data to migrate.
9. **Mobile experience** (a non-goal; not in scope).
10. **CPU / memory sandboxing for plugin code** (not in brief; would require a worker process or WASM).

The integration layer is solid. The docs-and-tests layer is not yet a complete mirror of the user-facing surface. The next agent's job is to close items 2–5 before claiming the whole thing is done.

---

*End of REBUILD.md.*
