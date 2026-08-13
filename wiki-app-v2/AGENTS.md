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
