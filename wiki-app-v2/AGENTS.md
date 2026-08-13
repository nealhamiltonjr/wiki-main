# wiki-app-v2 — agent notes

## Commands (run from repo root)

- `npm run typecheck` — `tsc --noEmit` (strict; unused vars fail the build)
- `npm run test` — vitest, **sequential** (`fileParallelism: false` — integration
  tests share the `data/` dir and a single lazy SQLite connection per worker)
- `npm run e2e` — Playwright (8 specs)
- `npm run build` — typecheck + vite build (SSR via `vite dev`; server entry is
  `src/server/index.ts`)

## Architecture

- React 19 + TanStack Router client; Fastify server (`src/server/app.ts`).
- **Single SQLite connection** (`src/server/db/index.ts`), lazily created on the
  first `getDb()` call; `DB_PATH` env selects the file. Set `process.env.DB_PATH`
  **before any import of `getDb`/services** or the singleton locks onto the
  default path. Migrations run automatically on first connect (`drizzle/`).
- Git content repo lives at `./data/repo` (`GIT_REPO_ROOT`); `initGitRepo()`
  must run before any commit (worker loop starts in `src/server/index.ts`).
- Slice-10 flush pipeline: save/rename/snapshot → `enqueueJob("git_commit")` →
  `processPendingJobs()` (polled by `startWorkerLoop`) → `commitPageChange` /
  `commitManualSnapshot` writes `<spaceSlug>/<pageSlug>.md` + frontmatter and
  commits. History/restore read the same repo via `git log --grep page:<id>:`.

## Slice-10 invariants (verified — do not regress)

- **Slug is a git file path.** Both create and rename validate
  `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$` (no `/`, `..`, no leading `-`/`.`).
  `commitPageChange` also falls back to `"space"` when a space name slugifies
  to empty. A traversal slug used to write a file **outside the repo** (CWE-22).
- **Rename must enqueue a commit** — `renamePage` only writes the DB; without
  the explicit `enqueueJob` after it, the git tree keeps the old `<slug>.md`.
- **Restore is forward-moving**: it reads a commit's markdown, converts back to
  Tiptap, `ensureBlockIds`, then `savePageOCC` (new version + new commit). It
  never rewrites history. `commitHash` is validated `/^[0-9a-f]{6,40}$/i` so
  it can't be passed to git as an option.
- **Invalid content is never flushed**: unknown node types → 422 before any
  enqueue (auto-repairable errors are logged and saved repaired).
- **Commit queue**: single-threaded worker, 10 jobs/pass, exponential backoff
  (`min(2^attempts*1000, 60000)`), max 5 attempts → `failed`. `processPendingJobs`
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
  instead of clearing it — the previous unconditional clear dropped keystrokes
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
  then `rename()`s it into place. `rename` can throw EXDEV across devices → the
  fallback is `cp -r` + `rm -r`. Never `rm(tmpDir, { force: true })` without
  `recursive: true` — EISDIR, and it made every upload 500.
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
  `(fastify, opts, done)` — never mix `async` plugin functions with `done`.
- Plugin routes are served at `/api/plugins/<id>/...` (serverRoutes) and client
  bundles at `/plugins/<id>/client/index.js` (validated id, JS content-type,
  `Cache-Control: max-age=300`). Vite proxies `/plugins` → Fastify in dev.
- **Slash-menu query/range bug (fixed):** the menu captured `range.from` when "/"
  was typed, but when an ATOM node sits at the insertion point (e.g. a draw.io
  embed at doc position 0) ProseMirror inserts the "/" AFTER the atom, so the
  query included the leading "/" (filter matched nothing) and execute() would
  mis-delete. `computeSlashQuery` now derives query + range from the caret's text
  block on every doc change (line-start / after-whitespace ⇒ block text is
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
  "Installed! Reloading…" and calls `window.location.reload()` immediately; the text
  often never renders. Wait for the post-reload table instead.
- **`/` only opens the slash menu at line start / after whitespace.** After earlier
  specs have typed into a page, clicking the editor center lands mid-text; press
  `Control+Home` first (or use a page no other spec edits).
- **Parallel workers share the welcome page's collab doc.** `editor.spec` /
  `slice9.spec` edit "welcome" concurrently, and their collab round-trips re-render
  the editor mid-interaction (eats keystrokes/Enter). Any spec that needs a quiet
  editor should use the seeded "notes" page.

## Slice-15 / theming architecture (§5)

- **Single token source: `src/styles/tokens.css`.** Every color, radius, font,
  shadow, and animation value the app renders is defined here under `:root`
  (light defaults), `[data-theme="dark"]`, and `[data-theme="contrast"]`. No
  other file holds a literal color (`#…`, `rgb(…)`, `hsl(…)`) or a Tailwind
  named-color utility (`text-rose-600`, `bg-emerald-500/10`, etc.). The
  `:root` block owns non-color tokens (typography, radii, shadows, timing,
  borders widths, chrome dimensions) — themes override colors only.
- **The `@theme inline { … }` block lives at the bottom of `tokens.css`.**
  It aliases every canonical token into Tailwind's utility namespace
  (`--color-primary: var(--primary)`, `--shadow-lg: var(--shadow-lg)` …),
  so `bg-primary`, `text-danger`, `border-surface`, `shadow-md` etc.
  resolve directly to the canonical var. `app.css` only contains
  `@layer base` rules (shadcn var remapping, prose) — no `@theme`.
- **Token budget:** ~70 colors (light/dark/contrast), 10-radius scale,
  3 font stacks, 4 shadow levels, 3 timing tokens (`--duration-fast` /
  `--duration-normal` / `--duration-slow`) + `--ease-default`,
  chrome dimensions (`--topbar-height`, `--sidebar-width`,
  `--settings-nav-width`, `--prose-width`).
- **Caret colors (`--user-color-0` … `--user-color-9`) are defined per
  theme** because they're identity colors — kept stable across themes on
  purpose. JS reads them at runtime via `getComputedStyle(documentElement)`
  in `useCollab.userColor()`; the palette array was deleted from the file,
  no literal colors in JS.
- **Component-code sweep:** `useCollab.ts`, `Editor.tsx`,
  `FavoriteButton.tsx`, `CommentsPanel.tsx`, `extensions/MermaidRenderer.tsx`,
  `routes/_authenticated/settings/plugins.tsx` were migrated off named-color
  utilities onto the new `success` / `warning` / `danger` / `info` /
  `text-muted` tokens.
- **Enforcement test:** `src/styles/__tests__/theme.test.ts` has three
  checks — (1) no literal colors outside `tokens.css`/`app.css`, (2) every
  `var(--…)` reference resolves to a definition, (3) light/dark/contrast
  define the same color-role set. Run as part of `npm test`; adds 3 tests
  to the suite (211 total).

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
