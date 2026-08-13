# PROJECT-OVERVIEW

USER_CONTEXT: Continue building wiki-app-v2 following WIKI-REDESIGN-BRIEF-V2.md vertical slices. Ship complete app, fix bugs in each phase.

## Task tracking

- **slice-10 (Git flush pipeline):** completed.
- **slice-11 (Collab via Hocuspocus):** completed — root-cause bug fixed, all gate tests green, full manual lifecycle verified.
- **slice-12 (Plugin engine):** completed — code + E2E gate green (10/10 e2e parallel, 176/176 unit/integration).
- **slice-13 (First-party plugins — web clipper & Draw.io embed):** completed — code + gate green (12/12 e2e parallel, 195/195 unit/integration), incl. a real slash-menu bug fix. See SLICE-13 section.
- **slice-14 (Settings consolidation + §7.2 audit comment):** completed — `d3dee0c`, `f37a89d`, docs `2d8f4db`. See slice-14 commits.
- **slice-15 (Theming architecture — §5 single-token-layer):** completed — `src/styles/tokens.css` now owns every color/radius/font/shadow/animation value; `@theme inline` Tailwind alias block moved to `tokens.css`; component-code sweep across `useCollab.ts`, `Editor.tsx`, `FavoriteButton.tsx`, `CommentsPanel.tsx`, `extensions/MermaidRenderer.tsx`, `settings/plugins.tsx`; enforcement test in `src/styles/__tests__/theme.test.ts` (3 checks). 211/211 unit/integration green; typecheck clean; `vite build` succeeds.
- **slice-16 (users · groups · admin UX polish — §7.1):** completed — themed `ConfirmDialog` component on the native `<dialog>` element replacing `confirm()` for destructive actions on Users + Groups; capability-editing UI in `/settings/groups` (closed catalogue matching `CAPABILITY_ROUTE_MAP` + `create_permanent_links`); Users page search + last-admin guard + retry-able error banner + unverified-email marker; settings layout drops the redundant H1 (each sub-page owns its own). 24 files / 212 tests green; typecheck clean; build clean.
- **slice-17 (full regression pass + §9.4 checklist coverage):** completed — three Playwright `heading: "Settings"` sentinels in `e2e/plugins.spec.ts` rewritten to use the plugins page's own `"Installed Plugins"` heading (slice-16's settings-layout H1 removal had silently broken them); `InMemoryRateLimiter` (from slice-3, previously dead code — only its own unit tests imported it) wired into the share-link branch-auth path in `src/server/middleware/access.ts` as `SHARE_LINK_PASSWORD_LIMITER` (10 attempts / 5min per IP, 11th → 429, `sweep()` interval scheduled via `onReady` and `unref()`'d); new `src/server/__tests__/share-link-rate-limit.integration.test.ts` with two cases (wrong-password trips 429 then even the correct password does not bypass the limit; passwordless share links are never rate-limited). 25 files / 214 tests green; Vitest stable across two runs; Playwright 12/12 stable across three single runs; typecheck clean; build clean. Coverage map for every §9.4 item documented in `wiki-app-v2/AGENTS.md` slice-17 section; items 1/2/7/8 remain manual smoke, item 3 is not yet applicable (§6 future).
- **slice-18 (first-boot bootstrap — §11.6 + admin chicken-and-egg):** completed — per user direction §11.1 (production-data migration) is **off the must-do list** because the prior DB was just test data; instead the rebuild ships with an empty `data/` and a first-boot bootstrap makes a fresh deploy walkable. `databaseHooks.user.create.{before,after}` wired into better-auth in `src/server/auth/config.ts`: the `.before` hook returns `{ data: { ...user, isAdmin: true } }` iff `isFirstUser()` returns true (additionalFields.isAdmin is `input:false`, so the client cannot reach this path); the `.after` hook calls `seedWelcomeSpace(user.id)` (try/catch so a sign-up response is never 5xx'd for a seed hiccup). New `src/server/services/bootstrap.service.ts` exposes `isFirstUser()` and `seedWelcomeSpace(ownerId)` — the latter materializes the §11.6 fixture (space "Welcome" + pages welcome/notes/getting-started/cli-reference + branch tree), is idempotent (returns null if any space already exists), and is fully race-safe (concurrent first sign-ups cannot produce two Welcome spaces). `src/server/__tests__/auth.integration.test.ts` updated: first-sign-up assertion flipped from `isAdmin === false` to `isAdmin === true` (the test now exercises the bootstrap path). New `src/server/__tests__/bootstrap.integration.test.ts` (3 tests): first sign-up is admin + Welcome seeded; second sign-up is NOT admin + Welcome not duplicated; client-supplied `isAdmin: true` is stripped (defense in depth). 26 files / 217 tests green; Playwright 12/12 green; typecheck clean; build clean. Local `data/` wiped after the test verified bootstrap on a fresh DB. Slice-18 docs in `wiki-app-v2/AGENTS.md`.
- **slice-19 (§12.6 in-page table of contents — completed):** the existing inline `PageTOC` in `src/routes/_authenticated/w/$branchId.tsx` was partially built (extracts headings, renders anchor list, hides on mobile) but had three gaps: no smooth-scroll, no scroll-spy / active highlight, no depth-aware indentation, and lived inline in the 400-line route file. Extracted to `src/features/editor/TableOfContents.tsx` with `extractTocEntries` (pure, top-level headings only — nested headings inside lists intentionally excluded to match the Notion/GitBook convention) and `findScrollableAncestor` helper (the page view mounts content inside an `overflow-auto` flex child, so `window.scrollTo` is a no-op there — the TOC now scrolls the right container with a 64px chrome offset and updates the URL hash via `history.replaceState`). Scroll-spy via `IntersectionObserver` scoped to the same scroll root with `rootMargin: "-15% 0% -70% 0%"` (biases the trigger zone to the upper third of the visible area). Depth-aware padding: h1 emphasized, h3 → pl-3, h4 → pl-6, h5+ → pl-9. Renders nothing when fewer than 2 headings exist. New `src/features/editor/__tests__/TableOfContents.test.tsx` (13 tests: pure-helper edge cases + component renders-or-null + depth padding + custom minEntries + default aria-current). New `e2e/slice19.spec.ts` (2 browser tests: seeded Getting Started page renders 4 anchored links + clicking "Tips" smooth-scrolls the inner container + updates aria-current + URL hash; paragraph-only "Notes" page renders no TOC). `scripts/seed-e2e.ts` `makePage` extended with an optional `content` parameter and "Getting Started" now has a real multi-section body (Overview / Installation / Daily usage / Tips) + padding paragraphs so the e2e viewport is forced to overflow. 27 files / 230 vitest tests green; Playwright 14/14 green (was 12/12; +2 TOC tests); typecheck clean; build clean. Slice-19 docs in `wiki-app-v2/AGENTS.md`.

## Slice-13 — first-party plugins

### Gate status

- `npx vitest run` → 22 files, **195/195 passed** (was 189; +6 new slash-menu unit tests).
- `npx playwright test` → **12/12 passed in parallel**, stable across consecutive clean runs (verified twice + repeat-each for the new spec).

### What was built

1. **Boot-time server-route registration** (`registerAllPluginServerRoutes` in
   `plugin.service.ts`): Fastify forbids adding routes after `ready()`
   (`AVV_ERR_ROOT_PLG_BOOTED`), so every installed plugin's `serverRoutes` are
   registered at boot behind an onRequest `enabled` guard (no mid-run registration).
   Server plugins must use the Fastify callback signature `(fastify, opts, done)`.
2. **Web-clipper plugin** (`test-fixtures/web-clipper-plugin/`): serverRoute
   `POST /api/web-clipper/fetch` fetches a URL server-side and returns
   title/excerpt; slash command inserts a `webCitation` node (link + blockquote).
3. **Draw.io embed plugin** (`test-fixtures/drawio-embed-plugin/`): `embedTypes`
   capability — new `drawioEmbed` node + `renderReadOnly` used by `ReadOnlyContent`
   via `useEmbedTypeMap()`; slash command inserts the embed.
4. **seed-e2e.ts** pre-installs + enables both plugins so their server routes are
   live before e2e boots; `playwright.config.ts` adds `--allow-net` for the
   clipper's localhost fetch.
5. **Real bug fixed in SlashMenu.tsx:** when an ATOM node sits at the insertion
   point (a draw.io embed at doc position 0), ProseMirror inserts "/" after the
   atom, so the old `range.from` captured at type-time made the query include the
   leading "/" — the menu filtered to nothing and execute() would mis-delete.
   `computeSlashQuery` now recomputes query + range from the caret's text block on
   every doc change (menu only opens at line start / after whitespace, so block
   text is `<slash><query>`). Verified: the /web slash now resolves next to a
   leading draw.io node; unit-tested in `slashMenu.test.ts`.
6. **Test hardening:** plugins.spec hello-world slash test clicks its command
   button instead of Enter (Enter runs the FIRST filtered command; slice-13 seeds
   web-clipper/drawio before hello-world is uploaded). firstparty assertions use
   `.first()` so repeat runs that accumulate content on the seeded cli page don't
   trip strict-mode violations.

### Known repeat-mode caveat (pre-existing, not blocking)

`npx playwright test --repeat-each=2` reuses ONE seeded server, so stateful specs
fail on the second pass: `plugins.spec.ts:26` (hello-world already enabled) and
`slice9.spec.ts:63` (notification already read). Both pass on every fresh seed;
the firstparty spec is repeat-stable.

## Slice-12 — plugin engine

### Gate status

- `npx vitest run` → 20 files, **176/176 passed** (was 174; +2 new plugin install integration tests).
- `npx playwright test` → **10/10 passed in parallel**, stable across consecutive runs.

### What was fixed to pass the gate

1. **Real bug: every plugin upload returned 500.** `installPluginFromZip` in
   `src/server/services/plugin.service.ts` called `rm(tmpDir, { force: true })` without
   `recursive: true` on the temp extraction directory → `EISDIR` before the rename.
   Removed the erroneous line. Missed by tests because the plugin integration suite
   never actually uploaded a zip (only 401/415/validation cases).
2. **Manifest content-model bug.** The fixture's `plugin.json` declared
   `contentModel.nodes: []` while registering a `helloWorld` node — the server's
   `validateContent` would have rejected the saved content on the reload-persistence
   step. Manifest now declares `"nodes": ["helloWorld"]`; zip regenerated.
3. **Missing integration coverage added** (`plugin.integration.test.ts`):
   - real multipart upload → 201 + files on disk + `nodeTypes` from manifest
   - duplicate install → 409
   - test user promoted to global admin directly in the DB (signup can never set
     `isAdmin`; plugin upload routes are admin-only).
4. **E2E spec hardening** (`e2e/plugins.spec.ts`):
   - upload test no longer depends on the transient "Installed! Reloading…" status
     (the reload races past it); waits for the fresh table row instead.
   - slash test types `/` at doc start (`Control+Home`) — clicking the editor center
     lands mid-text once earlier specs have typed into the page.
   - slash test uses the seeded **"notes"** page, NOT "welcome": `editor.spec` and
     `slice9.spec` edit welcome in parallel workers, and their collab round-trips
     re-render its editor mid-interaction (eating the slash-menu Enter).
5. **Better-auth rate limiter exhausted mid-suite (429 → login stuck).** The
   webServer disabled `/sign-in/*` and `/sign-up/*` only; the global bucket (20/60s)
   on `/get-session` etc. was burned by every page load across 10 tests. The
   playwright webServer now also sets `BETTER_AUTH_RATE_LIMIT_WINDOW=3600
   BETTER_AUTH_RATE_LIMIT_MAX=10000`.

### Slice-12 architecture (as built)

- Server: `src/server/services/plugin.service.ts` (upload/install/enable/disable/
  uninstall, path-traversal guard, DB persistence in a `plugins` table),
  `src/server/routes/plugin.routes.ts` (admin-gated `/api/plugins` CRUD +
  `/plugins/:id/.../client.js` bundle serving).
- Client: `src/plugins/registry.ts` + `src/plugins/loader.ts` (dynamic-import plugin
  bundles from `/plugins/<id>/client/index.js`), hooks (`useTiptapExtensions`,
  `useSlashCommands`, `useToolbarItems`, `useSettingsPanels`), `SlashMenu` (rewritten
  state machine: keyboard nav, Enter/Escape), admin UI under `/settings/plugins`.
- Wiring: `vite.config.ts` proxies `/plugins` → Fastify; `_authenticated.tsx` calls
  `loadPlugins()` and gates rendering on plugins loaded; `seed-e2e.ts` marks the e2e
  user `isAdmin=true` and the webServer wipes `data/plugins` before each run.
- Fixture: `test-fixtures/hello-world-plugin/` (dir + zip) — manifest with
  `contentModel.nodes:["helloWorld"]`, a Tiptap node registered via the PluginAPI,
  a slash command, a settings panel registration, and a server route module.

## slice-11 — what was actually wrong and what was verified

### Root-cause bug fixed (StrictMode double-mount)

`src/features/editor/useCollab.ts` created the `HocuspocusProvider` during render and
destroyed it in a `useEffect` cleanup. React StrictMode (dev) runs mount → cleanup →
mount, so the just-created provider was destroyed immediately and the second mount
reconnected endlessly (7 WS upgrades, "reconnecting…" in the status pill).

Fix: create the provider once into a `sessionRef` (kept across the StrictMode cycle),
and defer the destroy with a `mountedRef` guard + `setTimeout(0)`. Cleanup sets
`mountedRef.current = false`; the re-mount effect sets it back to `true` before the
timeout runs, so a simulated unmount is a no-op and only a genuine unmount destroys
the session. Manual test after fix: exactly 2 WS upgrades (two tabs), stable "synced"
status.

### Verified lifecycle (manual, two tabs + DB inspection)

- Seed: `loadOrCreateDoc` with no stored `collab_documents` row seeds the live Yjs doc
  from `pages.content` via `prosemirrorJSONToYDoc` (content lands in the **XmlFragment
  named `default`**, NOT a `Y.Text`). Verified: seeded "Quick brown fox…" renders in the
  collab editor after entering live edit.
- Sync: two tabs on the same branch sync live (typing appears instantly; awareness
  active).
- Persistence on stop: stopping live edit unmounts the collab editor → provider destroy
  → WS close → Hocuspocus `onStoreDocument` (debounced) → `storeDocument` writes the
  Yjs update to `collab_documents` and converts back to ProseMirror JSON into
  `pages.content` (plus FTS re-index + git flush enqueue). Verified by typing a marker,
  stopping, and reading the DB: `collab_documents` row exists and `pages.content`
  contains the marker.
- No-edit stop: no document updates → no store → content untouched (verified).
- `pages.content` after store includes block `attrs.id` (generated by `ensureBlockIds`).

### Debugging invariant (learned the hard way)

The collab doc's `default` fragment is an **`Y.XmlFragment`** (y-prosemirror layout).
Do NOT inspect it with `doc.getText("default")` — that either returns an empty `Y.Text`
(created on demand) or throws "Type with the name default has already been defined…".
Read it with `doc.getXmlFragment("default")`. Any future instrumentation on
`onLoadDocument`/`onStoreDocument` must use the XmlFragment API.

### Gate tests (all passing, 8/8)

`src/server/__tests__/collab.integration.test.ts`:
1. resolves a session principal and allows an editor on a single-placement page
2. rejects a multi-placement (cloned) page for live collab
3. rejects a viewer (editor access required)
4. rejects an unauthenticated connection
5. accepts an account-scoped passwordless token and rejects a password-protected one
6. seeds a fresh collab doc from persisted page content
7. writes collab content back to pages.content and enqueues a git commit
8. does not churn the page or enqueue jobs when the collab doc is unchanged

Command run: `npx vitest run src/server/__tests__/collab.integration.test.ts` → 1 file,
8 tests passed. `npm run typecheck` clean.

### Slice-11 architecture (as built)

- Server: `src/server/services/collab.service.ts` (untracked, new) exports a
  `Hocuspocus` instance sharing the single `getDb()` connection. `onAuthenticate`
  resolves the principal (session cookie or account-scoped share token) and enforces
  the single-placement rule via `checkCollabEligibility`; `onLoadDocument` seeds from
  `pages.content`; `onStoreDocument` writes back.
- Server wiring: `src/server/index.ts` mounts a `ws` WebSocketServer on the Fastify HTTP
  server at `/api/collaboration`, forwarding `message`/`close`/`error` to the
  `hocuspocus.handleConnection(...)` client connection (Hocuspocus v4 does not wire
  these up itself with a bare `ws` server).
- Client: `src/features/editor/useCollab.ts` (new) → `CollabEditor` in `Editor.tsx`
  using `@tiptap/extension-collaboration` + `@tiptap/extension-collaboration-caret`
  over `baseExtensions()`; `content={undefined}` so local content never fights the Yjs
  doc. Route `$branchId.tsx` toggles `collabOn`, disables autosave while live, and
  waits `COLLAB_FLUSH_WAIT_MS = 2600` after stop before refetching so the Hocuspocus
  write-back (debounce ≤ 10s) lands first.
- DB: `collab_documents` table (migration `drizzle/0002_small_valkyrie.sql`).
- Deps added: `@hocuspocus/server`, `@hocuspocus/provider`, `yjs`, `y-prosemirror`,
  `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`, `ws`.

## Current environment state

- No dev servers left running (stale servers were killed to keep Playwright's
  webServer from reusing a pre-seed instance — `reuseExistingServer` skips the wipe +
  reseed when a server is already up).
- E2E boots its own stack per run against `data/e2e.db`, reseeding the admin user and
  wiping `data/plugins` first. Seed user: `e2e@test.local` / `E2ePass-1234` (space
  "Demo Space", welcome tree, `isAdmin=true`).

## Slice-15 — theming architecture (§5)

### Gate status

- `npm run typecheck` → exit 0.
- `npm test` → **211/211 passed** (+3 from `src/styles/__tests__/theme.test.ts`).
- `npm run build` → typecheck + vite build clean.

### What was built

1. **`src/styles/tokens.css` is now the single source of truth for every
   look-and-feel value.** Three theme blocks (`:root` light defaults,
   `[data-theme="dark"]`, `[data-theme="contrast"]`) cover ~70 color roles
   (background, surface stack, foreground, text-secondary/muted, borders,
   primary, link, success/warning/danger/info, focus-ring, selection,
   code/inline-code, blockquote, table-header, highlight, scrim, plus
   10 caret colors for collab). `:root` also owns non-color tokens:
   typography (`--font-sans/serif/mono`), a 10-step radius scale, four
   shadow levels, three timing tokens (`--duration-fast` 120ms /
   `--duration-normal` 150ms / `--duration-slow` 250ms) +
   `--ease-default`, `--border-width`, and chrome dimensions
   (`--topbar-height`, `--sidebar-width`, `--settings-nav-width`,
   `--prose-width`).
2. **The `@theme inline { … }` Tailwind alias block moved from `app.css`
   to the bottom of `tokens.css`.** This makes the single-file-change
   rule (§5.3) literal: every Tailwind utility (`bg-primary`, `text-danger`,
   `shadow-md`, `border-surface`, …) and every hand-written CSS variable
   resolve to the same canonical token. `app.css` is now just `@layer base`
   rules (shadcn var remapping, prose, slash menu, editor canvas).
3. **`src/styles/__tests__/theme.test.ts` enforces the contract
   mechanically** with three checks:
   - **No literal colors outside the two whitelisted files** —
     `HEX_COLOR_RE` / `RGB_COLOR_RE` / `HSL_COLOR_RE` / Tailwind named-color
     utilities (`text-rose-600`, `bg-emerald-500/10`, etc.) are all banned
     outside `tokens.css` and `app.css`. A violation lists every offending
     file:line so a new contributor can't accidentally bypass the token
     system.
   - **Every `var(--…)` reference resolves** — `tokens.css` must define
     every token name the rest of the app reads (typos, missing roles,
     and orphans are caught at CI time).
   - **Light/dark/contrast define the same color-role set** — non-color
     tokens (typography, radii, shadow, timing) intentionally live in
     `:root` only, but every color role must appear in all three themes
     so a role referenced by a component always resolves to the active
     theme's value (not a leaked light default).
4. **Component-code sweep.** Six files had literal `text-rose-600` /
   `bg-emerald-500/10` / `text-amber-500` / `bg-red-50` style utilities —
   migrated to the new semantic tokens (`success`, `warning`, `danger`,
   `info`, `text-muted`):
   - `src/features/editor/useCollab.ts` — the JS caret palette
     (`["#f43f5e", …]`) is now read from `--user-color-0…9` at runtime
     via `getComputedStyle(document.documentElement)`. No literal color
     in JS.
   - `src/features/editor/Editor.tsx` — collab status dots.
   - `src/features/favorites/FavoriteButton.tsx` — favorited star color.
   - `src/features/comments/CommentsPanel.tsx` — resolve/unresolve
     button + Resolved label.
   - `src/features/editor/extensions/MermaidRenderer.tsx` — error state.
   - `src/routes/_authenticated/settings/plugins.tsx` — error banner,
     Enabled label, Uninstall button.

### How to re-theme

Open `src/styles/tokens.css`. Edit any value under `:root` (or any of the
three theme blocks) and save — the change propagates to every component,
every shadcn primitive, the editor prose, and the chrome without touching
any other file. The test suite guarantees the contract stays intact:
`npm test` will fail the moment someone reintroduces a literal color.

## Slice-16 — users · groups · admin UX polish (§7.1)

### Gate status

- `npx vitest run` → 24 files, **212/212 passed** (was 211; +1 new
  PATCH /api/groups/:id capability test).
- `npm run typecheck` → clean.
- `npm run build` → clean (pre-existing chunk-size warning only).

### What was built

1. **`ConfirmDialog` component** (`src/components/ui/confirm-dialog.tsx`) —
   themed, accessible confirm dialog replacing native `confirm()`. Built on
   the native `<dialog>` element so it gets `::backdrop`, focus trap, and
   Esc-to-close for free — no Radix dialog dep added. Cancels when the
   click lands outside the box (bounding-rect discrimination). Cancel
   button receives focus on open so keyboard users get a safe default;
   both actions disabled while `pending` to block double-clicks. Renders
   via a portal into `document.body`.
2. **`Button` now forwards refs** (`src/components/ui/button.tsx`) — wraps
   the render in `React.forwardRef` so `ConfirmDialog` can focus the cancel
   button via `cancelRef.current?.focus()`. No behaviour change for any
   existing caller.
3. **Users page polish** (`/settings/users`):
   - Search input filtering by name, email, or role with "N of M" hint.
   - Summary tiles: Total / Admins / Suspended.
   - Last-admin guard disabling the "Remove admin" button on the only
     remaining admin (prevents the only-admin lockout path that the
     server's self-demotion guard didn't cover).
   - Error banner with Retry (network/403 errors now offer recovery).
   - Unverified-email marker on the email cell.
4. **Groups page polish** (`/settings/groups`):
   - Capability editing UI (closed `CAPABILITY_CATALOG` matching the
     server's `CAPABILITY_ROUTE_MAP` + `create_permanent_links`). Drives
     the existing `PATCH /api/groups/:id` endpoint that had no UI before.
   - "via wildcard" badge on rows already covered by `admin.*`.
   - Group-delete confirm describes the impact ("N membership(s) and every
     permission grant issued through the group are removed").
   - Summary tiles + retry-able error banner.
5. **Settings layout** (`/settings`) — removed the redundant `Settings` H1;
   each sub-page already owns its H2 ("Users", "Groups & Permissions", …).
   The left-nav active state remains the orientation anchor.

### How to test the dialog locally

`/settings/users` — pick any non-self user → click "Suspend" → themed
dialog with destructive styling and a working Esc/cancel.
`/settings/groups` — open a group's capability checklist → toggle a few →
"Save changes" → confirm the network request and the success state.
Try `Delete` on a group with members to see the impact-confirm dialog.

## Next up (slice 17+)

17. **Full regression pass** — Vitest + Playwright + §9.4 manual checklist.

## Repo hygiene

- Branch `rebuild-v2`; latest commits `2d8f4db` (slice-14 docs), `d3dee0c`
  (slice-14 settings), `fab8e03` (slice-13 first-party plugins).
- Slice-15 theming work is **uncommitted** in the working tree:
  - `src/styles/tokens.css` (canonical tokens + `@theme inline` aliases)
  - `src/styles/app.css` (now only `@layer base`; alias block removed)
  - `src/styles/__tests__/theme.test.ts` (new — 3 acceptance tests)
  - `src/features/editor/useCollab.ts` (caret palette via CSS vars)
  - `src/features/editor/Editor.tsx` (collab indicator dots)
  - `src/features/favorites/FavoriteButton.tsx`
  - `src/features/comments/CommentsPanel.tsx`
  - `src/features/editor/extensions/MermaidRenderer.tsx`
  - `src/routes/_authenticated/settings/plugins.tsx`
  - `AGENTS.md` (slice-15 section), `PROJECT-OVERVIEW.md` (this file)
- `tsconfig.tsbuildinfo` and `data/` are untracked build/local artifacts (data/ is
  gitignored at workspace level).
