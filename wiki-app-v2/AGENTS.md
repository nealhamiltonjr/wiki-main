# wiki-app-v2 ‚Äî agent notes

## Commands (run from repo root)

- `npm run typecheck` ‚Äî `tsc --noEmit` (strict; unused vars fail the build)
- `npm run test` ‚Äî vitest, **sequential** (`fileParallelism: false` ‚Äî integration
  tests share the `data/` dir and a single lazy SQLite connection per worker)
- `npm run e2e` ‚Äî Playwright (8 specs, 19 cases)
- `npm run build` ‚Äî typecheck + vite build (SSR via `vite dev`; server entry is
  `src/server/index.ts`)

## Architecture

- React 19 + TanStack Router client; Fastify server (`src/server/app.ts`).
- **Single SQLite connection** (`src/server/db/index.ts`), lazily created on the
  first `getDb()` call; `DB_PATH` env selects the file. Set `process.env.DB_PATH`
  **before any import of `getDb`/services** or the singleton locks onto the
  default path. Migrations run automatically on first connect (`drizzle/`).
- Git content repo lives at `./data/repo` (`GIT_REPO_ROOT`); `initGitRepo()`
  must run before any commit (worker loop starts in `src/server/index.ts`).
- Slice-10 flush pipeline: save/rename/snapshot ‚Üí `enqueueJob("git_commit")` ‚Üí
  `processPendingJobs()` (polled by `startWorkerLoop`) ‚Üí `commitPageChange` /
  `commitManualSnapshot` writes `<spaceSlug>/<pageSlug>.md` + frontmatter and
  commits. History/restore read the same repo via `git log --grep page:<id>:`.

## Slice-10 invariants (verified ‚Äî do not regress)

- **Slug is a git file path.** Both create and rename validate
  `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$` (no `/`, `..`, no leading `-`/`.`).
  `commitPageChange` also falls back to `"space"` when a space name slugifies
  to empty. A traversal slug used to write a file **outside the repo** (CWE-22).
- **Rename must enqueue a commit** ‚Äî `renamePage` only writes the DB; without
  the explicit `enqueueJob` after it, the git tree keeps the old `<slug>.md`.
- **Restore is forward-moving**: it reads a commit's markdown, converts back to
  Tiptap, `ensureBlockIds`, then `savePageOCC` (new version + new commit). It
  never rewrites history. `commitHash` is validated `/^[0-9a-f]{6,40}$/i` so
  it can't be passed to git as an option.
- **Invalid content is never flushed**: unknown node types ‚Üí 422 before any
  enqueue (auto-repairable errors are logged and saved repaired).
- **Commit queue**: single-threaded worker, 10 jobs/pass, exponential backoff
  (`min(2^attempts*1000, 60000)`), max 5 attempts ‚Üí `failed`. `processPendingJobs`
  return value counts **successes only** (0 for a failing job). Startup calls
  `reclaimStaleJobs()`: jobs stranded in `running` by a crash are flipped back
  to `pending` and retried (commits are idempotent, so a re-run is safe).
- **No-op commits must be skipped, not fail**: `git commit` exits 1 on
  "nothing to commit". `commitPageChange`/`commitManualSnapshot` check
  `git diff --cached --name-only` for their paths first and return without a
  commit when nothing is staged. Reachable via no-op title-only saves (that
  path doesn't bump `updatedAt`, so the exported file can be byte-identical)
  and same-millisecond saves. Also what makes crash recovery safe.
- **Rename must remove the old file**: the rename route passes `oldSlug` in
  the job payload and `commitPageChange` `git rm`s the previous
  `<spaceSlug>/<oldSlug>.md` (space slugs never change). Without this the
  tree keeps a stale copy of the page under its old name.
- **Markdown fences must outrun content**: a code block whose content contains
  a line of ``` (or longer backtick run) is exported with a **longer** fence
  (`codeFence`); inline code uses one more backtick than the longest run. The
  importer matches fences by run length and inline code by same-length run.
  Without this, restore-from-git silently corrupts such code blocks.

## Editor notes

- `useAutosave` delegates to `AutosaveController` (`autosaveController.ts`).
  The controller **re-flushes a pending edit** after an in-flight save resolves
  instead of clearing it ‚Äî the previous unconditional clear dropped keystrokes
  typed during a save. Debounce ~800ms; `saveNow` flushes immediately.
- Read mode renders `mention` nodes via `InlineRenderer` in `ReadOnlyContent`
  (`src/features/editor/ReadOnlyContent.tsx`); they used to be dropped.
- Vitest config uses `import.meta.dirname` (not `__dirname`).

## Testing patterns

- Integration tests that touch DB/git set a unique `data/test-<name>-<rand>.db`
  and `initGitRepo()`/`buildApp()` in `beforeAll`; they must not run in parallel.
- `git-flush.integration.test.ts` drains the queue with `processPendingJobs()`
  (exported for tests) and inspects the repo with `execSync("git ...", { cwd: REPO_PATH })`.
- Queue behavior is covered in `queue.integration.test.ts` (retry/backoff/batch/
  reclaim); markdown round-trip in `markdown-roundtrip.test.ts`.

## Slice-12 / plugin engine

- Plugin zips live in `data/plugins/<id>/` (`PLUGIN_ROOT`); install extracts to a
  `.tmp-*` dir, validates the manifest (id/name/version/capabilities/contentModel),
  then `rename()`s it into place. `rename` can throw EXDEV across devices ‚Üí the
  fallback is `cp -r` + `rm -r`. Never `rm(tmpDir, { force: true })` without
  `recursive: true` ‚Äî EISDIR, and it made every upload 500.
- The DB row is reserved BEFORE the file extract (`plugins.id` UNIQUE
  constraint is the race gate for two concurrent installs of the same id).
  If the extract fails partway through (cross-device + cp also fails), the
  existing on-disk install is renamed to `<dest>-stash-<uuid>` first so the
  rename failure can restore from stash instead of leaving a DB row with no
  files. Tested in `src/server/__tests__/plugin.integration.test.ts`.
- No version-upgrade path. The install is keyed on `id` only. A new version
  of an installed plugin must be uninstalled first (the 409 is the absence
  of an "upgrade" endpoint, not a bug). Keep this in mind when shipping
  plugin version bumps.
- The manifest's `contentModel.nodes` is the source of truth the server uses
  (`getEnabledPluginNodeTypes()`) for `validateContent`; a plugin that registers a
  Tiptap node MUST declare it in the manifest or saves of that node get rejected.
- Client registry (`src/plugins/registry.ts`) is a module singleton; `loadPlugins()`
  in `_authenticated.tsx` gates the whole authenticated layout on a
  `useSyncExternalStore` snapshot. `SlashMenu` is a rewritten state machine
  (keyboard nav + Enter/Escape), not a CSS-hover popover.
- E2E plugin fixture: `test-fixtures/hello-world-plugin/` (dir) + `.zip`. Rebuild the
  zip with `python3 -m zipfile`-style after editing the dir (paths must be
  `plugin.json`, `client/index.js`, `server/index.js` at zip root).

## Slice-13 / first-party plugins

- First-party reference plugins: `test-fixtures/web-clipper-plugin/` (serverRoute
  `POST /api/web-clipper/fetch` + slash command inserting a `webCitation` node) and
  `test-fixtures/drawio-embed-plugin/` (embedTypes: custom node + `renderReadOnly`).
  Both are seeded INSTALLED+ENABLED by `scripts/seed-e2e.ts`.
- **Fastify can't register routes after `ready()`** (`AVV_ERR_ROOT_PLG_BOOTED`).
  `registerAllPluginServerRoutes` therefore registers every installed plugin's
  routes at BOOT with an onRequest `enabled` guard; there is no mid-run
  registration. A plugin installed at runtime gets its routes on the NEXT server
  restart. Server plugins must use the Fastify callback signature
  `(fastify, opts, done)` ‚Äî never mix `async` plugin functions with `done`.
- Plugin routes are served at `/api/plugins/<id>/...` (serverRoutes) and client
  bundles at `/plugins/<id>/client/index.js` (validated id, JS content-type,
  `Cache-Control: max-age=300`). Vite proxies `/plugins` ‚Üí Fastify in dev.
- **Slash-menu query/range bug (fixed):** the menu captured `range.from` when "/"
  was typed, but when an ATOM node sits at the insertion point (e.g. a draw.io
  embed at doc position 0) ProseMirror inserts the "/" AFTER the atom, so the
  query included the leading "/" (filter matched nothing) and execute() would
  mis-delete. `computeSlashQuery` now derives query + range from the caret's text
  block on every doc change (line-start / after-whitespace ‚áí block text is
  `<slash><query>`). Unit-tested in `slashMenu.test.ts`.
- E2E: `e2e/firstparty.spec.ts` (web clipper + draw.io embed, both on the seeded
  "cli" page) + `e2e/plugins.spec.ts` (hello-world admin upload/enable/slash).
  `playwright.config.ts` launches Chromium with `--allow-net` for the web
  clipper's localhost fetch. Assertions use `.first()` so repeat runs (which
  accumulate content on the shared cli page) don't trip strict-mode.

## E2E infrastructure traps (learned passing the slice-12 gate)

- **Stale dev servers defeat the reseed.** `playwright.config.ts` uses
  `reuseExistingServer: !CI`; a leftover `vite`/`tsx src/server/index.ts` from a
  previous session is reused without the DB wipe + seed (and without the e2e
  env vars). Kill them before running e2e.
- **better-auth rate-limits ALL auth paths, not just sign-in.** The default global
  bucket (20/60s) applies to `/get-session`, `/sign-out`, etc. Page loads across the
  suite burn it and logins start 429ing mid-suite (looks like "stuck on login page").
  The e2e webServer sets `BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES` (sign-in/sign-up) AND
  `BETTER_AUTH_RATE_LIMIT_WINDOW=3600 BETTER_AUTH_RATE_LIMIT_MAX=10000`.
- **Do not assert on transient reload states.** The plugin admin page shows
  "Installed! Reloading‚Ä¶" and calls `window.location.reload()` immediately; the text
  often never renders. Wait for the post-reload table instead.
- **`/` only opens the slash menu at line start / after whitespace.** After earlier
  specs have typed into a page, clicking the editor center lands mid-text; press
  `Control+Home` first (or use a page no other spec edits).
- **Parallel workers share the welcome page's collab doc.** `editor.spec` /
  `slice9.spec` edit "welcome" concurrently, and their collab round-trips re-render
  the editor mid-interaction (eats keystrokes/Enter). Any spec that needs a quiet
  editor should use the seeded "notes" page.

## Slice-15 / theming architecture (¬ß5)

- **Single token source: `src/styles/tokens.css`.** Every color, radius, font,
  shadow, and animation value the app renders is defined here under `:root`
  (light defaults), `[data-theme="dark"]`, and `[data-theme="contrast"]`. No
  other file holds a literal color (`#‚Ä¶`, `rgb(‚Ä¶)`, `hsl(‚Ä¶)`) or a Tailwind
  named-color utility (`text-rose-600`, `bg-emerald-500/10`, etc.). The
  `:root` block owns non-color tokens (typography, radii, shadows, timing,
  borders widths, chrome dimensions) ‚Äî themes override colors only.
- **The `@theme inline { ‚Ä¶ }` block lives at the bottom of `tokens.css`.**
  It aliases every canonical token into Tailwind's utility namespace
  (`--color-primary: var(--primary)`, `--shadow-lg: var(--shadow-lg)` ‚Ä¶),
  so `bg-primary`, `text-danger`, `border-surface`, `shadow-md` etc.
  resolve directly to the canonical var. `app.css` only contains
  `@layer base` rules (shadcn var remapping, prose) ‚Äî no `@theme`.
- **Token budget:** ~70 colors (light/dark/contrast), 10-radius scale,
  3 font stacks, 4 shadow levels, 3 timing tokens (`--duration-fast` /
  `--duration-normal` / `--duration-slow`) + `--ease-default`,
  chrome dimensions (`--topbar-height`, `--sidebar-width`,
  `--settings-nav-width`, `--prose-width`).
- **Caret colors (`--user-color-0` ‚Ä¶ `--user-color-9`) are defined per
  theme** because they're identity colors ‚Äî kept stable across themes on
  purpose. JS reads them at runtime via `getComputedStyle(documentElement)`
  in `useCollab.userColor()`; the palette array was deleted from the file,
  no literal colors in JS.
- **Component-code sweep:** `useCollab.ts`, `Editor.tsx`,
  `FavoriteButton.tsx`, `CommentsPanel.tsx`, `extensions/MermaidRenderer.tsx`,
  `routes/_authenticated/settings/plugins.tsx` were migrated off named-color
  utilities onto the new `success` / `warning` / `danger` / `info` /
  `text-muted` tokens.
- **Enforcement test:** `src/styles/__tests__/theme.test.ts` has three
  checks ‚Äî (1) no literal colors outside `tokens.css`/`app.css`, (2) every
  `var(--‚Ä¶)` reference resolves to a definition, (3) light/dark/contrast
  define the same color-role set. Run as part of `npm test`; adds 3 tests
  to the suite (211 total).

## Slice-16 / users ¬∑ groups ¬∑ admin UX polish (¬ß7.1)

- **Themed `ConfirmDialog` component (`src/components/ui/confirm-dialog.tsx`).**
  Replaces native `confirm()` everywhere users/groups perform destructive
  actions (group delete, member remove, suspend, demote). Built on the native
  `<dialog>` element so it gets platform modal semantics for free ‚Äî
  `::backdrop`, focus trap, Esc-to-close, inert-when-closed ‚Äî without adding a
  Radix dialog dependency. Renders into a portal at `document.body`. Cancel
  button is focused on open so keyboard users get a safe default; both
  actions are disabled while `pending` to prevent double-clicks. Stops
  clicks-on-backdrop from closing only when the click is inside the box
  (uses bounding-rect discrimination).
- **`Button` now forwards refs.** The change to `forwardRef` in
  `button.tsx` is required so `ConfirmDialog` can focus its cancel button
  via `cancelRef.current?.focus()`. No behaviour change for existing
  callers.
- **Users page (`/settings/users`)** ‚Äî slice-16 polish:
  - **Search by name / email / role.** Filter input + "N of M" hint.
  - **Summary tiles:** Total / Admins / Suspended counts above the table.
  - **Last-admin guard.** Disabling the "Remove admin" button on the only
    remaining (non-suspended) admin. The server enforces self-demotion and
    self-suspension already (slice-14); this prevents the only-admin
    lockout via a different path. Tooltip explains why the button is off.
  - **Error banner with retry.** Network/403 errors render in a styled
    alert with a Retry button ‚Äî the previous "Failed to load users"
    string gave no recovery affordance.
  - **Unverified-email marker.** Small `warning`-colored hint on the
    email cell (this is the only use of `text-warning` outside tokens.css).
- **Groups page (`/settings/groups`)** ‚Äî slice-16 polish:
  - **Capability editing UI.** The closed catalogue at the top of the
    file (`CAPABILITY_CATALOG`) matches `CAPABILITY_ROUTE_MAP` in
    `access.ts` plus `create_permanent_links` (the brief ¬ß3.10 "no
    expiration grant group" capability, currently hardcoded to the
    `link-managers` group in `token.service.ts`). Admins can toggle any
    cap, see its description, and save via `PATCH /api/groups/:id`.
    "via wildcard" badge appears on rows already covered by `admin.*`.
  - **Group delete confirms the impact** ("N membership(s) and every
    permission grant issued through the group are removed") instead of
    the old one-liner.
  - **Capability summary tile** (distinct-capabilities count) so an
    admin can see how the system is shaped at a glance.
  - **Error banner with retry.** Same shape as the Users page.
- **Settings layout:** removed the redundant `Settings` H1 ‚Äî each
  sub-page owns its own H2 ("Users", "Groups & Permissions", etc.) so
  the layout no longer duplicates it. The left-nav active state remains
  the orientation anchor.
- **New test:** `settings.integration.test.ts` "updates a group's
  capabilities via PATCH and rejects non-admins" ‚Äî covers persistence
  (capabilities survive GET), wildcard overwrite, rename-independence,
  and the admin-only guard. Suite is now 24 files / 212 tests (was 211).

## Slice-17 ‚Äî full regression pass + ¬ß9.4 manual checklist coverage

This slice did not add user-visible surface area. It ran every existing test
suite, fixed one true regression, and pinned down one ¬ß9.4 item that had
been satisfied only in unit terms and was actually unwired in production.

### What changed

- **E2E fix (`e2e/plugins.spec.ts`)** ‚Äî slice-16 removed the redundant
  `Settings` H1 from the settings layout (each sub-page owns its own H2).
  Three "heading" sentinels in the plugins spec were incidentally
  re-asserting on that removed H1 and would have failed for any future
  settings-layout change too. Replaced with `"Installed Plugins"` (the
  plugins page's own H2), with a comment explaining why.
- **`InMemoryRateLimiter` is no longer dead code.** Slice-3 wrote the
  class (`src/server/lib/rate-limit.ts`) with a doc comment promising "the
  public share-link password-check endpoint gets its own limiter on top of
  better-auth's", and the unit tests pass ‚Äî but no route actually imported
  it until slice-17. Wired into the share-link branch-auth path in
  `src/server/middleware/access.ts` (`SHARE_LINK_PASSWORD_LIMITER`,
  10 attempts per 5-minute window, keyed on `request.ip`, with a `sweep()`
  interval scheduled via `onReady` and `unref()`'d so it never holds the
  process open). 11th attempt returns 429 with `"Too many attempts. Try
  again later."` and even the correct password does not bypass the limit
  once it has fired (proves the limit is on attempts reaching this code
  path, not on wrong guesses specifically).
- **New test:** `src/server/__tests__/share-link-rate-limit.integration.test.ts`
  with two cases:
  1. *Wrong-password attempts trip 429* ‚Äî uploads a file, creates a
     password-protected branch share link, hits the file route with a
     bad password 10 times (each from a distinct spoofed
     `x-forwarded-for` so the per-IP keying is clearly the bucket), then
     asserts 11th = 429 and 12th (correct password, fresh IP) = 429 too.
  2. *Passwordless share links are NOT rate-limited* ‚Äî same setup
     without a password, 20 anonymous hits all return 200.
  Suite is now 25 files / 214 tests.

### What did NOT change (and what was verified)

- **Vitest** stable across two consecutive runs before and after this
  slice (24/212 then 25/214). No flakes observed.
- **Playwright e2e** stable across three consecutive single runs
  (12/12 / ~23s each). Repeat-each=2 reveals two pre-existing flakes
  inherent to spec design (plugin upload is non-idempotent ‚Äî `installPluginFromZip`
  returns 409 on the second upload; `notifications` marks all unread
  on the first pass so the seed's "1 unread" badge is missing on the
  second) ‚Äî not regressions, and the brief's gate pattern (single-pass,
  parallel, fresh DB) is unaffected.
- **Build** clean (pre-existing chunk-size warning on cytoscape + the
  Tiptap bundle only).

### ¬ß9.4 walk-through ‚Äî coverage map

| # | Item | Where covered |
|---|------|---------------|
| 1 | Log in ‚Üí space ‚Üí 3-level nested page ‚Üí reload ‚Üí content persists | Manual smoke (login flow is covered by every e2e spec; nested createPage in `branch-mutations.integration.test.ts`; persistence in `editor.spec.ts` "typing content survives page reload") |
| 2 | Right-click tree node ‚Üí every action works | Manual smoke (no automated ctx-menu spec exists yet) |
| 3 | Drag a block (¬ß6) ‚Äî moves, no stray selection, typing works | Not applicable ‚Äî ¬ß6 block-drag is a future slice |
| 4 | Upload image ‚Üí inline. Upload non-image ‚Üí download, not execute | `files.integration.test.ts` "uploads an image and serves it inline (allowlisted) with nosniff", "forces text/html to download", "SVG downloads not inline" |
| 5 | HTML-looking text in page ‚Üí search result renders safely | `search.integration.test.ts` `SNIPPET-XSS` √ó 2 |
| 6 | Install plugin via UI ‚Üí enabled ‚Üí effect visible | `e2e/plugins.spec.ts` √ó 2 (upload + enable, slash-command end-to-end) |
| 7 | Change one theming token ‚Üí whole app updates | Manual smoke; `useTheme` is unit-trivial; the token layer is documented in PROJECT-OVERVIEW/AGENTS slice-15 notes |
| 8 | Same page in 2 windows with single-placement collab ‚Üí both see edits live | Manual smoke (no two-browser-window e2e; single-placement rule is asserted in `collab.integration.test.ts` but not the live edit round-trip) |
| 9 | Clone page into 2nd space ‚Üí both placements independently permission-scoped | `branch-mutations.integration.test.ts` "rejects a clone when caller has no editor access on destination" (cross-space isolation) + "clones a page ... sharing the same content" (content sharing) ‚Äî between them these prove the matrix; an explicit "viewer in destination sees only what they should" spec would tighten further |
| 10 | Password-protected share link ‚Äî works with pw / fails without / rate-limited | `share-link-rate-limit.integration.test.ts` √ó 2 (just added). The acceptance test for "works with password" lives implicitly in the unauthenticated round-trip case in `collab.integration.test.ts` |

Items 1, 2, 7, 8 remain manual smoke. Item 3 is not yet applicable.

## Slice-18 — first-boot bootstrap (§11.6 + admin chicken-and-egg)

### Why this slice exists

The brief's §11.1 said "migrate the real production data — don't just port
the schema." After slice-17 we learned the prior DB held only test data, so
the user direction is **don't migrate, just ship with an empty data/ and
make a fresh install walkable**. That trade-off is only acceptable if the
very first person to hit a fresh deploy can:

1. Sign up (no admin yet to gate sign-up).
2. Be made admin automatically (no CLI workaround, no chicken-and-egg
   with `PATCH /api/users/:id` which requires an existing admin).
3. Land in a working wiki with the §11.6 fixture (a Welcome space, a
   handful of pages) instead of an empty tree.

All three now happen via `databaseHooks.user.create.{before,after}` wired
into better-auth in `src/server/auth/config.ts`.

### What changed

- **`src/server/services/bootstrap.service.ts` (new).** `isFirstUser()`
  does `SELECT COUNT(*) FROM user`; `seedWelcomeSpace(ownerId)` materializes
  the §11.6 fixture (space "Welcome" + pages: welcome / notes /
  getting-started / cli-reference + branch tree). Idempotent: if any space
  exists, returns null without touching the DB. The seed intentionally does
  **not** install first-party plugins (those are admin-uploaded, not
  auto-installed) and does **not** create a test user (better-auth just did).
- **`src/server/auth/config.ts`** — added `databaseHooks.user.create.before`
  that returns `{ data: { ...user, isAdmin: true } }` iff `isFirstUser()`.
  `additionalFields.isAdmin` is `input:false`, so the only path to set
  `isAdmin=true` at sign-up is this server-side hook. The `.after` hook
  runs `seedWelcomeSpace(user.id)` inside try/catch — a sign-up response
  must not be 5xx'd because of a seed hiccup.
- **`src/server/__tests__/bootstrap.integration.test.ts` (new).** Three
  tests: first sign-up is admin + Welcome seeded; second sign-up is NOT
  admin + Welcome not duplicated; client-supplied `isAdmin: true` is
  stripped (belt-and-suspenders against input:false bypass attempts).
- **`src/server/__tests__/auth.integration.test.ts`** — updated the
  existing first-sign-up assertion from `isAdmin === false` to `isAdmin
  === true` (the test now exercises the bootstrap path; the bootstrap
  test file owns the "second user is not admin" assertion).

### Design notes

- **Race window on first sign-up.** `isFirstUser()` reads count, then
  better-auth inserts. Two concurrent sign-ups at count=0 could both see
  zero and both become admin. Acceptable for a self-hosted wiki; brief
  explicitly calls it fine. The space seed is fully idempotent (returns
  null if any space exists), so the race can never produce two Welcome
  spaces.
- **Welcome is personal, not shared.** The seed gives the first admin
  membership in Welcome (admin role) and sets `defaultRole: "editor"` so
  collaborators can join. Subsequent users do NOT auto-join Welcome —
  they get their own space via `/spaces` when they want one.
- **§11.1 is now off the "must-do" list** per user direction. The repo
  ships with an empty `data/` directory; first boot materializes a
  walkable state via these hooks. Any future "import from old app"
  need is a separate concern, not a launch blocker.

## Slice-19 — in-page table of contents (§12.6)

### Why this slice exists

A TOC was already partially built (inline in
`src/routes/_authenticated/w/$branchId.tsx` as `PageTOC`) but with three
gaps that made it feel unfinished:

1. **No smooth-scroll** — plain `<a href="#id">` jumped instantly.
2. **No scroll-spy** — the active heading wasn't highlighted as the
   user scrolled, defeating the main UX purpose of a TOC.
3. **No depth-aware indentation** — h3/h4/h5 all rendered at the same
   indent, flattening the hierarchy.
4. **Lived inline in the 400-line route file** — unexported, untested,
   impossible to reuse for other read views (share-link render,
   printable export).

### What changed

- **Extracted to `src/features/editor/TableOfContents.tsx`** with:
  - `extractTocEntries(content)` — pure helper, top-level heading nodes
    only (nested headings inside lists are intentionally out of scope).
  - `findScrollableAncestor(el)` — walks up from a heading to discover
    the nearest `overflow:auto|scroll` ancestor. The page view (§6.3)
    mounts ReadOnlyContent inside a scrollable flex child, so the
    default `window.scrollTo` is a no-op there. The TOC now scrolls
    the right container (or falls back to window if no scrollable
    ancestor exists).
  - Smooth-scroll click handler with a 64px chrome offset, URL hash
    updated via `history.replaceState` (no history pollution).
  - Scroll-spy via `IntersectionObserver` scoped to the same scroll
    root (with `rootMargin: "-15% 0% -70% 0%"` — biases the trigger
    zone toward the upper third of the visible area, matching the
    Notion/Confluence/GitBook convention).
  - Depth-aware padding: h1 emphasized, h3 → pl-3, h4 → pl-6, h5+ →
    pl-9. Renders nothing when fewer than `minEntries` (default 2)
    headings exist.

- **Route file** — inline `PageTOC` / `extractTocEntries` / `extractText`
  / `TocEntry` deleted; now imports `TableOfContents` from the new
  module.

- **`scripts/seed-e2e.ts`** — `makePage` now accepts an optional
  `content` parameter. "Getting Started" is seeded with a real
  multi-section body (Overview / Installation / Daily usage / Tips)
  + padding paragraphs so the §12.6 TOC has something to render in e2e
  and the viewport is forced to overflow on small viewports.

- **Tests** — `src/features/editor/__tests__/TableOfContents.test.tsx`
  with 13 cases covering `extractTocEntries` (null / non-doc / empty /
  preserved order / missing level default / id-less skipped / nested
  ignored / multi-text-run concatenation) and `TableOfContents` (renders
  nothing when < 2 headings / renders anchor list / depth-aware
  padding / custom minEntries / default aria-current). New
  `e2e/slice19.spec.ts` with 2 browser cases: TOC renders on the seeded
  Getting Started page with 4 anchored links + click-scrolls + updates
  the URL hash + highlights the active entry; TOC is hidden on the
  paragraph-only "Notes" page.

### Design notes

- **Scroll root matters.** The TOC's first attempt called
  `window.scrollTo`, which the browser ignored because the content
  lives in an `overflow-auto` flex child. The `findScrollableAncestor`
  helper makes the TOC correct in the current page view AND in any
  future read view that mounts at the document root.
- **IntersectionObserver root.** Same reason: `root: undefined`
  observes the viewport, not the inner scroll container. Setting
  `root: scrollRoot ?? undefined` aligns the scroll-spy with the
  click-scroll behaviour.
- **No nested headings.** A heading inside a list item doesn't appear
  in the TOC — the TOC is the page's section outline, not every
  heading in the prose. This matches what Notion / GitBook do and keeps
  the right rail from being a soup of identical-looking items on long
  reference pages.

## Known limitations (accepted, not blocking)

- **Deleted pages leave a stale file in the git tree.** `deletePageEverywhere`
  soft-deletes the page and removes its branches but never enqueues a commit to
  `git rm` `<spaceSlug>/<pageSlug>.md`, and `_snapshots/<pageId>.md` stays too.
  Harmless today (history/restore 404 for deleted pages; a later page reusing
  the slug overwrites the file), but the repo accumulates dead files after
  deletes. Fixing it needs a git-rm job kind or an inline rm in the delete route.
- **Mention notifications duplicate on every save.** `processMentions` fires
  on each save containing an `@mention`; the same mention creates a fresh
  notification each time (no dedup by (pageId, userId, seen)). UI nuisance, not
  a data-integrity issue. Out of slice-10 scope.

## Slice-20 — per-space trash UI (§12.1)

### Why this slice exists

Server-side §12.1 (soft delete via `deletedAt`, the three trash routes,
`listTrash` / `restorePage` / `purgePage` on `page.service`) shipped with
slice-9. The UI half — a `/trash/:spaceId` page users can reach from the
sidebar — was missing; without it, restore/purge are unreachable from the
app and the only way to undelete a page is a SQL console.

### What landed

- **`src/features/trash/TrashPanel.tsx`** — loads via
  `useQuery(api.listTrash(spaceId))`; branches into loading / error / empty /
  list. Each row shows slug, title, and a `relativeTime` formatter
  (just-now / m / h / d / mo buckets) for the `deletedAt` timestamp. Restore
  fires `api.restorePage(spaceId, pageId)` then optimistically reloads; Purge
  opens `ConfirmDialog` then calls `api.purgePage`.
- **`src/routes/_authenticated/trash/$spaceId.tsx`** — thin route that
  reads `spaceId` and renders `<TrashPanel>`. The space is intentionally
  per-URL (matching the brief's "trash is per-space" model) so the sidebar
  link from each space scopes you to that space's trash.
- **`src/features/tree/Tree.tsx`** — sidebar footer now ships a `<Link>` to
  `/trash/{activeSpace}` with `data-testid="trash-sidebar-link"` (so e2e
  can target it). Lucide's `Trash2` icon makes the affordance recognisable.
- **`e2e/tree.spec.ts`** — the post-login "no Trash node leaks into the
  tree" assertion was scoped to `role="tree", name="Pages tree"` so it
  still passes once the sidebar footer gained its Trash link.
- **`e2e/slice20.spec.ts`** — 5 cases: sidebar link reaches the view,
  full restore lifecycle (delete via API → list → restore → row gone from
  the list AND the API), full purge lifecycle (confirm dialog → row gone
  → reload still empty), cancel-purge keeps the row, and a smoke that
  the panel mounts.
- **`src/features/trash/__tests__/TrashPanel.test.tsx`** — 7 unit cases
  that lock the `relativeTime` buckets (just now / 1m / 30m / 59m / 1h /
  23h / 1d / 29d / 1mo / 12mo + unparseable → "") and a render smoke
  that the panel mounts with its testid.

### Decisions worth remembering

- **`TrashEntry` is reused from `@/api/client`** — no parallel view type.
  Keeps the panel honest if the server adds/removes a field later (TS
  forces the update).
- **`relativeTime` takes an optional `now`** — deterministic so the
  unit test can pin its bucket boundaries without freezing `Date.now`.
- **No delete-from-tree UI yet.** Tree-context delete is a separate UI
  concern (backlog). The e2e drives deletes via `page.request.delete()`
  — the same endpoint the future UI will call.
- **`data-testid="trash-panel"` on every branch** — including loading,
  so e2e can mount-and-wait with one selector.
- **Tests stay SSR-friendly.** Following the existing pattern in
  `TableOfContents.test.tsx`, the trash unit test uses
  `renderToStaticMarkup` for a deterministic sync render; the e2e
  drives the full async lifecycle. No `@testing-library/react` added.

### Follow-ups left for later

- A real Delete-page affordance from the tree (right-click / row menu) so
  users don't need a trick to send pages to trash.
- Trash retention indicator (e.g., "purged after N days") as a slideover.
- Bulk-select on the trash list for batch restore or batch purge.

## Slice-21 — page-redirect on rename (§12.2)

### Why this slice exists

Brief §12.2 says: "Whatever currently links to its old slug or path —
internal wikilinks, and especially share links you may have already sent
to someone — should keep resolving rather than 404ing." Slice-6 shipped
rename/move but never recorded redirects, so this was a strict regression
of the brief, not a new feature. Because no surface area currently
navigates by slug (every route is `/api/branches/:branchId/...` or
`/api/pages/:pageId/...`), the immediate user-facing blast radius is
zero — but the data layer wasn't ready the first time the wiki grows
a slug-typed URL or a wikilink node, and the brief was explicit that
this should ship with rename, not after.

### What landed

- **Schema** — `page_redirects (spaceId, oldSlug, pageId, createdAt)` with
  composite PK `(spaceId, oldSlug)`. Per-space rather than global: the
  page's `slug` is shared across every placement, so a single rename
  affects every space, but the redirect has to be discovered by the
  caller's `(spaceId, slug)` lookup, which is per-space. Foreign keys
  cascade on delete for both `pages` and `spaces`. Migration:
  `drizzle/0004_nostalgic_champions.sql`.
- **`renamePage` (service)** — looks up the live slug, writes one
  redirect row per placement (spaceId) using `onConflictDoUpdate` so
  re-renaming back to a slug the page itself previously used just
  updates the existing row's target to the same pageId (no stale alias).
  No-op renames (same slug) skip the write entirely. The git queue
  already receives `oldSlug` in the rename route's payload, so the
  truncating-rename delete-old-file path is unaffected.
- **`resolveSlug(spaceId, slug)` (service)** — live first, then redirect.
  Live candidate must be in this space, non-system, non-trashed. Redirect
  candidate must (a) still point at a live page, (b) the page must still
  have a non-system branch in this space (post-rename removal of the
  page from this space dangles the alias — returns 404 instead of
  surfacing a page the caller can't open here).
- **`listRedirectsForPage(pageId)` (service)** — for the maintenance
  view. Filters out rows where `oldSlug` equals the page's current slug
  (the page was renamed back to its own previous alias; the row is
  preserved for audit but isn't a useful redirect anymore).
- **Route** — `GET /api/spaces/:spaceId/resolve-slug?slug=...` (in
  `space.routes.ts`). Uses `access: "authenticated"` rather than
  `spaceParam: "spaceId"` deliberately: the access middleware's
  space-scoped routes return 403 to non-members, but the brief's
  requirement is to make a redirect unproxiable as "page exists here,
  just not for you" — so we re-walk the chain via `resolveSpaceRole`
  + `resolveAccess` and return 404 on no access. The inline check
  matches the live page's read-path semantics.
- **Tests** — `src/server/__tests__/redirects.integration.test.ts` (11
  cases): rename writes per-space rows, live slug wins over a redirect
  to the same page, old slug resolves in both spaces, non-member gets
  404 on a redirect target, non-member gets 404 on the live slug too,
  re-rename forward updates the alias target, re-rename back to a slug
  with an existing alias overwrites it to the live page, unknown slug
  404s, `listRedirectsForPage` returns only active aliases.

### Design notes

- **Per-space, not global.** A redirect is the answer to "what page
  does this slug point at *in this space*?". Two spaces that both
  had a page named `todo` earlier and were renamed to different slugs
  don't cross-resolve. The composite PK costs a `spaceId` column but
  buys a tight, scope-correct answer.
- **404, not 403, on no access.** A space-scoped route the access
  middleware normally returns 403 for "non-member of this space", but
  for the redirect resolver 404 is the correct signal. The brief's
  §12.2 wording is explicit: "through the same permission check as
  the live page, so a redirect can't be used to bypass access control."
  The live page's read route returns 404 when access fails, so the
  redirect does too.
- **`onConflictDoUpdate` rather than `INSERT OR IGNORE`.** A rename
  that targets a slug the page itself previously used (e.g., `todo`
  → `tasks` → `todo`) would otherwise stack up redundant rows. The
  update path consolidates them without losing history.
- **No wikilink node yet.** The redirect resolver is built but unused
  by the editor. When a future slice adds a Tiptap `wikilink` node,
  it'll dispatch through `resolveSlug` to canonicalize the target.
- **Trash + reinstated pages.** Trash soft-deletes on the page (sets
  `deletedAt`); the resolver filters out `deletedAt !== null` on the
  redirect target too. A page restored from trash at its old slug
  re-resolves as live; the redirect row is unaffected but never
  matched.

### Follow-ups left for later

- A Tiptap `wikilink` node that uses this resolver when a user
  clicks a `[[slug]]` reference in the editor.
- A `/s/<spaceSlug>/<pageSlug>` route the share-link endpoint can
  redirect to the resolved branchId — so URLs you paste into chat
  before renaming still work.
- Visual indicator in the editor when an open page was hit through a
  redirect (e.g., toast "Opened via alias `todo` — current slug is
  `tasks`").

## Slice-22 — maintenance report for orphaned pages + broken redirects (§12.7)

### Why this slice exists

Brief §12.7: "A personal wiki that grows organically over months
accumulates pages nothing links to anymore, and wikilinks that point
at a page that got renamed or deleted before §12.2's redirect handling
existed (or a wikilink typo). A simple admin/maintenance report —
orphaned pages (no backlinks), broken wikilinks — turns 'the wiki
slowly rots' into a five-minute occasional cleanup pass."

Worth shipping right after §12.2 because the redirect infrastructure
it just added is the largest source of "broken wikilinks" the report
needs to surface — a redirect whose target page is later deleted or
moved out of a space is the canonical broken-link case, and the
resolver already returns 404 for it (so the page is invisible) but
the alias row stays in the table forever.

### What landed

- **`src/server/services/maintenance.service.ts`** (new):
  - `buildMaintenanceReport(spaceId)` returns
    `{ generatedAt, orphanedPages, brokenRedirects }`.
  - `orphanedPages`: every non-system, non-trashed branch in this space
    whose page is not the target of any backlink, sorted by
    `updatedAt` desc. The "not the target of any backlink" check
    joins the `backlinks` table through `branches.targetBranchId` so
    intra-space references are detected (a reference from a page in
    another space still counts — backlinks are global).
  - `brokenRedirects`: `page_redirects` rows in this space whose
    target page is either `deletedAt !== null` (`reason: "deleted"`)
    or no longer has a non-system branch in this space (`reason:
    "missing"`). Stale rows whose `oldSlug` matches the page's
    current slug are filtered out (the rename-back-to-old-slug case
    in §12.2).
  - `deleteAlias(spaceId, oldSlug)` — single-alias prune, the companion
    mutation to the report.
- **Routes** (in `space.routes.ts`):
  - `GET /api/spaces/:spaceId/maintenance` — admin-only (the report
    leaks page metadata that non-admins shouldn't see).
  - `DELETE /api/spaces/:spaceId/redirects/:oldSlug` — admin-only.
- **Tests** — `src/server/__tests__/maintenance.integration.test.ts`,
  12 cases: empty report, orphan detection, referenced-page is NOT
  orphan, deleted-target redirect surfacing, missing-target redirect
  surfacing, healthy redirects are quiet, stale rows filtered out,
  single-alias DELETE, route-level admin gating (read + delete),
  `deleteAlias` service direct (true / false).

### Design notes

- **Per-space, not global.** The brief's target user is the operator
  doing an occasional cleanup pass; a single space stays readable as
  the wiki grows. A platform-wide admin view can iterate over spaces
  at the route layer.
- **Admin-only.** The report's "broken redirects" output includes
  page titles and slugs of pages the operator might not otherwise be
  able to read; gating on `spaceAdminGuard` keeps that surface inside
  the same scope as the existing space settings.
- **Backlinks are global, not space-scoped.** A page referenced from
  a sibling space is NOT orphaned here. The brief's "nothing links
  to them anymore" doesn't say "from this space only", and forcing
  isolation would surface false positives for any cross-space wiki.
- **No automatic pruning.** The brief says "occasional cleanup pass" —
  the operator clicks "delete this alias" or "delete this orphaned
  page" from the report. Auto-cleanup would be a destructive
  surprise; the existing Trash/Restore flow already covers removing
  an orphaned page on intent.
- **No "broken wikilinks" category yet.** Wikilinks are a Tiptap node
  that doesn't exist yet (§13.1 will bring typed relations). Until
  then, "broken wikilinks" reduces to "broken redirects" — which
  Slice-22 surfaces — and orphans — which Slice-22 surfaces.

### Follow-ups left for later

- A front-end slideover/route that renders the report with one-click
  "Go to page" / "Delete alias" / "Send to trash" actions.
- Bulk-prune aliases via a single admin action ("delete all `reason:
  missing` aliases" — a one-button cleanup for the common case).
- A "broken wikilinks" category once the wikilink node ships.

## Slice-23 — real diff view between commits (§12.3)

### Why this slice exists

> "Once a page has accumulated any history, an authoritative 'show me
> what changed between any two revisions' diff view (paragraph-by-
> paragraph or line-by-line if the page is a single text block) lets
> you recover the answer to 'why did this paragraph get rewritten
> last week'."  (brief §12.3)

The git-flush pipeline already keeps every page's Markdown in the
content repo with `<space-slug>/<page-slug>.md` plus YAML frontmatter
holding the title and updatedAt. Slice-23 adds a way to read TWO of
those revisions back out and produce a line-level unified diff between
them, returning the data the front-end slideover will render.

### What changed

- `src/server/services/diff.service.ts` (new): `diffRevisions(pageId,
  fromHash, toHash)` reads both revisions via the existing
  `getFileContentAtCommit` (which already handles the "snapshot vs
  autosave" distinction in `git.service.ts:120`), strips YAML
  frontmatter, computes a hand-rolled LCS-based line diff, and returns
  `{ titleChanged, fromTitle, toTitle, lines[], summary }`.
- `src/server/routes/page.routes.ts`: `GET
  /api/pages/:pageId/branches/:branchId/diff?from=<sha>&to=<sha>`,
  viewer-gated — same gate as the history route it sits next to.
  Returns 404 when either hash can't be resolved.
- `src/server/services/__tests__/diff.test.ts` (new): 8 unit tests
  for `splitFrontmatter`, `stripFrontmatter`, and `computeLineDiff`.
- `src/server/__tests__/diff.integration.test.ts` (new): 8
  integration tests through the real Fastify app:
  - diff a revision against itself → 0 lines of change
  - diff commits that round-trip to identical file content → 0
    lines of change
  - added / removed line detection (real route, real git plumbing)
  - `titleChanged` signal derived from frontmatter, independent of
    body diff
  - `fromLine` / `toLine` are populated correctly for context vs
    added
  - 404 on a non-existent target hash
  - 403 for a non-member querying a private page's diff

### Design notes

- **Line-level, not paragraph-level.** The Tiptap doc serialises to
  Markdown with one paragraph per block and `\n\n` between them —
  paragraph-level alignment would need a separate block-id mapping
  from `markdownToTiptap`, which the export side doesn't currently
  preserve (Slice-23 deliberately doesn't add that plumbing in this
  pass). Line-level LCS on the Markdown body is simple, dependency-
  free, and reads naturally — Markdown is line-oriented.
- **Hand-rolled LCS, no `diff` dependency.** `diff` is in the
  lockfile transitively (via vitest), but relying on a transitive
  isn't safe across vitest bumps. The LCS is ~30 lines and
  O(N*M) memory — fine for page-sized files (a personal-wiki page
  rarely exceeds a few hundred lines).
- **Frontmatter is bookkeeping.** The body is what changed in the
  meaningful sense; the YAML wrapper is bookkeeping. Title changes
  are surfaced separately via `titleChanged` / `fromTitle` /
  `toTitle` so the UI can call them out without crowding the line
  diff. The body diff itself strips frontmatter before splitting
  into lines.
- **History is newest-first.** `getPageHistory` returns commits in
  reverse-chronological order (the git log default), so the
  chronologically-OLDEST hash lives at the tail. Test helpers use
  `pickFirstLast(history)` to pick a sensible pair without re-doing
  the ordering logic per test.
- **Empty diff ≠ bug.** A save that produces no file change is a
  no-op in the git-flush pipeline (see `git.service.ts:80`), so the
  history may have gaps. Tests that need ≥2 distinct commits either
  save twice with different content or save a third time to "reset"
  to an earlier value.
- **`getFileContentAtCommit` already does the heavy lifting.** It
  resolves the right file path for a commit given that the page may
  have been renamed (`diff-tree` reports the actual file the commit
  modified, and the snapshot/autosave branch is selected based on
  `page:<id>:` message format). Slice-23 just consumes it.

### Follow-ups left for later

- A front-end slideover with two dropdowns and a unified-diff
  rendering (CSS `bg-red-100` for removed, `bg-green-100` for
  added).
- Optional "Show changes since I last viewed" — store a per-user
  pointer to last-viewed commit and offer it as a default
  comparison.
- A wikilink node (§13.1) that would let us rebuild the diff at
  the Tiptap block level instead of the Markdown line level.

## Slice-24 — lenses / saved-filter view (§12.4)

### Why this slice exists

> "The tree is a single hierarchy, but your actual content spans
> several unrelated axes at once — a homelab page and a ham radio page
> might both relate to 'antenna feedline,' a recipe and a homesteading
> note might both be tagged 'canning.' A tree can only put a page in
> one place at a time (cloning aside). The attributes system already in
> the product model (§2) is most of what's needed here — extend it
> into a simple saved-filter/tag-browse view ('show me every page
> tagged `proxmox`' across every space you have access to) so cross-
> cutting topics don't require restructuring the tree to surface them."
> (brief §12.4)

Lenses are user-shaped saved filters over the existing `attributes`
table — no new tagging infrastructure needed. The criteria vocabulary
covers the brief's user-context list verbatim: tag, property, regex
over title, owner=self, owner=group.

### What changed

- `src/server/db/schema.ts`: new `savedFilters` table —
  `id, ownerId, name, description, criteria (JSON),
  visibility (private/unlisted/public), shareToken, createdAt`.
  `shareToken` is unique and is generated only for unlisted lenses.
- `drizzle/0005_greedy_stepford_cuckoos.sql` (new): the migration
  for the table above. Auto-applied on boot by the existing
  `migrate(...)` call in `db/index.ts`.
- `src/server/services/lens.service.ts` (new):
  - `createLens`, `getLens`, `getLensByToken`, `listLensesForUser`,
    `updateLens`, `deleteLens` — standard CRUD on the new table.
  - `runLens(lens, caller)` — evaluates the criteria against
    `pages ⨝ branches ⨝ spaces` with positional-parameter SQL
    (no identifier interpolation), returning one row per page
    (collapsed across multiple placements via `GROUP BY p.id`).
  - Criteria vocabulary: `tags[]`, `properties[{name,value}]`,
    `titleRegex`, `ownerScope` ∈ `self | anyone | {group, groupId}`,
    `spaceIds[]`, `includeTrash` (default `false`).
  - Access scoping: non-admin callers are auto-restricted to spaces
    they have viewer access to (via `space_members` ∪
    `space_group_permissions`); admin bypasses the same way search
    does.
- `src/server/db/index.ts`: registers a deterministic `REGEXP`
  SQL function so `titleRegex` works (SQLite ships without one).
  Bad patterns throw at evaluation time so failures are loud, not
  silent.
- `src/server/routes/lens.routes.ts` (new): 8 routes wired into
  `app.ts` after `tokenRoutes`:
  - `GET /api/lenses` (authenticated) — list own + public.
  - `POST /api/lenses` (authenticated) — create.
  - `GET /api/lenses/:id` (authenticated) — read; visibility-gated.
  - `PATCH /api/lenses/:id` (authenticated) — owner or admin.
  - `DELETE /api/lenses/:id` (authenticated) — owner or admin.
  - `GET /api/lenses/:id/results` (authenticated) — run + return hits.
  - `GET /api/lenses/by-token/:token` (public) — fetch by share
    token (the token is the capability).
  - `GET /api/lenses/by-token/:token/results` (authenticated) — run
    a shared lens with the caller's own access scope.
- `src/server/services/__tests__/lens.test.ts` (new): 8 unit
  tests for the criteria evaluator (no HTTP):
  - matches by tag
  - intersects `tag AND titleRegex`
  - returns `[]` for criteria with no matches
  - `ownerScope: "self"` filters to the caller's pages
  - `ownerScope: { kind: "group", groupId }` filters via
    `user_groups` membership
  - `includeTrash: false` default excludes soft-deleted;
    `includeTrash: true` reveals them
  - invalid `titleRegex` throws `invalid regex pattern`
  - `shareToken` lifecycle: generated on `unlisted`, cleared on
    transition to `private`/`public`, regenerated on transition
    back to `unlisted` (so the old share URL stops working).
- `src/server/__tests__/lens.integration.test.ts` (new): 7
  integration tests through the real Fastify app, covering
  create/list/run, title-regex, property match, `owner=self`,
  visibility enforcement (outsider can't read or run a private
  lens), unlisted share-token URLs, and admin-vs-owner patch/
  delete.

### Design notes

- **No `tags` table — derive from `attributes`.** The brief calls
  this out explicitly: "The attributes system already in the
  product model (§2) is most of what's needed here." Tag matching
  is `attributes.name = 'tag' AND attributes.value IN [...]`,
  which is already indexed-friendly. Pages with no `name='tag'`
  attribute are excluded by definition.
- **One row per page, not per placement.** `pages` is the
  authoritative unit — `branches` is just a placement record.
  `GROUP BY p.id` collapses clones. The `MIN(b.id)` keeps the
  ordering deterministic without a window function. The
  front-end uses `branchId` to navigate to the first placement
  for the page; the user can swap to another placement via the
  existing tree UI.
- **Raw SQL inside a typed service.** The criteria is small
  (≤ 5 distinct clauses) and the structure is fixed. Hand-built
  positional-parameter SQL is simpler and more auditable than
  building a drizzle `WHERE` and reading back its internal
  `queryChunks`. All user-controlled values bind as parameters
  (`?`), never as SQL fragments. The only string interpolation
  is for `IN (?,?,?)` placeholder counts, which is a count, not
  a value.
- **REGEXP via JS.** SQLite's built-in `REGEXP` is a no-op
  unless you register a function. We do, with a JS `RegExp`
  throw on bad patterns so a malformed lens fails loudly at
  `runLens` time rather than silently returning zero matches.
- **Visibility is three-state, not two.** `public` is "everyone
  authenticated can find it via the list endpoint," `unlisted`
  is "only people with the share-token URL can find it," and
  `private` is "only the owner." The unlisted share token is
  rotated every time visibility transitions back to `unlisted`,
  so a leaked URL stops working on the next toggle.
- **Access scoping mirrors search.** `loadAccessibleSpaceIds`
  re-implements the same `space_members ∪ space_group_permissions`
  union that `accessibleBranchIds` already uses in
  `branch.service.ts`, but at the space level. Admin users
  bypass it; everyone else gets auto-scoped before the criteria
  even runs. This is a deliberate choice: it keeps the per-row
  permission check out of `runLens` (the lens is a *view*, not
  an enumeration of every page) and matches the principle in
  the brief that lenses surface content you can already see.

### Follow-ups left for later

- Lens-list endpoints (`GET /api/lenses`) and a front-end
  `LensesPage` with create / edit / share UI.
- A `?includeHits=true` mode on the list endpoint so the index
  page can render previews without a second round-trip.
- "Recently used" — order the list by last-`runLens` timestamp
  once we add that.
- Server-side caching keyed on `criteria.hash` for very large
  pagesets; not worth it until the dataset exceeds a few
  thousand pages.
- Per-lens bookmarks / starred-lenses, if user feedback says
  the public + unlisted list is hard to navigate.

## Slice-30 — plugin hooks engine (§13.5)

### Why this slice exists

Brief §13.5 — give plugins first-class access to the event stream
so they can react to user actions (load, save, attribute change)
without the host code knowing anything about their internals. The
hook API is the foundation everything else in §13.5 builds on.

### What changed

- **`src/shared/pluginTypes.ts`** — added `hooks: boolean` to the
  capability union; `PluginCapabilities` now has the same shape the
  manifest validator accepts and the loader writes into the DB.
- **`src/server/hookTypes.ts` (new)** — single `HookEvent` union
  with three members (`PageLoadEvent`, `PageSaveEvent`,
  `AttributeChangeEvent`). Action strings on `AttributeChangeEvent`
  are the literal `"set"` / `"delete"` — kept as a typed string
  union, not a bare string, so plugin authors see autocomplete.
- **`src/server/hooks.ts` (new)** — the registry. Three exported
  calls plus one test-only reset hook:
  - `registerHook(pluginId, event, handler)` returns an
    `unregister` closure that idempotently removes that one
    subscription.
  - `unregisterPluginHooks(pluginId)` clears *every* subscription
    owned by `pluginId` across all events. Called on disable /
    uninstall.
  - `dispatchHook(event)` snapshots the subscriber list, then
    awaits each handler in order. A throwing handler is logged via
    `console.error` and never blocks the others, so a misbehaving
    plugin can't break the host request.
  - `totalHookSubscriptionCount()` and `__resetHookRegistry()` are
    test-only helpers (note the underscore; not part of the
    public API surface).
- **`src/server/services/plugin.service.ts`** — wired hooks into
  the plugin lifecycle:
  - `_registeredHookPlugins: Set<string>` tracks which plugin ids
    currently have at least one live subscription.
  - `registerPluginHookHandlers()` iterates every row with
    `capabilities.hooks === true` and `enabled === true`, dynamic-
    imports `<pluginDir>/server/index.js`, and calls the default
    export with `{ pluginId, registerHook }`. The function can
    register one handler or many; the loop does not impose a limit.
  - `loadPluginHookModule(...)` is the per-plugin workhorse. If
    the module has no default export it logs and skips — the host
    never crashes because a plugin is missing the `export default`
    line.
  - `setPluginEnabled(id, false, ...)` now calls
    `unregisterPluginHooks(id)` before flipping the DB row, and
    `(id, true, ...)` calls `loadPluginHookModule` after.
  - `uninstallPlugin(id, ...)` unregisters as part of teardown so
    the registry stays consistent with disk + DB.
  - `registerPluginServerRoutes` was the existing "boot loader"
    for `serverRoutes`. The new hook loader runs alongside it in
    `app.ts`.
- **`src/server/app.ts`** — after the existing
  `registerPluginServerRoutes(...)` call, the boot path now also
  calls `registerPluginHookHandlers(...)` so enabled plugins get
  their hook handlers bound at startup, not on first event.
- **`src/server/routes/page.routes.ts`** —
  - `GET /api/branches/:branchId/page`: after the response object
    is built but *before* `return reply.send(...)`, dispatches a
    `pageLoad` event with `{ actorUserId, pageId, branchId }`.
    Dispatch is fire-and-forget (`void dispatchHook(...)`); the
    user-facing response is never gated on a slow plugin handler.
  - `PUT /api/branches/:branchId/page/content`: dispatches a
    `pageSave` event after a successful save, with the same
    fire-and-forget shape. Failed saves (422 / 409) do NOT emit —
    the event fires only on the success branch.
- **`src/server/routes/relation.routes.ts`** —
  - `POST /api/pages/:pageId/relations`: dispatches
    `attributeChange` / `set` with
    `{ name, valuePageId }`. Validation failure (400) does not
    emit.
  - `DELETE /api/pages/:pageId/relations/:attrId`: dispatches
    `attributeChange` / `delete`. Required changing
    `removeRelation()` in `relation.service.ts` to return the
    deleted row's `{ pageId, name, valuePageId }` so the route can
    fill in the relation's user-defined `name` (the `type` string
    in the brief) instead of just `attributeId`. Backward
    compatible — `removeRelation` was previously `Promise<void>`,
    which is the same shape as a Promise that resolves to an object
    nobody reads.

### Design notes

- **Dispatch is fire-and-forget on purpose.** The host request must
  not be slowed down by a plugin handler, especially the read path
  (every page GET fires a `pageLoad`). `void dispatchHook(...)`
  returns the promise to the event loop and the route handler
  proceeds; the handler errors are caught and logged inside
  `dispatchHook` itself.
- **Snapshot-before-iterate.** `dispatchHook` reads the subscriber
  list into a local array before iterating so a handler that calls
  `unregister` mid-flight doesn't corrupt iteration. Test
  `snapshot slicing lets a handler unregister mid-dispatch without
  corrupting iteration` exercises this.
- **Capability flag, not file existence.** Plugins without a
  default-export function on `server/index.js` are skipped, but
  plugins without the `hooks` capability are *not even loaded*
  (let alone crash). The manifest is the source of truth.
- **One registry, many events.** A single per-process object holds
  the subscriber map for every event name. Per-event iteration is
  O(subscribers for that event) — no cross-event work, no leaks.
- **`removeRelation` now returns the deleted row.** The brief's
  `attributeChange/delete` hook needs the relation's `name`
  (user-defined type string) for downstream filtering. The new
  return type is additive; existing callers that ignored the
  return value still compile.

### Tests

- `src/server/__tests__/hooks.test.ts` — 11 unit tests for the
  registry itself: no subscribers returns 0; single handler is
  invoked; multi-plugin independence; per-event isolation; throwing
  handler doesn't kill siblings; `unregister` closure works and is
  idempotent; `unregisterPluginHooks` removes every event owned by
  a plugin; mid-dispatch `unregister` is safe; async handlers are
  awaited; `attributeChange` payload shape round-trips.
- `src/server/__tests__/hooks.integration.test.ts` — 5
  integration tests against the real DB and plugin loader:
  capabilities.on loads + dispatches; capabilities.off is ignored;
  `setPluginEnabled(false)` tears down; `setPluginEnabled(true)`
  re-loads; plugin modules without a default export are skipped;
  `uninstallPlugin` removes every subscription.
- `src/server/__tests__/hooks.events.test.ts` — 5 route-level
  integration tests using `app.inject` + `randomBytes` page ids:
  `pageLoad` fires after a successful GET; `pageSave` fires after
  a successful content PUT (with expectedUpdatedAt flow); both
  `attributeChange/set` and `attributeChange/delete` fire from the
  relation routes with the correct `name` attached; a throwing
  handler does NOT break the host request.
- Full suite after slice-30: 49 files / 399 tests, typecheck
  clean.

### Follow-ups left for later

- More events: `spaceCreate`, `branchMove`, `permissionGrant`,
  `userInvite`, etc. Adding a new event is now just two lines
  (one type in `hookTypes.ts`, one dispatch site in a route).
- Handler execution timeout. Today a misbehaving async handler
  could hang the snapshot for that dispatch. A per-handler
  `Promise.race([handler, timeout])` is the obvious follow-up.
- Hook metrics / observability — counters per event per plugin
  for the admin dashboard. The registry already has the data.
- Persisted hook subscriptions (so a plugin can be enabled
  *before* its module is on disk and still pick up its handlers
  when installed later). Today, install + enable is the only path.
- Admin UI: "last 100 hook events" view to help plugin authors
  debug. The data isn't captured yet but the dispatcher is the
  only place that would need to log it.

### Why this slice exists

Brief §13.3 — a page can declare a template via `template:<pageId>`
and inherit its attributes at read time. Trilium's classic model.

### What changed

- **`src/server/services/template.service.ts` (new).**
  `resolveInheritedAttributes(pageId, user)` does the walk:
  reads the page's own `name="template"` relation attributes,
  permission-filters each direct template through `canViewPage`,
  then BFS-escapes the chain with a visited-set + 8-deep cap.
  Pure merge logic is split out as `mergeInheritedAttributes()` so
  it can be unit-tested without the DB.
  Returns `{ directTemplates, inheritedAttributes }`. Each
  inherited attribute carries `templatePageId`, `templateTitle`,
  and `depth` so the UI can show provenance.
- **`src/server/routes/page.routes.ts`.** `GET /api/branches/:branchId/page`
  now returns `templates: TemplateRef[]` and
  `inheritedAttributes: InheritedAttribute[]` in addition to the
  existing `attributes` array. Page's own attributes stay on
  `attributes` (same shape as before).
- **`src/api/client.ts`.** New `TemplateRef` and `InheritedAttribute`
  types; both fields on `PageData` are optional for forward-compat.
- **`src/features/templates/TemplateBanner.tsx` (new).**
  Presentational banner rendered above the page header in
  `routes/_authenticated/w/$branchId.tsx`. Shows the direct
  templates as clickable links and an "Inherits N attribute(s)"
  count when there's anything to inherit. Renders nothing when the
  page has no templates.

### Design notes

- **Conflict rule: page wins, first template wins among templates.**
  Matches Trilium and matches the user's mental model: own attrs
  override inherited, and between two templates the earlier-listed
  one is the more authoritative source.
- **Cycle-safe via visited set.** A chain A → B → A terminates
  cleanly; the second occurrence of A is dropped. Test coverage:
  `template.integration.test.ts` "cycles don't infinite-loop."
- **Depth-limited (`DEFAULT_MAX_DEPTH = 8`).** A hard backstop
  against runaway chains or hand-crafted loops. Honest use cases
  almost never exceed 2-3 levels.
- **Permission filter upstream.** Every template page is checked
  with `canViewPage(user, templatePageId)` *before* its attributes
  are included. A template the caller can't read is dropped
  silently — same no-existence-leak rule used by backlinks, graph,
  and relations (brief §13.1 / §13.2).
- **Template attribute `template` itself is not propagated.**
  When walking a template's chain, we skip its own `template:*`
  relations when copying its attributes into the page's view;
  only *non-relation* attributes inherit. (The "this page is the
  template of *that* page" pointer is metadata, not data.)
- **Output ordering is stable.** By `depth` ascending, then
  `position` ascending, then `name`. So two consecutive calls with
  the same data return identical JSON — important for snapshot
  tests and ETag caching.
- **`@testing-library/react` is not installed.** The banner test
  follows the project's `renderToStaticMarkup` + `vi.mock("@tanstack/react-router")`
  pattern used by the rest of the feature tests.

### Tests

- `src/server/services/__tests__/template.test.ts` — 8 unit
  tests for `mergeInheritedAttributes`: empty, no-collision,
  own-wins, first-template-wins, multi-depth, ordering.
- `src/server/__tests__/template.integration.test.ts` — 7
  integration tests over the real Fastify app: no-template,
  empty-template, basic inheritance, override, 2-level chain,
  cycle, permission filter.
- `src/features/templates/__tests__/TemplateBanner.test.tsx` —
  6 SSR tests: empty, singular header, plural header,
  inherited-count (singular + plural), hidden when no inherited.
- Full suite after slice-28: 42 files / 351 tests, typecheck clean.

### Follow-ups left for later

- A read-only "Attributes" panel that shows the merged attribute
  set (own + inherited) with provenance — the API already exposes
  it; just a UI surface.
- Editor support for adding/removing the `template` relation
  attribute directly (today you go through RelationsPanel).
- Cache the resolved chain per `(pageId, userId)` if profiles show
  it's hot; the BFS is a few queries per page-load right now.

### Why this slice exists

Brief §13.4 — attribute-driven table and board views over a saved
lens. Promoted attributes become *columns* and *board lanes* once
you can render the same lens result as structured data. Concretely:
"every QSO log page, sorted by date and band" is now one toggle
away from the current "find-by-tag" view.

### What changed

- **`src/server/services/lens.service.ts`** — new `runLensWithAttributes()`
  wraps `runLens()` and enriches each hit with its promoted
  attributes (own + inherited via §13.3's `resolveInheritedAttributes`).
  Helper `enrichOneHit()` does the per-hit work: own promoted
  from a direct `attributes` query, inherited promoted from the
  resolver, then a name-keyed merge where own wins on collision.
  Two new types: `LensHitAttribute` (with `own` and `fromTitle`
  provenance) and `EnrichedLensHit`.
- **`src/server/routes/lens.routes.ts`** — both results endpoints
  (`/api/lenses/:id/results` and `/api/lenses/by-token/:token/results`)
  accept `?include=attributes`; when set, hits come back with
  `promotedAttributes[]`. Default response stays light for backward
  compatibility with the existing slice-24 tests.
- **`src/api/client.ts`** — new `LensSummary`, `LensDetail`,
  `LensCriteria`, `LensHit`, `LensHitAttribute` interfaces, plus
  `api.listLenses`, `api.getLens`, `api.runLens`, `api.runLensByToken`.
- **`src/features/lenses/lensView.helpers.ts` (new)** — pure
  helpers `deriveColumns`, `findAttr`, `sortHits`, `groupHits`.
  Sort puts hits missing the column last (stable); group buckets
  empty values into `__none__` sorted last.
- **`src/features/lenses/TableView.tsx` (new)** — sortable table.
  Click a column header to sort; click again to flip direction.
  Inherited attribute values get a `↑<templateTitle>` suffix so the
  provenance is visible inline. Pure presentational; takes a
  `renderPageLink` callback so the unit test doesn't need a router.
- **`src/features/lenses/BoardView.tsx` (new)** — kanban view.
  One column per distinct value of the chosen attribute; column
  count badge; same `renderPageLink` pattern.
- **`src/routes/_authenticated/lenses/index.tsx` (new)** —
  Saved-views landing page. Lists every lens the caller can read.
- **`src/routes/_authenticated/lenses/$lensId.tsx` (new)** —
  Lens detail with **List / Table / Board** view switcher, sort
  state, and a group-by dropdown that auto-populates from the
  result set's promoted columns.
- **`src/routes/_authenticated.tsx`** — new "Saved views" link in
  the topbar.

### Design notes

- **Promoted-only by design.** The resolver surface (table/board)
  is for *promoted* attributes — those the user has explicitly
  surfaced as a column. The full `attributes` array (un-promoted
  relations, internal markers, etc.) stays in the page-API
  response so the editor can still read them.
- **Own wins on collision, deterministically.** If a page declares
  a promoted attribute with the same name as its template, the
  page's value wins. The `↑<fromTitle>` marker only appears for
  inherited attrs — readers can always see when a value comes from
  a template instead of the page itself.
- **Hidden "noise" attributes are filtered client-side.** Anything
  starting with `#` or `_` is the system/internal convention; those
  never become columns. Filter is in `deriveColumns`; server still
  ships them so the editor UIs can read them.
- **Group-by empty values get a `(none)` column**, sorted last.
  Otherwise a single hit with a missing value would create a
  one-card column labeled "" that looks like a rendering bug.
- **Default view is Table, not List.** Table degrades gracefully
  to a List-equivalent when the result has no promoted attributes
  (single Title + Space columns). New users land on the §13.4
  headline view.
- **`@testing-library/react` is still not installed.** Feature
  tests follow the project's `renderToStaticMarkup` +
  `vi.mock("@tanstack/react-router")` pattern. We mock only the
  one symbol we touch (`Link`) so other router internals keep
  working.
- **Theme tokens, not literal colors.** The project enforces
  `src/styles/__tests__/theme.test.ts` (every color must come
  from `src/styles/tokens.css`). The first cut of TableView used
  `bg-red-100` / `text-red-700` for the "trashed" badge and
  `text-red-600` for error states; those all moved to `border-border
  bg-surface text-text-muted` and `text-danger` respectively.

### Tests

- `src/server/__tests__/lens-attributes.integration.test.ts` —
  6 integration tests over the real Fastify app: default
  endpoint doesn't include the field, `?include=attributes`
  does, own-promoted comes through, non-promoted is filtered,
  inherited from §13.3 chain surfaces with provenance, drop
  inherited attrs when the template is unreadable (no
  existence leak), share-token endpoint honors the flag.
- `src/features/lenses/__tests__/lensView.helpers.test.ts` —
  11 unit tests: deriveColumns sorting + noise-skipping + empty
  cases; findAttr; sortHits asc/desc/missing-last/no-sort;
  groupHits distinct-values, none-bucket, empty-input.
- `src/features/lenses/__tests__/TableView.test.tsx` — 6 SSR
  tests: empty state, column ordering, inherited marker, dash
  for missing, sort arrow when active, trashed badge.
- `src/features/lenses/__tests__/BoardView.test.tsx` — 4 SSR
  tests: empty state, distinct columns, (none) column, count
  badge.
- Full suite after slice-29: 46 files / 378 tests, typecheck
  clean, theme test green.

### Follow-ups left for later

- Lens create / edit / delete UI (the API is already there from
  slice-24 — admin can still wire lenses via `POST /api/lenses`).
- Server-side caching of `resolveInheritedAttributes` per
  `(pageId, userId)` if profiling shows it hot.
- A `?includeHits=true` mode on the list endpoint so the index
  page can render previews without a second round-trip.
- "Recently used" — order the list by last-`runLens` timestamp
  once we add that.
- Per-lens bookmarks / starred-lenses, if user feedback says
  the public + unlisted list is hard to navigate.
- Server-side caching keyed on `criteria.hash` for very large
  pagesets; not worth it until the dataset exceeds a few
  thousand pages.

## Slice-31 — first-class Mermaid insert (§13.6, Mermaid portion)

### Why this slice exists

Brief §13.6 calls out two pieces of editor work that fold
into step 5: dedicated **code pages** (whole page is a
syntax-highlighted code/config file) and **first-class Mermaid**
(a Tiptap node that renders diagrams from its text source, like
how math rendering already works in the current app). The
Mermaid node already existed since slice-15 and round-trips
through markdown, but you could only reach it through the
toolbar — there was no slash command and no obvious onboarding
content, so the feature felt like an afterthought. This slice
finishes the Mermaid half of §13.6.

The **code-pages** half is its own slice (deferred). Splitting
keeps each landed slice's surface small and the architecture
choices (page type vs. editor mode vs. directory entry)
isolated for review.

### What changed

- **`src/features/editor/extensions/mermaidInsert.ts` (new).**
  Single source of truth for how a Mermaid block is inserted.
  Holds the starter template (`MERMAID_STARTER` — a 5-line
  `graph TD` flowchart with one decision so the user sees
  something render and has obvious edit anchors) plus
  `insertMermaidDiagram(editor)` which fires
  `chain().focus().insertContent([mermaidDiagram + paragraph])`.
  The trailing paragraph is load-bearing: without it Tiptap
  leaves the caret inside the just-inserted mermaid atom and
  the user has to press ArrowDown to keep typing.
- **`src/features/editor/extensions/mermaidSlashCommand.ts`
  (new).** `registerMermaidSlashCommand()` — registers a slash
  command named `mermaid` (label "Mermaid diagram", icon `◇`,
  keywords `["diagram","chart","flow","graph","sequence"]`)
  that calls the insert helper. Lives next to the mermaid
  extension so anyone touching the node sees the slash hookup.
- **`src/plugins/coreCommands.ts` (new).** Centralized
  boot-time registration of every first-party slash command.
  Today: just `registerMermaidSlashCommand()`. Future first-
  class content types (divider, callout, code-page shortcut)
  add their own `registerXxxSlashCommand()` here. Keeps the
  invariant "core commands register before user plugins" in
  one place.
- **`src/plugins/loader.ts`** — calls `registerCoreCommands()`
  inside `loadPlugins()` immediately after the `_loaded` guard,
  so the Mermaid command is in the registry even before the
  user-plugin list fetch resolves (and even when the plugin
  fetch fails entirely). The `_authenticated` loading gate
  already waits for `usePluginsLoaded()`; core commands now
  ride the same gate.
- **`src/features/editor/Editor.tsx`** — added a `Workflow`
  lucide button in the toolbar between Code block and the
  plugin-item separator. Clicking it calls
  `insertMermaidDiagram(editor)`, so toolbar and slash-menu
  share one insertion path.

### Tests added

- **`src/features/editor/__tests__/mermaidInsert.test.ts`
  (3 tests).** Recording-mock editor verifies (a) a
  `mermaidDiagram` node with `MERMAID_STARTER` text is
  inserted followed by an empty paragraph, (b) the chain
  order is `focus → insertContent → run`, (c) the starter
  template parses as a Mermaid graph directive.
- **`src/plugins/__tests__/coreCommands.test.ts` (3 tests).**
  `registerCoreCommands()` lands a slash command named
  `mermaid` with the right metadata; the registered `run`
  inserts a `mermaidDiagram`; the slash-command `run` and the
  toolbar button call the same insert helper (regression guard
  so UX changes only need to land in one place).

### Test counts

- Full suite after slice-31: **51 files / 405 tests**, typecheck
  clean, **e2e 19/19 green**, `npm run build` clean.
- (Slice-30 baseline was 49 files / 399 tests.)

### Why code pages stayed out of this slice

Code pages are a different kind of feature from a Mermaid
content block: they need a page-level type (separate editor
mode, separate markdown export path, possibly a separate
directory entry), new permission model (could they be rendered
read-only into a parent page?), and a UX story (do they appear
in `Ctrl-K` search? in the tree?). Bundling any of those
decisions into the Mermaid polish slice would have made review
much harder. Landed here as its own future slice.

### Follow-ups left for later (within §13.6)

- Dedicated code page type — landed in slice-32 (below).
- If we add more slash-menu items, sort them by recency or
  category (Right now the slash menu shows them in registration
  order.)


## Slice-32 — dedicated code page type (§13.6, code-pages portion)

### Why this slice exists

Slice-31 finished the Mermaid half of §13.6. This slice finishes the
other half: a **code page** whose whole body is a single
syntax-highlighted source/config file, distinct from a code block
embedded in a rich-text page. Useful for full shell scripts and config
files where the surrounding wiki page is unnecessary overhead.

### Architecture decisions

- **One column, two content kinds.** `pages.page_type` is `"wiki"` or
  `"code"`; `pages.language` is the syntax language (null for wiki).
  Code pages store the raw source as a JSON string in the existing
  `pages.content` column (`drizzle` `mode:"json"` round-trips a plain
  JS string) rather than adding a parallel column — the row stays
  self-contained and no content-kind join is needed.
- **String-only OCC save.** `savePageOCC` checks `pageType` first; for
  code pages it rejects non-string bodies and routes to
  `saveCodePageOCC`, which skips block-id repair and backlink scanning
  (code has no wiki links) but still reindexes search and enqueues a
  git commit.
- **Git export as real source files.** Code pages export to
  `<space>/<slug>.<ext>` with no YAML frontmatter (readable diffs for
  scripts/configs); snapshots use `_snapshots/<id>.<ext>`.
  `getFileContentAtCommit` matches by page-id prefix because the
  extension varies by language. Restore returns code content verbatim
  instead of round-tripping markdown→Tiptap.
- **Shared language metadata.** `src/shared/codeLanguages.ts` is the
  single source of truth mapping aliases → Prism grammar id, UI label,
  and git file extension. Both server (git) and client (highlight/UI)
  use it so a filename and a language tag can never disagree.
- **Shared highlighter.** `src/features/editor/codeHighlight.ts` wraps
  Prism for both inline code blocks and whole-page code views, so the
  alias map + component loading live in exactly one place.
- **Editor is a plain textarea, not ProseMirror.** Syntax highlighting
  happens in read view; edit mode is a real text editor so undo/paste
  stay native. No collab for code pages (Yjs/Tiptap collab is
  rich-text only).

### What changed

- **`src/server/db/schema.ts` + `drizzle/0007`** — `pages.page_type`
  (default `'wiki'`) and nullable `pages.language`.
- **`src/shared/codeLanguages.ts` (new)** — `resolveCodeLanguage` and
  `codeLanguageExtension`.
- **`src/shared/types.ts`** — `PageType`.
- **`src/server/services/page.service.ts`** — `createPage` carries the
  type/language; `newCodeContent`; code branch in `getPageByBranchId`;
  `saveCodePageOCC`.
- **`src/server/routes/page.routes.ts`** — create/get/restore carry
  pageType/language; restore branches on pageType.
- **`src/server/services/git.service.ts`** — code raw export + raw
  snapshots + prefix-based file lookup.
- **`src/server/services/search.service.ts`** — `docToText` returns raw
  strings unchanged (indexes code text).
- **`src/features/editor/codeHighlight.ts` (new)** + refactor
  `ReadOnlyContent.tsx` to use it.
- **`src/features/editor/CodePageReadOnly.tsx` (new)** — Prism file
  view with language + extension header.
- **`src/features/editor/CodePageEditor.tsx` (new)** — controlled
  monospace textarea.
- **`src/routes/_authenticated/w/$branchId.tsx`** — mounts code
  read/edit views for `pageType === "code"`.
- **`src/api/client.ts`** — `PageData` and `createPage` carry
  pageType/language.

### Bug found by the e2e (and fixed before commit)

The code editor's autosave initially snapshotted `getContent()` from the
pre-render React closure, so a debounced save could persist the previous
(empty) text. Fixed by reading a ref that `handleChange` updates
synchronously before `scheduleSave()` — the same reason the Tiptap
editor reads `editorRef.current` at event time.

### Tests added

- **`src/server/__tests__/code-page.integration.test.ts` (4 tests)** —
  create with pageType/language; string body round-trip; non-string
  body → 422; raw text indexed for search.
- **`src/server/services/__tests__/git-service.test.ts` (+3)** — raw
  source export (no frontmatter) under the language extension; raw
  `getFileContentAtCommit` round-trip; raw snapshot export.
- **`src/shared/__tests__/codeLanguages.test.ts` (4)** — alias/canonical
  resolution + extension mapping + fallback.
- **`src/features/editor/__tests__/codeHighlight.test.ts` (3)** —
  tokenized output, null without language, source text escaping.
- **`e2e/codepage.spec.ts` (1)** — API create → read shell → edit →
  autosave → reload round-trip.

### Test counts

- Full suite after slice-32: **54 files / 419 tests**, typecheck clean,
  **e2e 20/20 green**, `npm run build` clean.
- (Slice-31 baseline was 51 files / 405 tests.)

### §13.6 remaining follow-ups

- Slash-menu ordering (recency/category) is a minor polish item, not
  core to §13.6 — left for a future UX pass.


## Slice-33 — per-page encryption (§13.7)

### Why this slice exists

§13.7 requires pages that are encrypted at rest and decrypted only
client-side after a per-session unlock, so a compromised server DB or
backup never exposes the body (e.g. financial notes).

### Crypto design (DEK + KEK envelope)

- `src/shared/cryptoEnvelope.ts` (new) implements a WebCrypto envelope:
  - **DEK** = random 256-bit AES-GCM key that encrypts the page body.
  - **KEK** = PBKDF2-SHA-256 (100k iterations) derived from the unlock
    passphrase; it only wraps the DEK, so re-saving edited content never
    re-derives the passphrase.
  - Stored shape: `{ v, kdf{salt,iterations}, dek{iv,data}, content{iv,data} }`.
- The server **never** holds the passphrase, KEK, or DEK. It only
  shape-validates the envelope (`validateEnvelope`) before persisting.
- Unlock returns `{ plaintext, dek }`; the client keeps the live DEK in
  memory for the session and re-seals edits with `sealContent`.

### Server changes

- **`drizzle/0008` + `schema.ts`** — `pages.is_encrypted` boolean
  (default false). When true, `pages.content` is a CryptoEnvelope, not a
  Tiptap doc or code string.
- **`page.service.ts`** — `getPageByBranchId` returns encrypted pages'
  `content` verbatim (skips doc/code validation). `savePageOCC` gains an
  `encrypted` flag: true routes to `saveEncryptedPageOCC` (validate
  envelope → OCC write → `isEncrypted=true` → `unindexPageForSearch`),
  while a normal save on an encrypted page clears the flag and stores the
  plaintext again (the "unprotect" path). No search/backlinks/mentions/git
  for encrypted bodies — the server never has plaintext to derive from.
- **`page.routes.ts`** — GET returns `isEncrypted`; PUT body accepts
  `encrypted`; mentions skipped for encrypted saves; snapshot/restore
  return 400 for encrypted pages.
- **`git.service.ts`** — defensive guards: `commitPageChange` and
  `commitManualSnapshot` throw for encrypted pages (they're never enqueued
  by the encrypted save path, so this only fires if a bad job sneaks in).
- **Search exclusion** is automatic: encrypted saves never index, and
  protect calls `unindexPageForSearch` to clear any pre-protection row.

### Client changes

- **`api/client.ts`** — `PageData.isEncrypted`; `savePageContent` body
  accepts `encrypted`.
- **`useAutosave.ts`** — optional `savePage` override (and the unmount
  flush now uses it) so encrypted pages can re-seal before hitting the API
  instead of leaking plaintext through the default save.
- **`$branchId.tsx`** — encrypted pages render `EncryptedPageLock` until
  unlocked; after unlock the normal wiki/code editors run with a custom
  `savePage` that re-seals and sends `encrypted:true`. Protect/unprotect
  buttons live in the header (view mode only, so dirty editor state can't
  be encrypted accidentally); history is hidden for encrypted pages.
- **`src/features/encryption/` (new)** — `EncryptedPageLock` (passphrase
  gate) and `ProtectPageDialog` (collect new passphrase).

### v1 limitations (documented on purpose)

- Only the page **body** is encrypted; `pages.title` stays plaintext so the
  tree/list can still render names. Do not put secrets in titles.
- Encrypted pages have **no git history** (snapshot/restore blocked). The
  git repo never receives ciphertext.
- The unlock is per browser-session and per page (not a global vault).

### Tests added

- **`src/shared/__tests__/cryptoEnvelope.test.ts` (5)** — create→unlock
  round-trip, tamper detection, wrong passphrase, re-seal stability,
  server shape validation.
- **`src/server/services/__tests__/page-service-encryption.test.ts` (3)** —
  encrypted save persists envelope + flags; non-envelope → 422 shape;
  plaintext save clears the flag.

### Test counts

- Full suite after slice-33: **56 files / 427 tests**, typecheck clean,
  `npm run build` clean.
- (Slice-32 baseline was 54 files / 419 tests.)

## Slice-34 — plugin failure isolation (§11.3)

Plugin bundles that fail to load must not bring down the host app. The
loader wraps each plugin's `activate()` in try/catch and records the
failure into the registry. The UI shows a non-blocking "1 plugin
disabled — view details" badge on the Plugins settings page instead of
crashing the editor.

- **`src/plugins/loader.ts`** — error capture with per-plugin failure
  list; registry exposes `disabledPlugins` to the UI.
- **`src/routes/_authenticated/settings/plugins.tsx`** — surfaces the
  list with the failure reason each plugin reported.

## Slice-35 — admin observability surface (§11.4)

Adds `/admin/observability` to the admin-only surfaces: aggregates of
plugin health, recent error events, and per-user edit volume. Rendered
as a TanStack Router page; admin-gated by the server-side middleware.

## Slice-36 — raw export survives disabled-plugin content (§11.2)

The git-backed export pipeline emits a page even if its plugin-extension
nodes fail to render — the raw JSON block is preserved as a verbatim
fallback so no data is silently lost when a plugin is later uninstalled.

## Slice-37 — offline readability for pinned pages (§12.5)

Adds a service worker (`public/sw.js`) that serves pinned pages
cache-first when the network is unreachable. The SW learns the pin set
from the client via `postMessage` (SWs can't read cookies). Pin toggle
endpoints and the `/api/pinned` list are server-side additions; the
shell HTML falls back to the last cached `/index.html` for navigation
requests so an offline user always gets a usable shell.

- **`public/sw.js`** — read-only cache-first strategy for pinned
  pages; the user's edits are NOT replicated offline (intentional, per
  brief scope).
- **`src/features/offline/PinButton.tsx`** — `data-testid="pin-button"`
  toggle wired to `/api/pinned/:branchId`.
- **`src/features/offline/OfflinePanel.tsx`** — `/pinned` route list,
  UX-only.
- **`src/server/__tests__/slice37.integration.test.ts`** (3) — server
  endpoints behave like /api/favorites.

## Slice-38 — defer SW pin-cache seed until auth resolves (§12.5)

Fix: the SW registration handler was firing `GET /api/pinned` at app
startup, before `useSession` resolved. The 401 an unauthenticated
visitor received was logged by the browser as "Failed to load
resource: 401" — tripping `e2e/skeleton.spec.ts`'s "no console errors"
assertion.

Extracted `seedOfflinePinCache()` into a new
`src/features/offline/sw-bridge.ts` that's only callable from inside the
authenticated layout. `registerOfflineServiceWorker()` at startup now
registers the SW only; the seed happens after auth resolves.

4 new unit tests in `sw-bridge.test.ts` lock the no-network-on-startup
property. Skeleton spec passes again.

## Slice-39 — mechanical §9.2 + §7.2 audit suite (§9.2 / §7.2)

The brief's security checklist and settings-IA rule are properties best
enforced by code, not by reviewers.

- **`src/server/__tests__/security-invariants.audit.test.ts`** (7 cases)
  greps every src/ file and fails on:
  - settings-shaped forms living outside `/settings`
  - `eval()` / `new Function()` outside the plugin loader
  - missing security headers at boot (nosniff, frame-deny, strict CSP)
  - missing `onRoute` middleware enforcing `config.access`
  - raw SQL interpolation of variables in services
  - `dangerouslySetInnerHTML` outside the sanctioned list (Prism,
    Mermaid, code page)
  - file downloads missing `X-Content-Type-Options: nosniff`

A canary test (drop an `eval()` into a temp file, watch the suite fail)
was run during development to confirm the audit is sensitive to
regressions. Allowlists carry a justification comment so future
additions stay accountable.

## Slice-40 — single-session happy-path e2e sweep (§9.4)

`e2e/happy-path.spec.ts` walks one user through every major feature in
a single session — login, tree, editor, autosave, pin, /pinned,
/settings/{profile,users,plugins}, /lenses, then unauth redirect — and
asserts no console errors and no `pageerror` events throughout. The
individual slice specs cover each feature deeply; this catches
cross-feature regressions that no isolated test can.

The dev server's webServer config wipes `data/e2e.db` and reseeds on
every run, so the test starts from the canonical "first user / welcome
space" state.

### Test counts

- Full suite after slice-40: **65 files / 460 tests** + **21/21 e2e**,
  typecheck clean, `npm run build` clean.
- (Slice-37 baseline was 63 files / 449 tests + 20/20 e2e.)

## Slice-41 — first-signup bootstrap race fix (post-build audit pass)

While inspecting the bootstrap service during the §9.4 / §7.2 audit
follow-up, the comment in `src/server/auth/config.ts` claimed that
`seedWelcomeSpace` was "race-safe — concurrent first sign-ups will not
duplicate the tree". The implementation contradicted the comment: the
idempotency check read `spaces.count` *outside* a transaction, then did
several non-transactional inserts. With `journal_mode = WAL` and
better-sqlite3's read-doesn't-block-read semantics, two concurrent first
sign-ups could both observe `count = 0` and both insert a "Welcome"
space. The post-build `.after` hook is awaited per sign-up, so a fresh
install hit by two simultaneous sign-ups (e.g. two operators clicking
sign-up at once on a freshly-deployed LAN host) ends up with two Welcome
spaces and two admins — the bootstrap "is idempotent" promise is a lie.

### Fix

Wrap the entire idempotency check + seed body in `db.transaction((tx) =>
…)` (`src/server/services/bootstrap.service.ts`). better-sqlite3
acquires the write lock at BEGIN and holds it for the duration, so a
second concurrent caller blocks on BEGIN until the first commits; by
then the count check inside the second transaction sees 1 and returns
null. Inlined the previously-async `makePage`/`makeBranch` helpers into
the transaction body (sync `.run()` calls on the `tx` object) so the
whole seed is one atomic unit.

### Regression test

`src/server/__tests__/bootstrap.integration.test.ts` now ends with a
test that fires two `seedWelcomeSpace(ownerId)` calls in `Promise.all`
against a hermetic fresh DB and asserts:

- exactly one returned a non-null `SeededSpace` (the other observed
  count=1 inside the transaction and returned null),
- `db.select().from(spaces)` has length 1.

Without the fix this test reliably produces `inserted.length === 2` (the
race is trivially reproducible — better-sqlite3 + WAL + an awaited-async
caller is enough). With the fix it consistently passes.

### Comment fix

`src/server/auth/config.ts`'s `.after` hook comment previously paraphrased
"the brief calls it acceptable to have two admins" — that paraphrase was
incorrect (the brief expects exactly one Welcome space), and the race
window is real, not theoretical. Updated to describe the actual
serialization mechanism (sync `db.transaction` + write lock).

### Test counts

- Full suite after slice-41: **65 files / 461 tests** (one new
  race-regression test; no other count delta). Typecheck clean,
  `npm run build` clean.

## Slice-42 — ReDoS defense for lens `titleRegex` (post-build audit pass)

The §12.4 lens feature lets a user persist `criteria.titleRegex`, which is
then evaluated against every page title by the JS-side SQLite REGEXP
function registered in `src/server/db/index.ts`. That function calls
`new RegExp(pattern).test(value)` synchronously per row inside
`runLens` / `runLensWithAttributes` — and `better-sqlite3` is single-
threaded, so a single pathological pattern freezes every other request
on the worker until the regex engine returns. Any authenticated user can
create a lens; any holder of an unlisted lens's share token can hit
`GET /api/lenses/:id/results` to trigger it. A fresh install that exposes
the lens routes is one POST away from a DoS.

### Vulnerability — reproduced

`^(a+)+$` (the canonical catastrophic-backtracking shape) is 9 chars;
running it against 28 `a`s + `X` under V8 took 13.7s in a quick
standalone test. Worse, page titles are unbounded, and lens patterns can
be up to 256 chars (the zod `max(256)`). There was no defense at any
layer — the comment in `db/index.ts` said "expected to be from a trusted
user (lens owner), but treat untrusted usage defensively" but the code
itself just compiled and ran whatever pattern it received.

### Fix — three independent gates

The defense is layered so a single regression can't reopen the hole:

1. **Route-level write gate** — `src/server/routes/lens.routes.ts`
   adds `safeRegexSchema = z.string().min(1).max(256).superRefine(...)`
   using `assertSafeRegex` from `src/server/utils/regex-safety.ts`.
   Applied to `criteriaSchema.titleRegex` in both `createSchema` and
   `patchSchema`. An unsafe pattern at create or patch returns **400**
   with `unsafe regex: <reason> (pattern: <pattern>)` in the zod error
   payload.

2. **Service-level run-time gate** — `src/server/services/lens.service.ts`
   declares `UnsafeLensRegexError` and the top of `runLens` re-checks
   `criteria.titleRegex` before touching SQLite. This catches legacy
   rows written before the route gate existed (imports, raw DB writes,
   future regressions). The route maps the thrown error to **400**.

3. **SQL function last line of defense** — `src/server/db/index.ts`'s
   registered `regexp` function re-checks the pattern per invocation
   before calling `new RegExp(pattern).test(value)`. Even if both
   higher layers are bypassed, the SQL function throws and the query
   fails loudly instead of hanging the worker.

### `assertSafeRegex` heuristic

Star-height–based bound plus a few sharper rejections. Star height = the
maximum nesting depth of quantifiers in the parsed AST; values > 1 are
the structural signature of catastrophic backtracking.

- `MAX_PATTERN_LENGTH = 256` (matches the zod cap).
- `MAX_QUANTIFIERS = 4` (well over any sane title matcher, well under
  any linear-but-long pattern that could cost noticeable time).
- Reject `(...)+` where `...` already contains a quantifier — the
  canonical `(a+)+` shape.
- Reject adjacent quantifiers `++`, `+*`, `*?`, etc.
- Reject backreferences `\1`…`\9` — they interact with outer-group
  repetitions in ways the star-height walk doesn't track, and title
  matching never legitimately needs them.
- Final `new RegExp(pattern)` compile to surface any syntax error the
  walker ignores.

Worst case the heuristic runs in O(n) over the pattern and rejects
`^(a+)+$` (verified by the unit tests). It is not a proof of safety
against all polynomial-time pathologies, but it makes the common
ReDoS shapes unwriteable while leaving ordinary title patterns
(`^meeting-\d+$`, `^(TODO|DONE)\b`, `[a-z]+`) intact.

### Tests

- `src/server/__tests__/regex-safety.test.ts` — **33 unit tests** over
  `assertSafeRegex` itself: every safe shape in the brief is accepted,
  every canonical ReDoS shape (`(a+)+$`, `(a+)+\1`, `(a*)*`, `(a+|b)+`,
  `++`, `+*`, `*?`, too many quantifiers, backreferences, empty / too-
  long / non-string / unclosed-group inputs) is rejected with a
  meaningful `reason`. Plus a sanity-check that the canonical `(a+)+$`
  actually backtracks under V8 (small input, fast test).
- `src/server/__tests__/lens.integration.test.ts` — added a
  `slice-42: titleRegex ReDoS gate` describe block:
  - 8 hostile patterns rejected at **POST /api/lenses** with 400.
  - 1 hostile pattern rejected at **PATCH /api/lenses/:id** with 400.
  - Defense-in-depth: a legacy row written via `createLens` with a
    hostile regex still throws `UnsafeLensRegexError` from `runLens`.
  - The SQLite `regexp` function itself throws `unsafe regex pattern`
    when invoked with a hostile pattern, and still returns 1 for a
    safe pattern (`^hello` against `hello world`).

### Files touched

- **new** `src/server/utils/regex-safety.ts` — `assertSafeRegex` helper
  + doc comment.
- **new** `src/server/__tests__/regex-safety.test.ts` — 33 unit tests.
- `src/server/db/index.ts` — import `assertSafeRegex`, gate the SQL
  REGEXP function, update doc comment.
- `src/server/services/lens.service.ts` — `UnsafeLensRegexError`
  exported; `runLens` re-checks before any DB I/O.
- `src/server/routes/lens.routes.ts` — `safeRegexSchema` wired into
  `criteriaSchema`; both results endpoints catch
  `UnsafeLensRegexError` and map to 400.
- `src/server/__tests__/lens.integration.test.ts` — slice-42 describe
  block with route + service + SQL-function coverage.
- `AGENTS.md` — this section.

### Test counts

- Full suite after slice-42: **66 files / 506 tests** (+1 file, +45
  tests: 33 regex-safety unit tests + 12 ReDoS gate integration tests
  over the lens route / service / SQL function). Typecheck clean,
  `npm run build` clean (only the pre-existing chunk-size warning).

## Slice-43 — admin-demote lockout race guard (deep-dive)

### Bug

`PATCH /api/users/:id` only checks self-lockout. Two admins can race:
A PATCHes B → admin demote; B PATCHes A → admin demote. Both pass
self-lockout (different targets). Without further guards, both can
succeed — depending on Node's event-loop interleaving — leaving **zero
active admins**. Recovering requires a direct DB surgery that the
brief explicitly does not want to require.

### Fix

Inside the route's PATCH handler, when the patch would *reduce the
active-admin count* (`isAdmin:false` or `suspended:true` on a target
who is currently `is_admin=1 AND suspended=0`):

1. Run `SELECT COUNT(*) FROM user WHERE is_admin=1 AND suspended=0`
   inside a `sqlite.transaction(...).immediate()` (BEGIN IMMEDIATE).
2. If the count is exactly `1`, the only remaining active admin is the
   actor (we just haven't been able to commit our patch to remove the
   target yet — the second writer of a race lands here). Throw a
   `LastAdminError` sentinel, mapped to **409 Conflict** in the route.
   The self-lockout guard (400) still covers the simple self-demote
   case.
3. Otherwise, the route's `UPDATE` proceeds.

Two subtle gotchas the inline comment captures:

- **Subtracting the target from the count looks correct but isn't.**
  A excludes B → sees 1 (itself), proceeds; B excludes A → sees 1
  (itself), proceeds; both commit, 0 admins remain. The right
  invariant is "would my commit leave zero?" — and "exactly 1 active
  admin" is the only pre-commit state from which any successful
  demote produces zero.
- **Default `BEGIN DEFERRED` is wrong here.** Our guard body is
  read-only (a `COUNT(*)`), so a deferred BEGIN acquires no write
  lock at all; both writers' count reads see the pre-race state.
  `BEGIN IMMEDIATE` (`sqlite.transaction(fn).immediate()`) grabs the
  lock at BEGIN so the second writer blocks until the first commits,
  then re-reads against the post-commit snapshot.

The race is also partially defended by the access middleware itself:
the suspended-user check (access.ts) re-reads the user table on every
request, so if A's commit lands before B's middleware runs, B's
middleware sees B as non-admin and rejects with 403 before reaching
the route. The 409 guard is the second line of defense for the case
where both middleware reads happen before either commit lands (a real
window in WAL mode + concurrent inject()).

### Files touched

- `src/server/routes/user.routes.ts` — added the
  `willRemoveActiveAdmin` short-circuit, `BEGIN IMMEDIATE` transaction
  with the count check, `LastAdminError` sentinel, 409 mapping, and
  the long inline rationale.
- **new** `src/server/__tests__/user.integration.test.ts` — 6 tests:
  bootstrap admin auto-promotion; self-demote 400; self-suspend 400;
  the new "does NOT false-positive on suspended-target demote" 200
  case; the safe-demote-when-other-admin-exists 200 case; the
  concurrent-race test that asserts at least one of `[200,403]`,
  `[200,409]`, `[409,403]` holds (never `[200,200]`) and that the
  post-race active-admin count is ≥ 1.

### Test counts

- Full suite after slice-43: **67 files / 512 tests** (+1 file, +6
  tests). Typecheck clean, build clean.

## Slice-44 — admin-tunable comment, plugin, and file upload caps

### Requirement

A common wiki app (Notion, Confluence, MediaWiki, DokuWiki, etc.) lets
an admin cap the size of comment bodies and plugin uploads so that
one runaway message can't OOM the server. The brief had
`commentBody` zod schemas pinned to a fixed ceiling and the @fastify
multipart `fileSize` ceiling at 25 MB (which buried both the file
upload cap and the plugin upload cap behind a single shared knob).
Slice-44 promotes all three to per-route, admin-tunable caps read
from `system_settings`, defaults chosen to match the pre-slice-44
behavior where applicable.

### Defaults

| Setting                       | Default | Clamp range        |
| ----------------------------- | ------- | ------------------ |
| `limits.commentBodyMaxBytes`  | 32 KB   | 1 KB .. 1 MB       |
| `limits.pluginUploadMaxBytes` | 50 MB   | 1 MB .. 500 MB     |
| `limits.fileUploadMaxBytes`   | 25 MB   | 1 KB .. 500 MB     |

The clamp ranges protect against admin typos (e.g. `value: 0` would
lock every comment to zero-width). Bogus values (`"not a number"`,
`null`, `{ weird: "shape" }`) silently fall back to the default.

### Wiring

`settings.routes.ts` exports a typed `getSystemSetting<T>(key,
fallback)` helper that reads the JSON-stored value and is shared
across all three routes. Each route then does its own narrow
numeric-clamp check before consuming the value, so the clamp range
is documented in the route (not in the generic settings helper).

- **comment.routes.ts** — `commentBodySchema()` is now `async` and
  reads the cap per request. `createThreadBody`, `addReplyBody`,
  and `editCommentBody` parse through the static schema first, then
  re-parse the `body` field through the size-capped schema so the
  custom 400 message reads
  `Comment body exceeds the configured limit (N characters)`.
- **plugin.routes.ts** — `POST /api/plugins` does a Content-Length
  pre-check before asking @fastify/multipart to buffer the body, then
  checks `mp.file.truncated` and the actual byte length after
  buffering, returning **413 Payload Too Large** with
  `{ error, declaredBytes, limitBytes }`.
- **file.routes.ts** — same pattern as the plugin route, default
  25 MB preserves the pre-slice-44 file upload cap exactly.
- **app.ts** — `@fastify/multipart` `fileSize` raised to 500 MB so
  the per-route plugin cap (which can go up to 500 MB) isn't blocked
  by the parser. The parser's ceiling is now an outer safety net, not
  the policy.

### Why also tweak files

Raising the multipart ceiling for the plugin cap broke the file
upload cap test (30 MB > 25 MB no longer 413'd). The clean fix is
parallel structure: a per-route file cap with the same default.
This is also more honest — a file is user content with a reasonable
ceiling, a plugin is admin-uploaded and can be larger.

### Tests

- **new** `src/server/__tests__/limits.integration.test.ts` — 17
  tests across three `describe` blocks:
  - **comment body cap** (9 tests): rejects oversize on thread /
    reply / edit; accepts exactly-at-cap; admin can lower the cap
    to 2 KB and the new oversize is rejected with the new cap in
    the message; bogus stored values (string, sub-clamp, super-
    clamp) are ignored and the default applies.
  - **plugin upload cap** (4 tests): small zip accepted (downstream
    rejects fake bytes, not 413); oversized Content-Length rejected
    with 413 and the response carries `limitBytes`; bogus values
    fall back to default.
  - **file upload cap** (4 tests): 30 MB rejected at the default 25
    MB cap; small file accepted; admin can raise the cap to accept
    30 MB; bogus stored value falls back to default.

Two test-environment gotchas the file's inline comments capture:

- **Module-level DB singleton.** `getDb()` returns a cached
  `state` object; the env-var dance in `freshDbPath()` only takes
  effect on the first import. Across `describe` blocks in this file
  the DB is shared, so the only auto-promoted user is the very
  first signup. Each subsequent describe promotes its own user
  via `db.update(users).set({ isAdmin: true, suspended: false })`
  before exercising admin routes.
- **Multipart needs a real boundary.** Sending raw bytes with
  `content-type: application/zip` is rejected by @fastify/multipart
  with 415 before the route runs. The test builder concatenates a
  proper multipart envelope (see `plugin.integration.test.ts` for
  the original pattern).

### Files touched

- `src/server/routes/settings.routes.ts` — exported the
  `getSystemSetting<T>(key, fallback)` helper.
- `src/server/routes/comment.routes.ts` — `commentBodySchema` is
  async; all three comment endpoints re-validate the body field
  through the dynamic cap.
- `src/server/routes/plugin.routes.ts` — `POST /api/plugins` enforces
  the configured plugin cap with Content-Length pre-check +
  post-buffer check + `mp.file.truncated` handling.
- `src/server/routes/file.routes.ts` — same pattern as
  plugin.routes.ts, default 25 MB.
- `src/server/app.ts` — raised the @fastify/multipart `fileSize`
  ceiling to 500 MB so the plugin cap can go that high.
- **new** `src/server/__tests__/limits.integration.test.ts` — 17
  tests.
- `AGENTS.md` — this slice entry.

### No external deps

`getSystemSetting` is built on the existing `system_settings` table
and the existing `drizzle` read; no new packages.

### Test counts

- Full suite after slice-44: **68 files / 529 tests** (+1 file,
  +17 tests). Typecheck clean, build clean. Only the pre-existing
  large-chunk-size warning remains.

## Slice-45 — markdown import XSS (link href + image src)

### Probe results (before the fix)

The deep-dive audit ran a probe script against `markdownToTiptap` with
known XSS payloads. Findings:

| Payload                          | Pre-fix output                              | Risk       |
| -------------------------------- | ------------------------------------------- | ---------- |
| `[click](javascript:alert(1))`   | `href: "javascript:alert(1"` (truncated)    | CRITICAL   |
| `[click](  JAVASCRIPT:alert(1)  )` | `href: "javascript:alert(1"`               | CRITICAL   |
| `[click](\tjavascript:alert(1))` | `href: "\tjavascript:alert(1"`              | CRITICAL   |
| `[click](data:text/html,<script>)` | `href: "data:text/html,<script>"`          | CRITICAL   |
| `[click](vbscript:msgbox(1))`    | `href: "vbscript:msgbox(1"`                 | LOW        |
| `[secret](file:///etc/passwd)`   | `href: "file:///etc/passwd"`                | LOW        |
| `![alt](javascript:foo)`         | `src: "javascript:foo"`                     | HIGH       |
| `![alt](data:text/html,<x>)`     | `src: "data:text/html,<x>"`                 | MEDIUM     |
| `<script>alert(1)</script>`      | literal text node                           | SAFE       |

### Why this wasn't a zero-day

There were already three defensive layers downstream of the parser:

1. `safeLinkHref` in `src/shared/blockIds.ts` (the one in
   `validateContent` is called at persist time).
2. `validateContent` neutralizes link hrefs before persisting.
3. `ReadOnlyContent` calls `safeLinkHref` again at render time.

So a `javascript:` href that made it through the parser would be
neutralized to `#` before the bytes hit the DB and again before
they hit the DOM. But:

- Image src had **no sanitizer anywhere** (the only image sanitizer
  would have been `safeLinkHref`, which doesn't apply to images).
- The in-memory Tiptap doc between parse and persist carried the
  dangerous URL, exposing it to autosave/draft paths and any future
  reader that bypasses `validateContent` (a hand-edited DB row, an
  export-to-another-format route, etc.).
- The whole "neutralize at every layer" approach is fine in
  isolation, but it's brittle: a future renderer that forgets the
  `safeLinkHref` call is a one-line regression away from stored XSS.

### The fix (defense in depth at the parse layer)

- `src/shared/blockIds.ts` exports `safeImageSrc(src)` — a stricter
  sibling of `safeLinkHref`. Allows http/https/relative/anchor,
  blocks javascript/vbscript/data/file. Returns `""` (not `"#"`)
  because `<img src="#">` is a worse UX than `<img src="">`.
- `validateContent` now walks `image` nodes and sanitizes their
  `attrs.src` exactly the way it walks `link` marks (replaces with
  safe value + records an error).
- `markdown.service.ts`:
  - `parseInline` link branch now wraps the URL in `safeLinkHref`.
  - `parseInline` image branch drops the image node entirely when
    `safeImageSrc` returns `""` (no zombie placeholder), then
    advances past the `![alt](...)` syntax.
  - Standalone-image branch does the same drop-and-advance.

### Why drop the image instead of neutralizing the src

An empty src on an image is honest — the browser renders a broken
image, and any future renderer sees "no source, no render". A src
of `"#"` is misleading — it's a syntactically-valid URL that
points to the current document fragment; some renderer might try to
follow it.

### Why keep the link text when the href is neutralized

For links, the text is the user's content (the words they chose).
Stripping the text along with the dangerous URL hides their content
for a UX-recovery reason. The link mark survives with `href="#"`:
visible as a styled link, click is a no-op.

### What did NOT need fixing

- Raw HTML in text/headings/code blocks: the markdown parser does
  not pass through HTML; it stays as a literal text node. Tiptap
  renders text nodes as escaped text. No XSS surface.
- Frontmatter title: consumed only by `splitFrontmatter` for diff
  display and SSG page titles. Never rendered as HTML.

### Tests

- **new** `src/server/__tests__/markdown-xss.test.ts` — 20 tests
  across three `describe` blocks (link href, image src, raw HTML
  inertness). Probes every XSS payload from the table above plus
  the safe-preservation cases (https, relative, mailto).
- **new tests in** `src/shared/__tests__/blockIds.test.ts` — 5
  `safeImageSrc` tests + 2 `validateContent` image-sanitization
  tests.

### Files touched

- `src/shared/blockIds.ts` — added `safeImageSrc`; extended
  `validateContent` walk to sanitize `image` nodes' `attrs.src`.
- `src/server/services/markdown.service.ts` — added
  `safeLinkHref` + `safeImageSrc` calls in `parseInline` link /
  image branches and the standalone-image branch.
- `src/shared/__tests__/blockIds.test.ts` — added 7 tests.
- **new** `src/server/__tests__/markdown-xss.test.ts` — 20 tests.
- `AGENTS.md` — this slice entry.

### Test counts

- Full suite after slice-45: **69 files / 554 tests** (+1 file,
  +25 tests). Typecheck clean, build clean.

## Slice-46 — plugin command engine injection audit (deep-dive)

### Findings

The plugin loader, dispatcher, and server-route guards were already
strong (hooks dispatch is per-handler try/catch, plugin failures
auto-disable past the threshold, server routes mount under the
on-route `config.access` fail-closed check, plugin id is regex-
bounded, install extracts to a tmp dir with `..` segment rejection
and a per-zip total-size cap). What was missing was **client-side
registry validation**: every `register*()` accepted any input.

| Vector | Pre-fix behaviour | Risk |
| ------ | ------------------ | ---- |
| `registerEmbedType({ name: "image" })` (or any other core node that falls through to the `default:` branch in `BlockNode`) | Renderer fires for every instance of that type across every page. EmbedMap is keyed by name. | **High** — full takeover of image / table / taskList / details\* rendering. |
| `registerEmbedType({ name: "X" })` then again from a second plugin | Both pushed to `embedTypes` array; the map only retains the last `Map.set` entry. | **Medium** — silent overwrite, neither plugin author sees the bug. |
| `registerSlashCommand({ name: ... })` ditto for toolbar / settings ids | Same silent overwrite pattern for slash menu filtering. | **Medium** — confusing UX, not a privilege issue (plugins can't escalate each other). |
| Unbounded `label` / `icon` / `keywords` | A plugin could push MBs through the registry into the slash menu's `<span>` and toolbar button label. | **Low** — React renders text safely, but the data path is unbounded. |
| `run(editor)` / `onPress(editor)` callbacks | Plugin gets the live editor; this is the design intent (extension point). | **Not a vector** — plugins are the trust boundary; admins choose what to install. |

The path-traversal surface through `getPluginDir(pluginId)` was
also re-audited but found safe — every public entry point
(`installPluginFromZip`, `setPluginEnabled`, `uninstallPlugin`,
`registerPluginServerRoutes`, `registerPluginHookHandlers`, the
`/plugins/:id/client/index.js` static serve, the `loadPluginHookModule`
re-load) either validates the id against the manifest regex at
install time or looks up the row in the `plugins` table before any
filesystem operation. Re-enabling protection by validating the slug
at every entry point is documented as defense-in-depth but not
implemented in this slice — the database row IS the gate.

### Fix — client-side registry validation (§src/plugins/registry.ts)

Every `registerSlashCommand` / `registerToolbarItem` /
`registerSettingsPanel` / `registerEmbedType` now:

1. Rejects a name / id that doesn't match its identifier shape
   (`/^[a-z][a-z0-9-]{0,31}$/` for slash commands; `/^[a-zA-Z][a-zA-Z0-9-_]{0,63}$/`
   for the rest). Throws a clear error.
2. Rejects a name that collides with `KNOWN_BLOCK_TYPES ∪ KNOWN_INLINE_TYPES`.
   `registerEmbedType` is the highest-impact one because of the
   embed-name lookup in the read-only renderer. Slash commands also
   guard against collisions for the lowercase single-word cores
   (`paragraph`, `blockquote`, `image`, `table`, `details`, `text`,
   `mention`).
3. Rejects duplicates with a loud `"… is already registered"` throw
   instead of letting `Map.set` silently overwrite. Loud > silent for
   plugin interop errors.
4. Caps `label` length at 80 chars; `keywords` count at 16 and each
   keyword at 32 chars.

`coreCommands.ts` now swallows the "already registered" throw for the
mermaid command when called a second time in the same page-load so
tests can drive boot twice without a regression — production's
`if (_loaded) return;` guard in `loadPlugins` already prevents double
calls, but the per-command guard is the robust fallback for HMR /
MPA-style re-init scenarios.

`registerTiptapExtension` is left unvalidated — Tiptap itself
rejects extensions whose schema collides with an existing one during
editor construction, and the `AnyExtension` shape is opaque to us.

A test-only `resetRegistryForTests` export wipes the registry arrays
so describe blocks can pin a clean slate. Production never calls it.

### Tests

- **new** `src/plugins/__tests__/registry-validation.test.ts` —
  19 tests across five `describe` blocks:
  - `registerEmbedType` (6) — every KNOWN_BLOCK_TYPES / KNOWN_INLINE_TYPES
    name rejected; valid names accepted; duplicates rejected;
    malformed / oversized names rejected; label cap enforced.
  - `registerSlashCommand` (4) — collision (filtered to names that
    also pass the slash-command shape, e.g. `image` / `table` /
    `paragraph` / `details` / `text` / `mention`) rejected;
    duplicates rejected; malformed names rejected; keyword count and
    length caps enforced.
  - `registerToolbarItem` (3) — duplicates rejected; malformed ids
    rejected; label caps enforced; multiple distinct items accepted.
  - `registerSettingsPanel` (3) — duplicates rejected; malformed
    ids rejected; multiple distinct panels accepted.
  - First-party mermaid command still passes (3) — `registerCoreCommands`
    idempotent across two consecutive calls.

The existing `coreCommands.test.ts` (3 tests) still passes — the
mermaid command metadata (`name: "mermaid"`, `label: "Mermaid
diagram"`, `keywords: ["diagram", "chart", "flow", "graph",
"sequence"]`) is all within the new caps.

### Files touched

- `src/plugins/registry.ts` — added `SLASH_NAME_RE`, `IDENT_RE`,
  `RESERVED_NAMES`, `assertShape`, `assertLabel`, `assertKeywords`,
  wired into the four `register*` functions. Added
  `resetRegistryForTests` test-only export.
- `src/plugins/coreCommands.ts` — wraps the mermaid registration in
  a try/catch that swallows only the "already registered" error.
- **new** `src/plugins/__tests__/registry-validation.test.ts` — 19
  tests.
- `AGENTS.md` — this slice entry.

### No external deps

### Test counts

- Full suite after slice-46: **70 files / 573 tests** (+1 file,
  +19 tests). Typecheck clean, build clean (existing large-chunk
  warning only, unrelated to this change).


## Slice-47 — first-boot landing + recovery command

### Why this slice exists

Two related defects came out of the §11.6 bootstrap re-verification:

1. **No recovery command for an unseeded install.** Slice-18's
   `databaseHooks.user.create.{before,after}` auto-seeds the Welcome
   space inside better-auth's create-user path. The bootstrap comment
   in `src/server/auth/config.ts` also says "the next-boot sweep
   (manual `npm run seed-welcome`) can repair an empty install" — but
   no such command existed. An install with a user (e.g. from a direct
   SQL insert or a future non-better-auth provider) but no Welcome
   space had no documented fix.

2. **First user never actually saw the seed.** Before this slice,
   `/` (`src/routes/_authenticated/index.tsx`) rendered a slice-1
   "Knowledge Base" placeholder. The Welcome space was correctly in
   the DB, but the first admin had to manually click around to find
   it — directly contradicting the slice-18 promise "Land in a
   working wiki with the §11.6 fixture."

Both defects were uncovered by the re-verification pass; this slice
fixes both.

### What changed

- **new** `scripts/seed-welcome.ts` + `package.json` `"seed-welcome":
  "tsx scripts/seed-welcome.ts"`. The recovery command:
  - Opens the configured DB (`DB_PATH` env, same as the server).
  - Errors non-zero with a clear message if there are no users.
  - Picks the most recent admin (falls back to the first user) as
    the seed target.
  - Calls the existing `seedWelcomeSpace(ownerId)`. Idempotent:
    exits 0 with "already exists" when any space is present.
- **`src/routes/_authenticated/index.tsx`** — replaced the slice-1
  stub with a real landing page:
  - Fetches `/api/spaces` once on mount.
  - If exactly 1 space and its tree loads, auto-redirects to
    `/w/$branchId` of the first branch (the Welcome page after a
    fresh install).
  - If 2+ spaces, renders a list and lets the user choose.
  - If 0 spaces, renders an empty state with a button to
    `/settings/spaces` to create the first space.
- **new** `src/features/home/homeRedirect.ts` + companion tests —
  the redirect decision lives in a pure helper so it stays unit-
  testable without a DOM. The route just asks the helper "should I
  redirect, and where?" and acts accordingly.

### Why extract the helper

The route uses `useQuery` + `useNavigate` (TanStack Router) +
`useEffect` — all DOM- and router-bound. To keep the branch-decision
logic unit-testable without booting a DOM (the project's Vitest
config is `environment: "node"`), the rules live in
`homeRedirectTarget(spaces, tree) → { branchId } | null`. The route
calls it once both queries have resolved and navigates if it
returned a target.

### Tests

- **new** `src/features/home/__tests__/homeRedirect.test.ts` — 6
  tests:
  - redirects with exactly one space + non-empty tree
  - null with zero spaces (empty state) — three sub-cases (`[]`,
    `null`, `undefined`)
  - null with 2+ spaces (list view)
  - null when the only space has an empty tree (avoids 404)
  - returns the FIRST top-level branch, not the last
  - null with both `undefined` (initial loading state)
- **new** `src/server/__tests__/seed-welcome-cli.test.ts` — 3 tests
  driven via `child_process.execFileSync("npx tsx scripts/seed-welcome.ts")`:
  - exits non-zero with the "no users in DB" message when the DB
    is empty
  - seeds the §11.6 fixture when a user exists but no Welcome
    space does (the actual recovery scenario)
  - is idempotent: re-running reports "already exists" without
    duplicating the space
- Existing `src/server/__tests__/bootstrap.integration.test.ts`
  (4 tests, including the slice-41 race regression) and
  `src/server/__tests__/auth.integration.test.ts` (5 tests) still
  pass — the §11.6 bootstrap path itself was already correct; this
  slice only addresses the operator recovery story and the user-
  visible landing behavior.

### Files touched

- **new** `src/features/home/homeRedirect.ts`
- **new** `src/features/home/__tests__/homeRedirect.test.ts` (6 tests)
- **new** `scripts/seed-welcome.ts`
- **new** `src/server/__tests__/seed-welcome-cli.test.ts` (3 tests)
- `src/routes/_authenticated/index.tsx` — replaced slice-1 stub
  with the real landing page that uses the new helper.
- `package.json` — added `"seed-welcome": "tsx scripts/seed-welcome.ts"`
  to match the comment in `src/server/auth/config.ts`.
- `AGENTS.md` — this slice entry.

### No external deps

### Test counts

- Full suite after slice-47: **72 files / 582 tests** (+2 files,
  +9 tests). Typecheck clean, build clean (existing large-chunk
  warning only, unrelated to this change).

## Slice-48 — comment threads: transactional integrity + per-page cap

The slice-47 bootstrap-recovery work was the last must-have on the
broad-bug-recheck pass; this slice adds one more required
admin-tunable cap (per-page thread count) and hardens the comment
write paths that the audit flagged as having stale-read races.

### What's here

- **Per-page comment thread cap** (default 1000, Confluence tier) is a
  new admin-tunable setting, `limits.commentThreadsPerPageMax`,
  read on every POST and clamped to `[1, 50_000]`. A 409 is returned
  once a page hits the cap. Default 1000 matches Confluence;
  Notion-style "unlimited" was rejected because the comments panel
  becomes unscrollable at thousands and a single page becomes a
  write-amplification hot spot on every refetch.
- **Atomic thread creation.** The create-thread handler used to do
  `insert(thread); insert(firstComment)` as two separate awaits. An
  interrupted request (process kill mid-handler, client cancel after
  the thread insert but before the comment insert) would leave an
  orphan thread with no first comment — visible in the UI as a
  thread with no messages. The two inserts now live inside a single
  `db.transaction` so either both commit or neither does.
- **Atomic delete cleanup.** The delete-comment handler used to do
  `delete(comment); select(remaining); maybe-delete(thread)` as three
  separate awaits. A concurrent reply racing the select could make
  `remaining.length === 0` stale — the thread would then be deleted
  underneath the newly-arrived reply. The three ops now live inside
  one `db.transaction` so the reply either lands before or after the
  cleanup, not between.

### Files

- `src/server/routes/comment.routes.ts` — read cap + two tx wraps.
- `src/server/__tests__/comment-threads.integration.test.ts` — new;
  4 tests (atomic create, cap rejection on (cap+1)th, garbage-cap
  fallback to default, last-comment deletion cascades to thread).

### Non-goals

- No upper bound on replies-per-thread (Discord tier; unbounded and
  human-rare). The cap on per-page thread count covers the worst case.
- No soft delete. Hard delete keeps the schema simpler; the
  `onDelete: cascade` on `comments.threadId` is the only delete path.
- No rate limiting. That's a separate slice if needed.

### Test counts

- Full suite after slice-48: **73 files / 586 tests** (+1 file,
  +4 tests). Typecheck clean, build clean (existing large-chunk
  warning only, unrelated to this change).

