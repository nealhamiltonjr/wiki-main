# Wiki App — AGENTS.md

Git-based wiki with admin/settings UI, git push/pull/sync, clean Markdown
export, real-time collab (Hocuspocus/Yjs), group/space permissions. See
`../PROJECT-OVERVIEW.md` for the full spec and phase tracking.

## Commands

- `npm run dev:server` — API + WebSocket on :3000 (`tsx watch`)
- `npm run dev:client` — Vite on :5173 (proxies /api to :3000)
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest (18 files, 149 tests)
- `npm run build:client` — vite build
- `npx playwright test --config=e2e/playwright.config.ts` — E2E tests (5 tests, headless Chromium)

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
  attributes, collab toggle), `CommandPalette.tsx` (Cmd+K global search),
  `NotificationBell.tsx` (bell icon + dropdown feed), `wikiLinkExtension.tsx`
  ([[page]] linking — currently disabled, see Known Issues), `slashCommandExtension.tsx` (/slash commands).

## Known issues

- **WikiLinkExtension causes ProseMirror crash** (`t.getState is not a function`)
  in production (Vite-built) builds. The extension uses `@tiptap/suggestion`
  with `ReactDOM.createRoot` for the popup. The error occurs during editor
  creation in the built JS bundle. Commented out in Editor.tsx extensions array
  until debugged. Does NOT reproduce in dev mode (`npm run dev:client`).

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

**Running:** `npx playwright test --config=e2e/playwright.config.ts`
Clean state each run: delete `data/e2e-test.db`, `data/e2e-repo`,
`data/e2e-files`, and `e2e/auth-*.json` before running.

**Key decisions:**
- Users are seeded via the REST API (`POST /api/auth/sign-up/email` with
  Origin header) rather than through the browser UI — much faster and avoids
  flaky UI-based registration
- Tests navigate to `/pages/${branchId}` directly (using `getFirstBranchId()`
  which calls the spaces/tree API) instead of clicking tree labels — tree
  click navigation via React Router's `navigate()` was unreliable in tests

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
