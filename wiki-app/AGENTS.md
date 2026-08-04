# Wiki App — AGENTS.md

Git-based wiki with admin/settings UI, git push/pull/sync, clean Markdown
export, real-time collab (Hocuspocus/Yjs), group/space permissions. See
`../PROJECT-OVERVIEW.md` for the full spec and phase tracking.

## Commands

- `npm run dev:server` — API + WebSocket on :3000 (`tsx watch`)
- `npm run dev:client` — Vite on :5173 (proxies /api to :3000)
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest (21 files, 176 tests)
- `npm run build:client` — vite build
- `npx playwright test --config=e2e/playwright.config.ts` — E2E tests (11 tests, headless Chromium)

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

## Bug-fix log (2026-08-01/02)

All fixes below were applied in this pass and verified: 166 unit/integration
tests, typecheck, prod build, and 11 Playwright E2E tests (incl. 6
editor-feature flows) all pass.

- **FIXED — File uploads silently fail when a page's doc is invalid
  (`contentMatchAt on a node with invalid content`).** The markdown importer
  stores a standalone `![alt](src)` line as `paragraph > image`, but the Image
  extension was block-level (`inline: false`, the default), so that paragraph
  was invalid content. Every later insert (`insertContent`, `setImage`,
  `replaceRange`) called `contentMatchAt` on the cursor's parent and threw,
  so uploads (image AND non-image) silently did nothing on affected pages
  (e.g. the Linux page). FIX: `Image.configure({ inline: true })` in
  `src/client/features/editor/baseExtensions.ts` — the schema now matches what
  the markdown importer/exporter already emit, so `paragraph > image` is valid.
  Note inline images render with invisible `.ProseMirror-separator` placeholder
  `<img>`s; E2E image locators must use `img:not(.ProseMirror-separator)`.
- **FIXED — Non-image upload inserted literal `[name](url)` text instead of a
  link.** `Editor.tsx`'s `uploadFile` now routes the attachment through
  `markdownToTiptap` (same converter as `handleMarkdownPaste`) and inserts just
  the inline content, so it becomes a real link node in the current paragraph.
- **KNOWN (cosmetic, pre-existing):** React logs "Encountered two children with
  the same key, `marks`" in edit mode with or without images (verified against
  the pre-fix schema). Tiptap v3 internal; harmless.

- **FIXED — Keyboard Enter in suggestion menus (slash / `[[` / `@`).**
  `@tiptap/suggestion` v3 passes NO `command` into `onKeyDown({ view, event,
  range })`, so all three renderers (`slashCommandExtension.tsx`,
  `wikiLinkExtension.tsx`, `mentionExtension.ts`) now keep the command bound to
  the CURRENT range in a `latestProps` closure and call that on Enter.
- **FIXED — Toolbar image upload / "Upload file" dead button.** `Editor.tsx`
  re-renders `<input ref={fileInputRef} type="file" style={{display:"none"}}>`.
  `triggerUpload()` clicks it → uploads → inserts image node.
- **FIXED — Wiki-link over-delete + focus steal.** `command` now uses the v3
  suggestion `range` directly (it already includes the `[[` trigger), so
  preceding text is preserved; the popup's search `<input>` was removed so
  arrow/Enter reach the menu.
- **FIXED — @mention notifications never fire.** `extractMentions` in
  `mention.service.ts` now matches BOTH the `mention` node shape emitted by
  `@tiptap/extension-mention` (attrs `{id, label, mentionSuggestionChar}`) and
  the older mention-mark shape. `MentionExtension` moved into
  `baseEditorExtensions()` so the editor, ShareView, and collab seed share one
  schema (a mention page previously rendered blank in ShareView/collab).
- **FIXED — Live DB missing Phase D/E tables.** Applied `notifications`,
  `favorites`, AND `attributes` (also missing!) to `data/wiki.db` by extracting
  the exact drizzle DDL from a fresh `drizzle-kit push`. `/api/favorites`,
  `/api/notifications`, `/api/notifications/unread-count`, and the attributes
  API now return 401 instead of 500. On OTHER DBs, run
  `npx drizzle-kit push --force` (interactive conflicts on pre-FTS DBs may
  require a TTY; the manual DDL extraction method is in the fix commit).
- **FIXED — Shared links dropped embedded images ("formatting jumbled").**
  The share view and editor render the SAME content/schema/CSS, but the file
  endpoint (`/api/branches/:branchId/files/:fileId`) required auth, so
  anonymous share viewers got 401s → broken image placeholders made the page
  look like formatting was lost. `shareToken` (and `sharePassword` for
  password-protected links) is now appended to image srcs by `/api/share/:token`
  (`rewriteShareImageSrcs`, token.routes.ts), and the permission middleware
  accepts a `?shareToken=` on routes that opt in via
  `allowShareToken: true` (file.routes.ts). Scope check covers the token's own
  branch, ANY sibling branch of the same page (image srcs are branch-bound but
  content/files are shared across a page's placements — the Linux page's image
  references its home-lab branch while the share is for its test-space branch),
  or any branch of a space-scoped token's space. Covered by 3 new integration
  tests + 1 new E2E test.
- **Known remaining (not a regression):** the `/image` slash command still uses
  `window.prompt("Image URL:")`. No `embed` plugin exists; the inline file
  upload flow is the toolbar 🖼 / "Upload file" button (now functional).

## Bug-fix log (2026-08-04, Phase 1 v14)

All verified: 167 vitest + 11 Playwright E2E + 21 manual checks pass, typecheck
clean, prod build OK.

- **FIXED (2026-08-04) --- Image upload after typing text: `RangeError: Position N out of
  range`.** `uploadFile` (Editor.tsx) ran `splitBlock -> setImage -> splitBlock`
  through a single Tiptap chain. Chained commands share one transaction, and
  Tiptap's `splitBlock` reads `tr.selection` (already mapped through prior
  steps) and then maps it a SECOND time via `tr.mapping.map($from.pos)`, so the
  final split landed past the document end. FIX: dispatch the three commands
  separately (`ed.commands.splitBlock()`, `ed.commands.setImage(...)`,
  `ed.commands.splitBlock()`), each against a fresh state. Also enforces the
  layout rule that images always land on their own line. Regression: E2E
  "shared page renders embedded images" + manual-verify "image paragraph has no
  text next to it".
- **FIXED (2026-08-04) --- Comment hover popup stuck on loading ("..."):**
  `CommentHoverPopup.tsx` listed `state.threadId` in its useEffect deps,
  aborting the in-flight fetch on every re-render (initial `null -> id`
  transition). FIX: ref-based guard that fetches once per mount, omitting
  `state.threadId` from deps. Verified by manual-verify hover-popup checks.
- **Attachment icon `data-kind`:** `attachmentExtension.tsx` renders
  `<span data-kind="pdf" ...>`, giving browser tests a stable selector.
- **Task #13 DONE --- Block drag-and-drop paragraph reordering.** Added
  `@tiptap/extension-dropcursor` to `editingExtensions.ts` (2px blue
  `#3b82f6` indicator). The vendored drag-handle already dispatches
  `NodeSelection` on dragstart and serializes the slice to `dataTransfer`;
  the dropcursor extension adds the visual ghost line at the target position.
  Verified by a new vitest ("includes the Dropcursor extension configured with
  blue color") + all editor loads pass without errors.
- **Manual harness:** `e2e/manual-verify.mjs` (26 UI checks) +
  `e2e/start-dev-server.sh` (records dev env vars, no `.env` file). BASE is
  `http://127.0.0.1:5173` (dev server env also uses 127.0.0.1) — do NOT
  hardcode a stale LAN IP.

## Search feature (2026-08-04, Phase 1 v15)

Task #14 DONE — wiki-wide search on the existing SQLite FTS5 engine (no external
engine). `buildFtsQuery()` in `search.service.ts`:

- Quoted `"phrases"` → verbatim phrase (adjacency required).
- Each bare word → `(word OR word*)`: the unquoted alternative is porter-stemmed
  ("crampons"→"crampon"), the `word*` alternative matches partials
  ("net"→"networking"). Words are AND'd.
- Bare-word special chars `" * ^ ( ) :` are stripped; boolean keywords
  (`and/or/not/near`) are quoted so arbitrary input can never break MATCH syntax.

`searchSpaces()` does escaped `LIKE %q%` over space names, returning
`{ id, name, pageCount }` (live non-system pages only), exact-name-first then
shortest name. `/api/search` returns `{ results, spaces, count }` — `results` is
unchanged/backward compatible, each page result now has `spaceName`.
`CommandPalette.tsx` groups Spaces above Pages, shows `/Space/page` breadcrumbs,
a result-count line, and navigates via `useNavigate` (`/pages/:branchId`); space
results load the space tree and open its first page. The old
`window.location.hash = '#/wiki/...'` navigation was broken under BrowserRouter
and was replaced.

Verified: 4 search integration tests + 7 `buildFtsQuery` unit tests added; 176
vitest, 11 E2E, 26/26 manual checks, typecheck, prod build all green.

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
