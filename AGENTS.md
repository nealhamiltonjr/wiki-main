# AGENTS.md — workspace knowledge

Monorepo workspace: old reference app (`wiki-app/`, snapshot.3) and the rebuild
(`wiki-app-v2/`, branch `rebuild-v2`) per `WIKI-REDESIGN-BRIEF-V2.md`.

## Build/test commands (rebuild)

From `wiki-app-v2/`:
- `npm run typecheck` — `tsc --noEmit`
- `npm run test` — vitest (server unit + integration, node env, `fileParallelism: false`)
- `npm run e2e` — Playwright (slice-1 gate)
- `npm run dev` — Vite on :5173; `npm run dev:server` — Fastify API on :3000
- `npm run db:generate` — drizzle-kit generate; committed SQL under `drizzle/`,
  auto-applied at server boot via `migrate()` (idempotent)

## Key invariants / gotchas (all learned the hard way)

- **Single SQLite connection** (§3.2): only `src/server/db/index.ts` calls
  `new Database(...)`. Lazy-init via `getDb()`; `DB_PATH` env must be set before
  the first import chain touches it (tests set it at file top before dynamic
  `import("../app.js")`).
- **Drizzle schema shape**: pass a FLAT object to `drizzle(sqlite, { schema })`
  — never a namespace import wrapped in `{}`. Vite SSR creates null-prototype
  namespace objects; drizzle's `is()` crashes on `Object.getPrototypeOf(null)`.
  Spread the namespace (`{ ...authSchema }`) so `instanceof` short-circuits.
  better-auth's `drizzleAdapter` reads `schema[model]` directly, so the raw
  namespace is fine there.
- **better-auth**: `baseURL` must be explicit (old app got a 500 instead of 401
  through the Vite proxy). `trustedOrigins` includes `192.168.*:*` intentionally
  (Docker host-network). `rateLimit` must be `enabled: true` explicitly.
  `session.cookie` name is `better-auth.session_token`. `user` additionalFields
  `isAdmin` + `suspended` are `input: false`.
- **Every /api/ route** must set `config.access` or boot refuses (onRoute hook
  in `src/server/middleware/access.ts`; throws synchronously at registration).
  Auth routes `/api/auth/*` are the explicit exception.
- **Security headers** live in `src/server/security.ts` onSend hook (CSP with
  `style-src 'self' 'unsafe-inline'`, never inline script; nosniff; frame
  DENY; referrer same-origin). Inline script remains impossible by design.
- **Error handler** (app.ts): ZodError → 400, 4xx keeps its status, else logged
  500 with no internals leaked.
- **Server tests**: vitest `environment: node`, `fileParallelism: false`,
  `exclude: ["e2e/**"]`. Use Fastify `.inject()`; no network port.
- **better-auth rate limiter**: sign-in/sign-up paths have HARD-CODED stricter
  limits inside better-auth (3 req/10s) that ignore `rateLimit.max`. To burst
  in tests set `BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES='{"/sign-up/*":false,"/sign-in/*":false}'`
  (path is the basePath-stripped route, e.g. `/sign-up/email`). Wired into
  `auth/config.ts` — production unaffected without the env var.
- **Seeding a real sign-in-able user** (`scripts/seed-e2e.ts`): better-auth
  stores the credential password on the `account` row (`providerId:
  "credential"`, `accountId = userId`), NOT on the `user` row. The table is
  re-exported from schema.ts as `identities`. Use `hashPassword()` from
  `better-auth/crypto` (it uses the same hash as sign-in). Idempotency: delete
  the user's `spaces` first (cascade → branches → pages/attributes), then the
  user row.
- **Playwright e2e boots the full stack**: `playwright.config.ts` has an ARRAY
  of webServers — Vite (:5173) and an API command that wipes `data/e2e.db`,
  runs `scripts/seed-e2e.ts`, then boots Fastify (:3000). No globalSetup
  needed; env vars are inlined in the command string.
- **react-arborist sizing**: the tree container MUST be a `flex:1;
  min-height:0; overflow:auto` box (`.wiki-tree`) or the virtualizer gets a
  sliver of height and silently drops nodes (e.g. a second root never renders).
  Also: node labels carry the page's icon emoji, so e2e must assert with
  `getByRole("treeitem", { name: /slug/ })`, not `getByText(slug, {exact:true})`.
- **Deps**: better-sqlite3 pinned to ^12.10 (v13 broke better-auth peer dep).
  `npm audit` shows 5 moderate esbuild advisories — dev-tooling only
  (drizzle-kit's CLI chain), not runtime-reachable.

## Slice-10 code audit (fixed)

Cross-boundary data leaks and hardening found in a full-code audit and fixed:
- **FILES_ROOT** (`file.service.ts`) was one directory too high; now derived
  from `import.meta.url` + relative path to `data/files`.
- **Backlink/placement leaks**: a page cloned into a restricted space leaked
  the hidden placement's slug (page GET `placements`), and backlinks leaked
  source-page slugs/titles the caller couldn't open. `getPageBacklinks` now
  takes `user` and filters sources via `canViewPage`; the page GET filters
  placements per-branch; `/api/pages/:pageId/backlinks` 404s for inaccessible
  targets. Use `canViewPage(user, pageId)` for page-level visibility
  (admin→true, null→only anonymous-visible public chains, else any placement
  the user can resolve).
- **Favorites**: toggle now requires branch `viewer` (declarative
  `branchParam` access), and the list endpoint drops favorites whose branch is
  no longer readable.
- **Suspended creators' tokens**: middleware rejects bearer tokens whose
  creator is suspended (was only checked for session principals).
- **Link-scheme XSS**: `safeLinkHref` (shared/blockIds.ts) neutralizes
  `javascript:`/`data:`/`vbscript:`; wired into `validateContent` (repairs on
  save, logs error) and the read-only renderer in `$branchId.tsx`.
  `@tiptap/extension-link` `isAllowedUri: () => true` is intentional — the
  server sanitizer is the boundary.
- **`GET /api/spaces`** now includes spaces whose `defaultRole` is
  `editor`/`viewer` (implicit grant via `resolveSpaceRole`).
- **FK 500s**: clone validates target space exists (404), space members and
  group-grants validate user/group existence (404) instead of raw SQLite FK
  errors.
- **NotificationBell badge** uses `/api/notifications/unread-count` — the list
  caps at 50 so its inline unread undercounts.
- **Client route reuse**: `/w/$branchId` is ONE route match reused across
  branch params. Stale CommentsPanel threads/FavoriteButton state persisted
  across navigation. Fix: reset editMode/showComments/livePage on branchId
  change, key `PageHeader` + `CommentsPanel` by `page.branchId`, and feed
  `FavoriteButton` an `initiallyFavorited` derived from `listFavorites()`.

Regression coverage: `src/server/__tests__/audit-fixes.integration.test.ts`
(9 tests) + `safeLinkHref` unit tests in `src/shared/__tests__/blockIds.test.ts`.

## Slice status

1. Skeleton — done (commit e6155bf)
2. Server foundation — done (commit 2dc699a): Fastify skeleton, single DB
   module, better-auth (explicit rateLimit/trustedOrigins), security headers,
   access-declaration boot refusal, in-memory limiter helper. Gate test:
   signup → login → session via `.inject()`.
3. Schema + permission algorithm — done: pages/branches/spaces/groups,
   `resolveAccess` ported with the original test suite unmodified.
4. Client integration — done: auth/API clients, Login, react-arborist tree
   sidebar, session-gated layout, space/tree routes + permission middleware +
   services, seed script, dual-webServer Playwright (2 specs). 24 unit +
   integration tests, typecheck, client build, and e2e all green.
5. Editor + content safety — done (commit 83bd3d6): Content integrity
   validation on save+read (validateContent with known-block whitelist,
   auto-repair missing ids/wrapper/content), wired into savePageOCC (422 on
   unknown types), createPage, and getPageByBranchId. In-page sticky TOC
   from headings (§12.6). Paste safety: stripWordHTML() Word-to-semantic-HTML
   transform. Mermaid diagram node extension + renderer. Prism syntax
   highlighting for code blocks (+ One Dark theme CSS). Playwright gate
   (§6.3): 3 e2e tests (one container, persist, structure). 39 unit/integration
   tests pass, typecheck clean.
   Dependencies added: mermaid, prismjs, @types/prismjs.
6. Next — plugin engine, token-based theming, collab infrastructure,
   typed relations, data migration from old app.
7. Git flush pipeline — done (commit db12432): Markdown export
   (tiptapToMarkdown + YAML frontmatter), git service (simple-git:
   init, commit autosave + manual snapshot, history read, file-at-commit),
   DB-backed commit queue with exponential backoff worker loop. Wired into
   savePageOCC/createPage. History/snapshot/restore routes. Client
   HistoryPanel with commit list, snapshot form, and restore button.
   Gate: git log on data/repo shows real commit with page id (confirmed in
   unit, integration, and e2e suites).
   Review hardening (785c148, 064aea1):
   - Worker loop is single-flight (`workerRunning` guard) — overlapping
     drains could race on .git/index.lock or fold one page's staged file
     into another's commit.
   - Commits are scoped to their file (`git.commit(msg, [relPath])`) so a
     stale staged file can't ride along.
   - initGitRepo always (re)writes user.name/user.email — idempotent.
   - getFileContentAtCommit resolves the touched file via diff-tree (+
     `--root` for the repo's first commit). Never read the snapshot path
     blindly: once a snapshot exists it's present in every later commit's
     tree and would return stale content for later autosave commits.
     For autosave commits it derives the file's slug from the commit
     message (page:<id>: Update - <slug>), so pre-rename commits still
     restore after the page's slug changed.
   - Restore returns 409 on OCC conflict (matches the live save route).
   - getPageHistory greps in git (log --grep) so huge repos stay fast.
   - Restore+snapshot are covered through the real Fastify routes.
   - Client: a 409-conflict Reload (and a successful restore) clears
     livePage and bumps a reloadTick that keys the editor, so the editor
     remounts on fresh server content/timestamp — otherwise every subsequent
     autosave would 409 again (infinite conflict loop).
   - Markdown export: mentions become readable @Name text (were dropped),
     mermaidDiagram round-trips via ```mermaid fences. Tables and
     details/collapse are a documented best-effort (text survives,
     structure does not).
   129 unit + 8 e2e tests pass.
