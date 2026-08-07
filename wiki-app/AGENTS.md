# Wiki App — AGENTS.md

Git-based wiki with admin/settings UI, git push/pull/sync, clean Markdown
export, real-time collab (Hocuspocus/Yjs), group/space permissions. The single
authoritative project document is **`../README.md`** (architecture, feature
inventory, deployment, deferred work, process notes). This file is the
operational memory: commands, boot requirements, hygiene rules, and invariants
that must not regress. Do not duplicate README content here.

## Commands

- `npm run dev:server` — API + WebSocket on :3000 (`tsx watch`)
- `npm run dev:client` — Vite on :5173 (proxies /api to :3000)
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest (25 files, 218 tests)
- `npm run db:push` — `drizzle-kit push --force`
- `npm run build:client` — vite build
- `npx playwright test --config=e2e/playwright.config.ts` — E2E tests (13 tests, headless Chromium)

## Server boot requirements

The server REFUSES to boot without these env vars (checked eagerly in
`app.ts` / `crypto.service.ts`):

- `SETTINGS_ENCRYPTION_KEY` — required for the settings framework
- `BETTER_AUTH_SECRET` — required by better-auth
- Optional: `DB_PATH` (default `./data/wiki.db`), `GIT_REPO_ROOT`
  (default `./data/repo`), `FILES_ROOT` (default `./data/files`),
  `BETTER_AUTH_URL`, `PORT`, `BETTER_EXTRA_TRUSTED_ORIGINS`.

A `/tmp/wiki-env.sh` file with the dev `SETTINGS_ENCRYPTION_KEY` exists but is
not tracked; if it is missing, any new key works only when the
`system_settings` table is empty (it encrypts `smtp_pass`/`git_remote_token`
etc.). Reset the DB and the key together, not one at a time.

Dev server started for UI work:
`DB_PATH=./data/wiki.db GIT_REPO_ROOT=./data/repo FILES_ROOT=./data/files BETTER_AUTH_SECRET=dev-secret-... SETTINGS_ENCRYPTION_KEY=<key from /tmp/wiki-env.sh> PORT=3000 npm run dev:server`

## Data / test hygiene

- `./data` is NOT tracked (`data/` in .gitignore). `data/wiki.db` holds the
  real users/spaces/pages (3 users incl. admins `nealhamilton@gmail.com`,
  `phase2@test.local`; 3 spaces). Reset only if you also regenerate the
  encryption key.
- Service tests create their own DBs under `./data/test-*.db`, push the
  schema with `npx drizzle-kit push --force`, and delete after. Always set
  `DB_PATH` + `SETTINGS_ENCRYPTION_KEY` in the test file BEFORE importing the
  service modules (module-level constants).
- Repo `scripts/` holds old repro/debug scripts — not part of the product,
  do not commit.

## Architecture map

- `src/shared/` — shared between client+server: `settings.ts` +
  `settings-registry.ts` (declarative setting defs), `blockIds.ts`
  (UniqueID backfill), Tiptap helpers, `permissions/` (access algorithm).
- `src/server/` — Fastify app (`app.ts`), better-auth (`auth/`), Drizzle
  schema (`db/`), Hocuspocus collab server, queue worker (`queue/worker.ts`
  handles `git_push`, `git_pull`, `git_import`, snapshots), services
  (`services/`: git, settings, markdown, crypto, log, search, notification,
  mention, collab, backlink, attribute, export, etc.).
- `src/server/routes/` — Fastify route plugins. `config.access: "admin"`
  gates admin routes. git.routes.ts: status/log/test-remote read-only;
  push/pull enqueue queue jobs (never run inline).
- Security invariants (Task #15, do not regress):
  - `/api/search` results (pages AND spaces) are filtered through
    `resolveAccess()` per candidate — a restricted page/space must never
    appear in title/slug/snippet for someone who can't open it.
  - `PUT/DELETE /api/attributes/:id` require a `branchId` (body / query
    param) and editor+ access on it, plus a cross-check that the branch owns
    the attribute's page. Clients must always send `branchId`.
  - `parseSearchQuery` (`search.service.ts`) is the only query parser;
    bare `or` is an operator, `-word` excludes, hyphenated words split into
    sub-tokens (FTS5 unicode61 separates on non-alphanumerics).
- `src/client/` — React SPA. `api/client.ts` is the typed API wrapper
  (all new endpoints must be added there). `features/settings/` has
  `AdminSettings` (registry-driven sections), `GitSection`, `SettingRow`,
  `ClipperSection`. `theme.css` holds design tokens + all component styles.
- Editor features: `Editor.tsx` (main page view with toolbar, bubble menu,
  drag-handle, search-replace, comment panel, permissions dialog, backlinks,
  attributes, collab toggle), `CommandPalette.tsx` (Cmd+K global search over
  spaces AND pages, grouped into "Spaces" + "Pages" sections; navigates via
  `useNavigate` to `/pages/:branchId`), `NotificationBell.tsx` (bell icon +
  dropdown feed), `wikiLinkExtension.tsx`
  ([[page]] linking), `mentionExtension.ts` (@mentions), `slashCommandExtension.tsx`
  (/slash commands). All three use `@tiptap/suggestion` v3 with plain-DOM popup
  renderers. The mention node lives in `baseEditorExtensions()` (shared by the
  editor, ShareView, and collab seed), NOT in `editorPlugins.ts` — registering
  it in both would load it twice.

## Verified state (2026-08-01, branch snapshot.3)

Green: **25 test files / 218 vitest tests**, **13 Playwright E2E**, `tsc --noEmit`
clean, `npm run build:client` green. Recent completions:

- Permissions overhaul: groups carry `capabilities`; a better-auth plugin
  (`src/server/auth/session-enrichment.ts`) injects `capabilities` + `groupIds`
  into the session user on `/get-session` and sign-in/sign-up, so client gating
  matches server enforcement. Capability resolution lives in
  `src/server/services/capabilities.service.ts` (shared with `auth.service`).
- Space-level permissions UI (`SpacePermissionsPanel.tsx`) inside the branch
  PermissionsDialog: default role, member list, group grants. Backed by
  `space-permissions.integration.test.ts` (7 tests).
- Safe user deletion (`src/server/services/user-delete.service.ts`): reassign
  owned pages to a heir or delete them, covers every FK-bearing table; admin
  cannot self-delete (server + UI). User export (zip of Markdown) via
  `/api/admin/users/:id/export`. Both covered in `admin.integration.test.ts`.
- Plugin toggles are real per-user prefs (`user_settings`), gated in the
  editor; the toggles UI lives on the per-user Settings page (not admin-only).
- Editor drag handle fixed: drop handler uses `TextSelection.near(...)`, handle
  is `position: fixed` (its JS feeds viewport coords). Still open: no app
  outline for `.ProseMirror-selectednode`.
- Backlinks click now navigates with react-router (`/pages/:branchId`), not the
  dead `window.location.hash` pattern.
- MCP `search_pages` filters every candidate through `resolveAccess()` so a
  page behind a group-permission boundary inside an accessible space never
  leaks via the search tool (regression test in `security.integration.test.ts`).
- Vite `manualChunks` split react/router/arborist/ui-vendor out of the login
  shell.

Longer historical bug-fix logs were removed during doc consolidation (2026-08-01);
the fixes remain covered by tests. See `../README.md` §5 and §8 for the full
inventory and the process/verification notes.


## Previous (resolved) issue — do not re-introduce

- WikiLinkExtension once crashed the production bundle
  (`t.getState is not a function`). Fixed in commit a21d7cc by giving each
  Suggestion-based extension its own `new PluginKey(...)` (`slashCommand`,
  `wikiLink`, `mention`) instead of sharing the default `SuggestionPluginKey`,
  and switching the popups to plain-DOM renderers (no React createRoot). This
  IS fixed — the wiki-link/menu/mention popups now render in the prod bundle.

## E2E tests

Located in `e2e/`. Uses Playwright with a headless Chromium browser.

**Architecture:**
- `e2e/start-server.sh` — builds client, pushes DB schema, starts server
- `e2e/playwright.config.ts` — webServer points to start-server.sh
- `e2e/setup.ts` — global setup: seeds test users via better-auth REST API,
  then logs in via browser and saves auth state to `auth-admin.json` /
  `auth-user.json` (gitignored)
- `e2e/wiki.spec.ts` — 5 tests covering sidebar, space/page creation,
  content editing/saving, Cmd+K palette, settings page
- `e2e/editor-features.spec.ts` — 6 tests covering the fixed bugs: slash-menu
  keyboard selection, wiki-link insert (no corruption), mention node insert +
  saved JSON check, toolbar image upload, upload after markdown-imported
  content (regression for the `contentMatchAt` bug), and anonymous share-view
  image rendering (share link → unauthenticated context → image `naturalWidth > 0`).
  Image locators must exclude `.ProseMirror-separator` placeholders
  (`img:not(.ProseMirror-separator)`) since images are inline nodes.

**Running:** `npx playwright test --config=e2e/playwright.config.ts`
`e2e/start-server.sh` removes the stale E2E DB (and WAL/SHM) before
`drizzle-kit push` — a previous run's FTS virtual tables otherwise abort the
push — so runs are reproducible without manual cleanup. `e2e/auth-*.json`
storage states are gitignored and regenerated by `setup.ts`.

**Key decisions:**
- Users are seeded via the REST API (`POST /api/auth/sign-up/email` with
  Origin header) rather than through the browser UI — much faster and avoids
  flaky UI-based registration
- Tests navigate to `/pages/${branchId}` directly using the slug-based
  `getBranchIdBySlug()`/`getFirstBranchId(page, slug)` helpers (which call the
  spaces/tree API and search EVERY space) instead of clicking tree labels —
  tree click navigation via React Router's `navigate()` was unreliable, and
  `spaces[0]/tree[0]` is fragile once other tests have created spaces. New
  tests must pass the slug they created.

## Settings framework (§7.10b) conventions

- Register defs in `src/shared/settings-registry.ts` with a stable `key`
  (stored in `system_settings`). Sections render in registration order.
- The registry is the source of truth for secrecy: a `type: "secret"` def is
  ALWAYS encrypted at rest and masked in the list view, even if a caller
  passes `isSecret: false`.
- `validateSettingValue` runs in settings.routes.ts for PUTs; unknown keys
  are allowed unvalidated (backward compat) and surface under the "Custom"
  section.
- Git remote config is read from settings at call time (`git_remote_url`,
  `git_remote_token`, `git_remote_branch`) — never cached, so changes apply
  without restart.

## Git notes

- Local repo defaults to branch `master`; remote default branch `main`.
  `pushToRemote` maps local→configured remote branch explicitly
  (`refs/heads/${local}:refs/heads/${remote}`).
- `pullFromRemote` imports into a shadow checkout (`./data/repo-shadow`),
  never the live working tree; imports Markdown per-space by slug and writes
  a pre-import snapshot commit first (last-write-wins per page).
- `getRepoStatus` fetches with the auth-embedded URL (token embedded only in
  the transient git URL, never stored/logged).

## Verification account

`admin-verify@test.local` / `AdminPass-verify-123` was created (admin) during
UI verification and left in `data/wiki.db` for future sessions. Passwords for
the original admins are unknown.

## Dev-DB state (as of last cleanup, 2026-08-04)

- Spaces: `Home Lab`, `Test Space`, `TEST1`, `Main` (4). Pages: 7. Users: 11
  (original admins + `demo@example.com`, `testuser@example.com`,
  `admin-verify@test.local`, `admin-e2e@test.local`, `user-e2e@test.local`,
  plus the curl-probe accounts `test@x.com`, `lan@test.com`, `check@test.com`,
  `ping@test.com`).
- Wiki-wide search is reachable two ways: the always-visible `SearchBox.tsx`
  (top of the main panel) and the Cmd+K `CommandPalette.tsx`. Both share
  `useWikiSearch.ts` (`useWikiSearch` fetch hook + `useWikiSearchNavigation`).
- `indexPage` (search.service.ts) falls back to the page slug as the FTS
  title; page create/save routes index with the slug, so pages are findable
  by slug immediately. After DB edits that touch pages, re-index via
  `npx tsx scripts/cleanup-test-data.ts` (also removes test data — see below).
- `scripts/cleanup-test-data.ts` (gitignored, like the other repro scripts)
  idempotently deletes the spaces/pages/users created by manual-verify and
  debug runs (`VerifySpace`/`Dbg*`/`DragSpace`/`KeyFresh*`/`UploadProbe`,
  `verify-*`/`dbg-*`/`imgdbg-*`/`drag-*`/`probe2` users), cleans orphaned
  `page_fts`/`favorites`/`data/files` rows, and re-indexes surviving pages.
  Run it after any test session that touched `data/wiki.db`.
- Known pre-existing issue (not search-related): the `Home Lab` "Linux" page
  content is corrupted in `data/wiki.db` (text fragments like `dge.pdf`,
  `!/b`, `in/bash` were left by an old upload/comment debug bug). It matches
  search via its slug title only. Recovering the original text is out of scope
  until the user provides it.
