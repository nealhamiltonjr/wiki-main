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
   - Restore rejects non-hex commitHash (zod /^[0-9a-f]{7,64}$/i) — a value
     like "--output=/tmp/x" would otherwise be parsed as a git option before
     the file-match could 404.
   - HistoryPanel: snapshot labels strip the machine prefix (page:<id>:),
     and a restore 409 triggers the same reload as a successful restore
     (ApiError.status 409). Snapshot input capped at 200 to match zod.
   131 unit + 8 e2e tests pass.
8. Search — done: FTS5 mirror (`page_fts`) + snippet escaping, stored-XSS search test.
9. Comments/backlinks/favorites/notifications — done (integration tests per feature).
10. Git flush pipeline — done (see above).
11. Collab (Hocuspocus) — done. Hocuspocus wired to the SAME `getDb()` connection in
    `src/server/services/collab.service.ts`; single-placement rule enforced in
    `onAuthenticate`. Client uses `@tiptap/extension-collaboration` +
    `-collaboration-caret` over `baseExtensions()` with `content={undefined}`.
    - **StrictMode bug**: destroying the provider in a `useEffect` cleanup on a
      provider created during render caused endless reconnect loops in dev. Fix:
      `sessionRef` + deferred `setTimeout(0)` destroy guarded by a `mountedRef`
      (see `useCollab.ts`).
    - **Invariant — collab doc fragment is an XmlFragment, not Y.Text**:
      `prosemirrorJSONToYDoc`/y-prosemirror store the doc under
      `doc.getXmlFragment("default")`. `doc.getText("default")` on it throws
      ("Type with the name default has already been defined…") or silently creates
      an empty Y.Text. Any instrumentation/decoding must use `getXmlFragment`.
    - **Store semantics**: Hocuspocus only runs `onStoreDocument` when the doc got
      updates (a no-edit session stores nothing — correct). The write-back goes to
      `collab_documents` AND `pages.content` (so a collab session is a real edit
      that also enqueues a git flush commit).
    - **WS wiring**: Hocuspocus v4 with a bare `ws` server does not attach
      message/close handlers; `src/server/index.ts` forwards them explicitly.
    - Gate: `collab.integration.test.ts` 8 tests green (incl. multi-placement
      rejection + write-back); manual two-tab sync + stop → reload persistence
      verified. Typecheck clean.
12. Plugin engine — next.

## Slice-12: Plugin engine (completed)

### Architecture
- **Server**: `src/server/services/plugin.service.ts` handles upload (zip
  decode via `fflate`, path-traversal guard), install, enable/disable, and
  uninstall. `src/server/routes/plugin.routes.ts` exposes REST endpoints at
  `/api/plugins`. Server-side routes from enabled plugins are mounted under
  `/api/plugins/:pluginId/` via `registerPluginServerRoutes()` (app.ts).
- **Client**: `src/plugins/registry.ts` — module-level store with React hooks
  (`useTiptapExtensions`, `useSlashCommands`, `useToolbarItems`, etc.).
  `src/plugins/api.ts` — PluginAPI constructor with capability enforcement
  (§4.4). `src/plugins/loader.ts` — `loadPlugins()` fetches manifest list,
  dynamically imports each enabled plugin's `client/index.js`, calls its
  `register(api)` function.
- **Content model**: `filterUnknownNodes()` and `validateContent()` in
  `shared/blockIds.ts` accept `extraNodeTypes`/`extraMarkTypes` Set params.
  Page read/write passes plugin node types from the enabled plugin list;
  collab seed filters unknown nodes before Y.doc creation. When a plugin is
  disabled/uninstalled, its nodes degrade to paragraphs preserving text.

### Plugin contract (§4.4)
- `plugin.json` manifest: id, name, version, capabilities (booleans:
  tiptapExtensions, slashCommands, toolbarItems, settingsPanel, embedTypes,
  serverRoutes), contentModel (nodes[], marks[]).
- `client/index.js`: default-export `register(api)` function receiving
  `{ Tiptap, React, registerTiptapExtension, registerSlashCommand,
  registerToolbarItem, registerSettingsPanel, registerEmbedType }`.
- `server/index.js`: Fastify plugin `async function(app, opts, done)`.
- Capability enforcement: calling an undeclared register method throws.

### Slash menu
- `src/features/editor/SlashMenu.tsx` — Tiptap ProseMirror plugin extension
  activated by "/" at line start/after whitespace. Filters commands from the
  plugin registry by keyword match. Arrow-nav + Enter to execute.

### Admin UI
- `src/routes/_authenticated/settings.tsx` — settings index with plugin link.
- `src/routes/_authenticated/settings/plugins.tsx` — upload, list,
  enable/disable toggle, uninstall with auth guard.
- `src/routes/_authenticated.tsx` calls `loadPlugins()` after session confirm.

### Tests
- `src/server/__tests__/plugin.integration.test.ts` — auth gates, content
  validate with extraNodeTypes.
- `src/shared/__tests__/blockIds.test.ts` — 6 new filterUnknownNodes tests
  (preserve known, degrade unknown to paragraph, recurse nested, filter marks,
  accept plugin nodes via extra set, empty content).

### Pitfalls
- `import.meta.hot` only exists in Vite dev mode — guard with
  `typeof import.meta !== "undefined"` before accessing `.hot`.
- `AnyExtension` from `@tiptap/core` is the base type for all
  Extension/Node/Mark — use it instead of `Extension` for the registry store.
- Fastify multipart returns 415 for non-multipart bodies sent to a multipart
  route. To test file uploads use `app.inject()` with proper encoding.

### Notable fixtures
- `test-fixtures/hello-world-plugin/` — a minimal plugin exercising all
  PluginAPI methods. `test-fixtures/hello-world-plugin.zip` is pre-built.

## Slice-14: Settings consolidation (completed, commit `d3dee0c`)

### IA (§7.1)
- `/settings` is the single entry point, visible to every signed-in user.
- Sub-nav lists 10 sections; admin-only sections are filtered for non-admins
  AND direct URL access to an admin URL bounces non-admins to `/settings/profile`
  (effect in the layout, not during render — avoids flicker).
- The topbar `Settings` link now points at `/settings/plugins` (the slice-12
  e2e gate expects that exact URL).

### Routes wired
- `src/server/routes/settings.routes.ts` — global settings CRUD, secret masking
  (`isSecret` rows never carry `value`), system-info (dbPath/repoRoot/pluginRoot,
  node/platform/pid/uptime, SSO flags, private-clip-host flag), git-remote
  round-trip.
- `src/server/routes/group.routes.ts` — groups are the **sole permission-granting
  mechanism** per §3.1; list returns `memberCount` so the UI can render counts
  without N+1 calls.
- `src/server/routes/user.routes.ts` — admin-only user list and patch; the
  patch enforces "you cannot demote or suspend your own account" (§7.1) so a
  sole admin can't lock themselves out through the UI.
- `src/server/routes/token.routes.ts` — account-scoped tokens are user-writable;
  space/branch-scoped tokens require admin. **No-expiration tokens** are gated
  by `link-managers` group membership (§3.10) — the route translates the
  service's `NO_EXPIRATION_NOT_PERMITTED` error into 403 (was 500 before).

### Theme infrastructure
- `src/features/settings/useTheme.ts` — reads/writes `data-theme` on `<html>`
  and mirrors to `localStorage` (`wiki.theme`).
- `index.html` has an **inline** `<script>` that applies the stored theme before
  the first paint (the comment in the file explains why: prevents a white flash
  for users on dark theme).

### Tests
- `src/server/__tests__/settings.integration.test.ts` — 13 tests, all green:
  guards, system-info, secret masking, git-remote, groups CRUD + membership,
  non-admin group rejection, user promotion + self-demote/suspend guard,
  user list admin-only, account token create/revoke, no-expiration gating,
  scoped-token widening blocked, admin scoped-token allowed.
- Full suite: 23 files / 208 tests / 0 failures.
- Full E2E: 12 specs / 0 failures.

### Pitfalls
- `SettingsPanelDef` (slice-12 contract) does not surface `pluginId` to the
  host — the plugin settings panel can only render UI; the host renders the
  plugin info table itself. Documented in `routes/_authenticated/settings/plugins.tsx`.
- Test routes use `app.inject()` with the real auth flow (sign-up + sign-in +
  cookie), and promote the test user to `isAdmin: true` directly in the DB
  before admin requests — better-auth's session picks up the change because
  the access middleware reads `isAdmin` fresh per request.

## Slice-25: typed relations between pages (§13.1, commit `f8eefc7`)

### Architecture
- A relation is an `attributes` row whose `value` is empty and `valuePageId`
  is set; the relation type is `name` (free-form printable text ≤ 64 chars,
  the strictest blocking rule that still allows "depends on", "is a component
  of", etc.). Stored on the existing attributes table — no new schema object,
  just migration `0006` adding the FK + index.
- `src/server/services/relation.service.ts` — CRUD (`addRelation`,
  `removeRelation`, `listOwnedRelations`, `listIncomingRelations`,
  `listOwnedRelationsRaw`) + access checks (`canReadPage`, `canEditPage`,
  `loadAccessibleSpaceIds`). Owns the permission rank table
  `admin=3 > editor=2 > viewer=1 > none=0`.
- `src/server/routes/relation.routes.ts` — 4 endpoints under
  `/api/pages/:pageId/relations` (`GET owned`, `GET incoming`, `POST`,
  `DELETE`). POST is gated by edit access on source + read access on target
  (the "no existence leak" rule applies to create-time too — you can't
  create a relation pointing at a page you can't see). DELETE requires
  edit access on source; the route validates that the URL's `pageId` is a
  real page before delegating to `removeRelation`.

### Critical invariants
- **No-existence leak** (brief §13.1): both `listOwnedRelations` and
  `listIncomingRelations` use `filterReadablePageIds` to drop targets/sources
  the caller can't read — the response simply omits them rather than
  redacting. A caller who can't read the page itself gets **404**, not 200.
- **No duplicate canRead/canEdit helpers in routes.** First version of
  `relation.routes.ts` had its own `canReadPage`/`canEditPage` that checked
  `role === "editor"` only — the space admin who created the page got
  rejected with 403. Always import from the service (single source of rank
  semantics). The integration test for "create a relation as the
  space-admin" is the regression test.
- **Self-relation blocked at create time** — a relation cannot point at its
  own source page (asserted in `addRelation` before the FK insert).

### Tests
- `src/server/services/__tests__/relation.test.ts` — 9 unit tests for
  validation, CRUD, and the access rank table.
- `src/server/__tests__/relation.integration.test.ts` — 10 integration
  tests using `app.inject()` with the real auth + DB + permission stack.
  Includes the regression for the "space admin can edit" case.
- 36 files / 310 tests pass. Typecheck clean.

### Slice-26 follow-up (still on the brief §13.1 axis)
The backend is complete; the **client side is not wired**:
- `src/api/client.ts` has no `addRelation` / `listOwnedRelations` /
  `listIncomingRelations` / `removeRelation` wrappers.
- `src/routes/_authenticated/w/$branchId.tsx` has slots for
  `CommentsPanel`, `HistoryPanel`, `FavoriteButton` but nothing for
  relations — same panel pattern, new icon (`Link2` or `Network`).
- Search wrapper also missing in the client (`/api/search` exists server
  side) — needed for the relation-target page picker.

## Slice-26: relations UI panel — finishes §13.1

### What landed
- `src/api/client.ts` — added `searchPages`, `listOwnedRelations`,
  `listIncomingRelations`, `addRelation`, `removeRelation`. Added
  `PageSearchHit`, `PageSearchResponse`, `OwnedRelation`,
  `IncomingRelation` interfaces (all with `branchId` on the
  ref side, see below).
- `src/server/services/relation.service.ts` — added
  `loadReadablePageInfo(candidatePageIds, caller)` that returns
  `{ pageInfo: Map<pageId, {title, branchId}>, accessible }`.
  `listOwnedRelations` and `listIncomingRelations` now use it so the
  client gets a `branchId` per ref. The `branchId` is the *first*
  branch in any readable space for that page — the relation points at
  the page, not a specific placement, so any branch is correct. The
  previous helper `filterReadablePageIds` is kept (still used by
  callers that only need the Set of ids).
- `src/server/services/relation.service.ts` — `OwnedRelation.target`
  and `IncomingRelation.source` now carry `branchId: string | null`
  (additive; `null` only when the page exists but has no readable
  branch — should not happen in practice since we already filter on
  accessibility, but null is the safe fallback for the UI).
- `src/features/relations/RelationsPanel.tsx` — new sidebar panel
  matching the existing `CommentsPanel` / `HistoryPanel` shape:
    - Header with `Link2` icon, plus a `+` toggle (only when `canEdit`).
    - Outgoing section (`ArrowRight`, primary-tinted type chips).
    - Incoming section (`ArrowLeft`, accent-tinted type chips).
    - Clicking a target/source title navigates to `/w/$branchId`.
    - Search-driven target picker: debounced 200ms, ≥ 2-char query,
      filters out the current page from hits, click to pick.
    - Pure `validateRelationType` helper exported for unit testing
      (mirrors server-side validation: non-empty, ≤ 64 chars,
      no control chars).
- `src/routes/_authenticated/w/$branchId.tsx` — added a third
  header toggle (`Link2`) next to the History and Comments buttons;
  reuses the same reset-on-branch-change effect so navigating
  between pages closes the panel.
- Tests:
    - `src/features/relations/__tests__/RelationsPanel.test.tsx` —
      5 unit tests for `validateRelationType` (normal, empty,
      length bound, control chars, trim).
    - `src/server/__tests__/relation.integration.test.ts` — extended
      the two existing happy-path tests with `branchId` assertions
      on both owned and incoming rows.
- 37 files / 315 tests pass (was 36 / 310 in slice-25). Typecheck
  clean.

### Invariants enforced
- **Target picker excludes self.** The search hits are filtered to
  drop `h.pageId === pageId` so a relation can't point at its own
  source page (the server already rejects this — UI prevents the
  wasted request too).
- **Permission boundaries preserved.** The picker uses
  `/api/search` which already permission-filters via
  `searchPages()` in the service; the relation routes still gate
  `POST` on edit-access-source + read-access-target, so even if the
  UI somehow picked an unreadable target the server returns 400.
- **No existence leak.** Incoming rows from spaces the viewer can't
  read are dropped server-side (already in slice-25); the UI just
  renders what's in the response, so no client-side redaction is
  needed.
- **Editor-only operations.** Remove buttons and the add-form toggle
  both check `canEdit` from the panel prop, which the route derives
  from `page.access === "editor" || page.access === "admin"`
  (matching the existing pattern for comments/history).

### Pitfalls hit
- `useMemo` was initially imported but never used — fixed during
  typecheck.
- The first version of the panel had navigation tied to a single
  `branchId` resolved client-side; that needed a new endpoint, so
  the cleaner choice was to extend the relation service response
  with `branchId` (which it already had to query for the access
  filter — it just wasn't returning it). This avoided creating a
  new route for a value the service already knows.

### Next-up
- §13.2: `[[wikilink]]` syntax extraction, backlinks stored on save,
  and graph view.

## Slice-27: graph view — finishes §13.2

### What landed
- `src/server/services/backlink.service.ts` — added
  `getPageOutgoingLinks(pageId, caller)`: inverse of `getPageBacklinks`,
  resolves target branchId → pageId, applies the same no-existence-leak
  filter so links into unreadable spaces disappear entirely.
- `src/server/services/graph.service.ts` — new service. `getPageGraph(
  pageId, caller, { hops })` returns `{ center, hops, nodes, edges }`
  with permission-filtered nodes/edges. Default hops=1 (brief: "Scope
  it to a single page's local neighborhood by default (its direct
  links/relations, one hop out)"). `hops` is clamped to [1,3] for
  safety; the BFS is implemented but the typical use is one hop.
- `src/server/routes/graph.routes.ts` — new route file. Single
  endpoint `GET /api/pages/:pageId/graph?hops=N`. 404 on unreadable
  center (no existence leak).
- `src/server/app.ts` — registered `graphRoutes` next to `relationRoutes`.
- `src/api/client.ts` — added `GraphNode`, `GraphEdge`, `PageGraphResponse`
  types and `getPageGraph(pageId, opts)` wrapper.
- `src/features/graph/GraphPanel.tsx` — new panel matching the
  CommentsPanel/HistoryPanel/RelationsPanel shape:
  - `Network` icon header (lucide).
  - Hand-rolled SVG circular layout (no new deps).
  - Center node tinted primary; neighbors on a circle, distributed
    deterministically (no Math.random → no hydration flicker).
  - Edges colored by kind: backlinks muted, relations primary-tinted;
    arrows point from "out" edges away from center and "in" edges
    toward center.
  - Relation type label rendered at the edge midpoint.
  - Click a node → navigate via TanStack Router to `/w/$branchId`.
  - Pure layout helpers `computeLayout` and `computeEdgeLayout`
    exported for unit testing (no React dependency).
- `src/routes/_authenticated/w/$branchId.tsx` — added a 4th header
  toggle (`Network`) next to History/Comments/Relations; the existing
  reset-on-branch-change effect was extended to close the panel.
- Tests:
  - `src/features/graph/__tests__/GraphPanel.test.ts` — 7 unit tests
    for `computeLayout` (single node, N even distribution, determinism,
    no-center fallback, bbox fit) and `computeEdgeLayout` (path
    string, missing-endpoint drop).
  - `src/server/__tests__/graph.integration.test.ts` — 8 integration
    tests: lonely page, outgoing-backlink edges, incoming-backlink
    edges, relation-with-label edges, dedupe across kinds, 404 on
    unreadable center, space isolation (neighbors in unreadable
    spaces dropped), hops clamping.
- 39 files / 330 tests pass (was 37 / 315 in slice-26). Typecheck clean.

### Invariants enforced
- **No existence leak on center.** Unreadable center → 404 (same as
  the existing `/api/pages/:pageId/backlinks` endpoint).
- **No existence leak on neighbors.** `getPageOutgoingLinks` and the
  graph BFS apply the same space-accessibility filter as
  `getPageBacklinks`. If a relation or backlink would point at a page
  in a space the caller can't access, the row is dropped server-side
  before it ever leaves the endpoint.
- **Deterministic layout.** `computeLayout` uses only fixed angles
  derived from index; no `Math.random()`. Critical: React renders the
  panel server-side (initial HTML) and client-side (hydration) and a
  non-deterministic layout would cause a hydration mismatch.
- **Direction labels.** Every edge has a `direction: "in" | "out"`
  relative to the center, so the UI can render arrows consistently
  regardless of which side of the graph the neighbor ends up on.
- **Deduped at the edge level.** Same (from, to, kind, label) tuple
  is collapsed via an in-memory key set inside the BFS, so a page
  that appears as both an outgoing backlink and an outgoing relation
  shows up as two distinct edges (different colors/labels) rather than
  one edge being shadowed.

### Pitfalls hit
- The brief uses the word "wikilinks" loosely, but the existing system
  has no `[[double-bracket]]` syntax — "wikilinks" here means the
  internal link marks (`href: "/api/branches/<id>/page"`) that
  `refreshBacklinks` already extracts on save. So no new editor
  extension was needed; the graph view is purely a presentation layer
  on the existing index.
- First test failure: used the wrong URL shape for `getUpdatedAt` —
  the page GET is keyed by branchId, not pageId. Fixed by switching
  the helper to `/api/branches/:branchId/page` and updating call
  sites.
- Typecheck initially flagged the test importing `GraphNode`/`GraphEdge`
  from `GraphPanel.tsx` (not exported). Switched the import to
  `@/api/client` so the test depends on the public API types, not the
  panel's internal surface.

### Next-up
- §13.3 template inheritance, §13.4 attribute-driven table/board views, and
  §13.5 plugin event hooks are all implemented and tested (see
  `template.service.ts`, `lens.service.ts` + `features/lenses/*`,
  `hooks.ts` + `hookTypes.ts`, and `hooks.events.test.ts`). The remaining
  brief items (§12.1–12.7, §13.1–13.7) are likewise complete — the app is
  feature-complete against `WIKI-REDESIGN-BRIEF-V2.md`.

## Slice-34: Docmost-style paragraph drag handle (§6.2, commit acbd2c7)

### What landed
- `src/features/editor/extensions/dragHandle.ts` — vendored/adapted Docmost
  block drag-handle as a ProseMirror plugin (key `globalDragHandle`). The
  handle element is appended to the nearest `.editor-canvas` ancestor (not the
  ProseMirror root and never a wrapper), with a `view.dom.parentElement`
  fallback. Drag preview + drop indicator re-create the Docmost/Siyuan feel
  using CSS tokens only.
- `src/features/editor/editingExtensions.ts` — new module exporting the
  editing-only extension list (the drag handle). Kept separate from
  `editorExtensions.ts` so read-only rendering never mounts it.
- `src/features/editor/Editor.tsx` — imports/wires the editing extensions.
- `src/features/editor/editorExtensions.ts` — dropcursor stays on StarterKit
  (single instance, no duplicate `dropCursor` plugin); color now reads
  `var(--color-primary)`.
- `src/styles/app.css` — `.editor-canvas` is the `position: relative` anchor;
  `.drag-handle` is `position: absolute` and hover-revealed, sibling of the
  content, never inside `.ProseMirror`.
- e2e: `e2e/editor.spec.ts` "drag handle is a sibling of the ProseMirror
  root, not a wrapper (§6.2)" — hovers a paragraph, asserts exactly one
  handle under `.editor-canvas` and zero under `.ProseMirror`.
- Unit: `src/features/editor/__tests__/editingExtensions.test.ts` (2 tests).

### Invariants
- **Exactly one dropcursor.** StarterKit owns it; `editingExtensions` must not
  add a second `dropCursor` instance.
- **Handle is a sibling of the ProseMirror root**, a child of `.editor-canvas`,
  never inside the content it drags (§6.2 single-pane structural rule).
- **No literal colors** — the drag preview/handle styles must read tokens.css
  vars; `src/styles/__tests__/theme.test.ts` enforces this mechanically.

### Pitfalls hit
- `FileEditorAction` failed once because `old_str === new_str` (no-op edit);
  the e2e test was instead inserted with the `insert` command at the correct
  line.
- Initial unit-test failure was a plugin-name mismatch (`dropcursor` vs
  `dropCursor`).
- Theming gate caught four literal-color violations in the new files
  (dropcursor hex, preview background/border/shadow); all switched to tokens.

## Slice G (G-light): maintenance report — similar pages + broken wikilinks (§12.7, commit acbd2c7)

### Scope decision
"G-light" = no AI/embeddings and no external services. Similar-page detection
is deterministic trigram (Sørensen–Dice) similarity over `docToText` plain
text; broken wikilinks reuse the existing `backlinks` index (no new schema).

### What landed
- `src/server/services/maintenance.service.ts` — `buildMaintenanceReport`
  now returns four arrays:
  - `orphanedPages` (unchanged)
  - `brokenRedirects` (unchanged)
  - `brokenWikilinks` — backlink rows out of this space's live pages whose
    target branch no longer resolves to a live non-system page (deleted branch
    or trashed page). Carries `sourceBranchId` for UI navigation.
  - `similarPages` — pairwise near-duplicate pairs over live space pages with
    ≥ 80 chars of rendered text, scored by trigram Dice coefficient (threshold
    0.35), capped to 3 decimals. Pairs are sorted by score desc.
- `src/routes/_authenticated/settings/maintenance.tsx` — admin-only settings
  sub-page: space `<select>`, then four sections (orphaned, broken wikilinks,
  stale redirects, near-duplicates) with branch links into `/w/$branchId`.
- `src/routes/_authenticated/settings.tsx` — added the "Maintenance" nav entry
  (adminOnly). The TanStack route tree regenerates on `vite build`; typecheck
  resolves the new route only after that regen.

### Invariants
- **Admin-only** (matches the existing §12.7 maintenance route): broken
  redirect/wikilink metadata would leak page slugs/titles to non-admins.
- **No new schema** — the report is a pure read over `pages`, `branches`,
  `backlinks`, `pageRedirects`; no AI, embeddings, or network calls.
- **Similarity is deterministic and server-side** — no `Math.random`, so SSR
  hydration stays stable.

### Tests
- `src/server/__tests__/maintenance.integration.test.ts` extended from 11 →
  17 tests: broken (deleted branch / trashed page) vs live backlinks, near-
  duplicate detection above threshold, unrelated pages below threshold, and
  both new fields asserted in the empty-report and admin-GET cases.

## Final regression pass (commit 5c0444e)

- Fixed a real plugin-engine bug: `setPluginEnabled` unconditionally called
  `loadPluginHookModule` on every enable, so a `serverRoutes`-only plugin
  (hello-world) had its Fastify plugin invoked with a bare `{registerHook}`
  API and logged `[hooks] Failed to load hook handlers ... app.get is not a
  function`. Now gated on `existing.capabilities.hooks` (matching
  `registerPluginHookHandlers`), plus a regression test in
  `plugin.integration.test.ts` (console.error spy + hook-count invariant).
- Full gate: 81 files / 619 vitest tests, typecheck, `vite build`, and
  Playwright 22/22 all green; synthetic e2e simulation green.


