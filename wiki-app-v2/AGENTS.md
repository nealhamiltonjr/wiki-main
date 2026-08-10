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
