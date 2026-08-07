# Wiki App — Comprehensive Project Overview

**Purpose of this document:** A single, complete, up-to-date handoff for this project — what it is,
why it is built the way it is, exactly what exists today (verified against the actual code), and
what is deliberately deferred. It replaces the previous `PROJECT-OVERVIEW.md` and
`UI-OVERHAUL-PLAN.md` (both removed) and absorbs their content into one current document. Written so
this file alone is enough for a new person or a new AI session to understand and continue the
project without re-deriving anything.

**Status (2026-08-01):** feature-complete for the agreed scope. 218 unit/integration tests (25
files) + 13 Playwright E2E tests pass, `tsc --noEmit` is clean, `npm run build:client` is green.
Working branch: `snapshot.3`.

---

## 1. What this is

A custom, self-hosted, multi-user wiki/knowledge-base web application, built from scratch after
evaluating existing tools (Wiki.js, BookStack, Outline, Docmost, Trilium/TriliumNext, SiYuan,
Joplin, Obsidian) and finding no single one combined the specific things wanted without a
dealbreaker: Docmost's editor quality (but its API is Enterprise-gated), Trilium's
note-cloning/placement model (but strictly single-user), and SiYuan's stable block-ID referencing
(but its Markdown export loses cross-references).

**Deployment context:** runs on a Debian LXC container on the owner's home Proxmox server, reached
directly by IP on the local network (e.g. `http://192.168.1.204:3000`) — no port-forwarding,
nothing exposed to the public internet. A smaller public-facing instance is planned later for
selectively publishing non-sensitive content (public mode exists; see §5.10).

## 2. Who it's for, and what it needs to hold

A single technically capable owner and a small circle of people they grant access to (friends,
possibly coworkers) — not a large organization. Content spans:

- Homelab/infrastructure documentation (Proxmox, network configs, code snippets)
- Amateur radio reference material (schematics as images, HF band data)
- Long-form personal/hobby writing
- HR-type or otherwise sensitive content requiring real access restriction, separate from general
  content (supported via group-permission boundaries — see §4.2)
- A future public-facing slice for non-sensitive material (e.g. a Linux command reference)

---

## 3. Tech stack — what, and why

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict mode, end-to-end | One type system shared between DB schema, API, and frontend |
| Database | **SQLite** via `better-sqlite3` (WAL mode) | Right for the scale (dozens of users); single-file backups; no separate DB server |
| ORM | **Drizzle ORM** | Type-safe schema-as-code; patterns proven by Docmost (same stack) |
| Backend | **Fastify** | Declarative route config + native validation; the app relies on a route-config middleware pattern (§4.2) |
| Auth | **better-auth** | Owns identity entirely — its generated `user`/`session`/`account`/`verification` tables are used directly, with one custom field (`isAdmin`) via `additionalFields`. No parallel `users` table |
| Editor | **Tiptap v3** (`@tiptap/*@3.29.2`) | Content is stored as native ProseMirror JSON (canonical format). Upgraded v2→v3 on 2026-08-01 (only breaking changes: `BubbleMenu` import path, `setContent` options arg) |
| Frontend | **Vite + React 18**, no Next.js | No SSR need — private authenticated app behind a login screen. Tailwind v4 (via `@tailwindcss/vite`, no preflight) + shadcn/ui-style primitives built on project CSS tokens (Track B, completed) |
| Content versioning | **simple-git** on a local repo (`data/repo`) | Every save and manual snapshot becomes a real Git commit of the page's Markdown export; free diff/rollback history |
| Testing | **Vitest** + Fastify `.inject()` + Playwright | Integration tests run real routes in-process with no network port; E2E runs against the production build |
| Uploads | `@fastify/multipart` | 25MB limit (raised from the default 1MB after a real bug) |
| Static serving (prod) | `@fastify/static`, scoped to `/assets/` only | Unscoped serving shadowed unmatched `/api/*` routes — a real bug found in production testing |

**Dependency pinning is load-bearing.** `better-auth`, `drizzle-orm`, `drizzle-kit`, and
`better-sqlite3` have interlocking peer dependencies that caused multiple clean-install failures;
they are pinned to exact versions (no `^`). Do not loosen these pins without re-testing a clean
`npm ci`.

---

## 4. Core architecture — what, and why

### 4.1 The data model: `pages` + `branches`

The single most important design decision. Two tables, deliberately separated:

- **`pages`** — the abstract content. Permanent ID, `slug`, `title` (real column since Track A),
  the Tiptap JSON content, `owner_id` (authorship, never changes), `deleted_at` (soft delete).
- **`branches`** — a *placement* of a page inside a tree. Points at a `page_id`, has a
  `parent_branch_id` (arbitrary nesting), a `position`, and its own `space_id`, `visibility`
  (public/private/inherit), and `is_system` flag.

**Why split this way:** Trilium-style cloning (the same content placed in multiple locations — e.g.
an "Antenna Specs" page visible in both a private space and a public space) combined with SiYuan's
stable-ID referencing. Space and visibility are properties of a **placement**, not of content.
**Downstream rule:** anything permission-sensitive (`group_permissions`, share-link tokens, sync
targets) addresses a **branch**, never a bare page ID.

### 4.2 Permission resolution — one formally-specified algorithm

Implemented once in `src/shared/permissions/algorithm.ts` and required by architecture to be the
*only* place permission logic lives (REST routes, MCP tools, collab, share links, search all call
it). Resolution order:

1. **System-branch guard** — a target or ancestor with `is_system` denies everyone except global
   admins.
2. **Admin bypass** — a global admin has full access, full stop.
3. **Visibility resolution** — the target branch's own explicit `visibility` (if not `inherit`)
   always wins over ancestors; walk up only when `inherit`.
4. **Local boundary (group permissions)** — walking from the target outward, the *nearest* branch
   with an explicit `group_permissions` grant **fully replaces** everything above it (match →
   that role; non-match → `none`). A hard stop, never merged with a more permissive value. This is
   what lets a restricted subtree (e.g. HR) exist inside an otherwise-open space.
5. **Space fallback** — no branch-level override anywhere in the chain → the requester's space role
   (`space_members` direct, or best role via `space_group_permissions` through their groups),
   floored by the visibility baseline.

The algorithm's two historically-found bugs (ancestor visibility overriding the target's own
setting; a non-matching boundary falling through to a public baseline) are permanent regression
tests in `src/shared/permissions/__tests__/algorithm.test.ts` (10 tests).

**Enforcement:** every `/api/` route (except `/api/auth/*`) must declare a `config.access` policy at
registration — `"public"` | `"authenticated"` | `"admin"` | `{ branchParam, minRole }` |
`{ spaceParam, minRole }`. An `onRoute` hook validates this at **server startup**; a route missing
it crashes the server immediately with a clear error rather than silently being open.

**Capabilities & groups (recent overhaul):** beyond the space/branch model, groups now carry a
`capabilities` list (e.g. `admin.*`, `admin.settings`), and a **session-enrichment plugin**
(`src/server/auth/session-enrichment.ts`) injects the resolved `capabilities` + `groupIds` into the
better-auth session user on every session-producing response. The client gates (admin UI,
settings) match what the server enforces — the previous mismatch (UI 403s while the API returned
200) is fixed. Space-level defaults (default role, member list, group grants) are editable from the
Space Permissions panel in the UI.

### 4.3 Users, groups, spaces

- **Identity:** better-auth's `user`/`session`/`account` tables; `isAdmin` is an additional field.
- **Groups** (`groups`, `user_groups`) are the **sole** permission-granting mechanism (an earlier
  per-user grant table was dropped to avoid overlapping grant paths). A "just this one person" case
  is a single-member group. Group CRUD is admin-only.
- **Spaces** (`spaces`, `space_members`, `space_group_permissions`) are Docmost-style top-level
  containers; each space's membership/default role is independent.

### 4.4 Tokens — one engine, two purposes

A single `tokens` table backs **share links** and **API tokens**, distinguished by `type`. A share
link's `scope_type` can never be `"account"` (enforced by Zod at the route). Raw tokens are shown
once at creation and stored only as SHA-256 hashes. Share links support password protection and an
inactivity watchdog (hourly sweep, up to 3 warnings, then auto-revoke — tested).

**API tokens are usable bearer credentials:** `Authorization: Bearer <token>` works on every `/api/`
route, with the token's own scope enforced:

- `account` — acts as the creator, access **capped** at the token's `permission` (a `view` token
  can never edit).
- `branch` — the token's permission on exactly that branch (tops out at `editor`).
- `space` — the token's permission within that space.
- Branch/space tokens are *scoped credentials*: rejected (403) on general authenticated routes
  like `/api/spaces`. Password-protected tokens are **not** usable as bearer credentials (no way to
  supply a password over the API); the public `/api/share/:token` view performs its own password
  check.

### 4.5 Background jobs, Git versioning

A minimal SQLite-backed job queue (`job_queue` + a polling worker in-process, no Redis) handles
anything long-running: git commits on save, manual snapshots, `git_push`, `git_pull`. Jobs get
retry/backoff, cap at 5 attempts, then mark failed. A real historical bug (manual snapshots not
embedding the page ID in the commit message, so one page's history showed every page's snapshots)
is fixed with a regression test.

### 4.6 Settings — system-wide vs. per-user

- **`system_settings`** — admin-only, key/value, `is_secret` flag. Secrets (SMTP password, git
  token) are AES-256-GCM encrypted at rest with a key from `SETTINGS_ENCRYPTION_KEY` (env var,
  never the DB). The server **refuses to boot** without that key (and without `BETTER_AUTH_SECRET`).
- **`user_settings`** — per-user prefs (editor width, theme/accent, plugin toggles), isolated per
  user (cross-user leak test exists).
- **Declarative settings registry** (`src/shared/settings-registry.ts`): first-party modules
  `registerSetting({...})`; the admin UI renders typed controls (text/number/boolean/select/secret/
  textarea) per section. Sections today: **General** (site name, public mode, allow signup),
  **Email** (SMTP host/port/user/pass/from), **Git** (remote URL, token, branch), **Sync** (target
  URL/token), **Security** (trusted origins) + Custom. Secrets are masked in list responses.

---

## 5. What's actually built and tested today

Everything below is verified against the running code — by automated test or manual reproduction
during development (both noted where relevant).

### 5.1 Authentication
Email/password sign-up and sign-in via better-auth, fully working. SSO (Google, GitHub) has
**configuration slots but no real credentials** — providers register only if the env vars exist.
Authentik/generic OIDC has no code. Suspended users are blocked; admin promotion is a DB update
(no admin-bootstrap UI — the first account is promoted via a one-line Node script, §6).

### 5.2 Spaces, groups, users (admin)
Full CRUD for spaces (create, list, delete), groups (create, list, delete, add/remove members,
edit capabilities), and users (create, edit role/groups, suspend/unsuspend). **Safe user
deletion** (`DELETE /api/admin/users/:id`) supports `{ reassignToId }` (owned pages transfer to
the heir, then the user row is deleted) or `{}` (pages deleted too); the admin **cannot delete
their own account** (400). **User export** (`GET /api/admin/users/:id/export`) returns a zip of the
user's pages as Markdown. All admin endpoints are admin/capability-gated.

### 5.3 Pages and the tree
- Create (top-level or **nested under any existing page**; 3-level-deep nesting regression test)
- Read, scoped through a branch; save with **Optimistic Concurrency Control** (`409` on stale
  `updatedAt`); title and body have **separate OCC windows** (title-only saves don't 409 against a
  concurrent body save)
- **Page/branch cross-validation** on save/snapshot/history — a real auth bug fixed (routes checked
  only the URL `branchId` while operating on a separate `pageId`); now `404` on mismatch, with
  regression tests
- List a space's tree; **clone** a page into another space (new placement for the same content);
  **move/reparent** (same-space only, cycle-guarded); **rename** (slug, shared by all placements);
  **delete a placement** (blocked while it has children); **delete a page everywhere**
  (soft-delete + remove every placement, requires editor access on **every** placement)
- **Attributes** (Trilium-style labels/relations on pages): CRUD with editor-access-on-owning-branch
  enforcement and page/branch cross-validation
- **Favorites** per user; **notifications** (in-app bell, mark read)
- **Backlinks** panel (`backlinks` table populated on save) with click-to-navigate
- **Real-time collaboration** via Hocuspocus/Yjs (`/api/collaboration` WebSocket, permission-checked
  on document load, `collab_documents` persistence); the client editor uses the
  `@hocuspocus/provider`. Only single-branch pages collaborate (a cloned page's multiple placements
  would otherwise leak keystrokes across security boundaries)

### 5.4 The editor
Tiptap bound to canonical JSON, debounced autosave. Read-only by default with an explicit
Edit/Done toggle (SiYuan-style). What's installed:

- **Toolbar** (grouped, lucide icons, tooltips): bold/italic/underline/inline code, H1–H3,
  bullet/numbered/task lists, blockquote, code block, highlight, align, undo/redo, image upload,
  search & replace, comments — all rendered from the plugin registry
- **Slash commands** (`/`) grouped popup, keyboard-navigable; fixed for filtering + click
- **Drag handle** block menu + **drag-and-drop reordering** (`@tiptap/extension-dropcursor`,
  vendored drag-handle)
- **Bubble menu** on selection (bold/italic/underline/link)
- **Wiki links** (`[[` autocomplete), **@mentions** (user list), **task lists**, **highlight**
  (`==…==`), **text alignment**, **underline**
- **Inline images** (`inline: true` — a real bug was fixed here; block-level images made any page
  with a markdown-imported image line hold invalid content), uploaded files render as a real
  attachment node with `data-kind`; images always land on their own line (Docmost-style; three
  separate Tiptap commands — a chained single transaction caused a `Position out of range` bug)
- **Comments**: block-anchored (`comment_threads.block_id` + `range_from/range_to` fallback),
  `selection` snippet, resolve/reply/delete, hover popup, re-anchoring on load; code blocks allow
  comment marks via a `CommentableCodeBlock` schema override (stock ProseMirror drops marks there)
- **Block IDs** on every block node (`@tiptap/extension-unique-id` + shared `ensureBlockIds()`
  backfill on every write path) — foundation for stable comments/anchors
- **Search & replace** (Ctrl+F popover), **markdown paste** (`handleMarkdownPaste`), **page icon**
  (per-page `icon` attribute), **page title input** (independent debounced save), **breadcrumbs**
- **Plugins** (per-user toggles in Settings): slash-commands, wiki-links, search-replace,
  page-comments, backlinks, page-history. `pluginEngine.ts` is the first-party registration surface
  (slash commands, toolbar buttons, extensions). Tables/columns/details/callout/math are
  deliberately **not** installed

### 5.5 File uploads
Upload/download work with a hard security property: a file is only served relative to the specific
branch the requester is authorized against (a file cannot be fetched via a different, unrelated
branch). 25MB limit. `data/files` holds uploads.

### 5.6 Git versioning, snapshots, history
Every save → real Git commit of the page's Markdown export (YAML frontmatter: `title`/`slug`/`date`,
then the body). Manual "Snapshot" with a user message → `_snapshots/<pageId>.md`. History is
viewable (hash/message/date) **and actionable**: each entry has a Restore button (editor access
required) that reads the Markdown at that commit, converts back to Tiptap JSON, and saves as a new
forward-moving version. `initGitRepo` checks for `.git` inside `REPO_ROOT` directly (a real bug:
`checkIsRepo()` walked up to a parent repo and skipped init, breaking every commit).

### 5.7 Templates
A page can be saved as a global (admin-only) or personal template and used to seed a new page —
verified end-to-end including that the seeded content is a genuine copy.

### 5.8 Git & Sync admin sections
- **Git** (`git.routes.ts` + `GitSection.tsx` + `git.service.ts`): repo status (branch/HEAD/dirty
  count), log, **test remote** (`git ls-remote`), **push** / **pull-import** — both run through the
  worker queue (never block an HTTP request). Remote URL/token/branch come from the settings
  registry (secret-masked). A "never auto-push" default: nothing leaves the box without an explicit
  admin action.
- **Sync** (`sync.routes.ts`): push a space to another instance as Markdown via target URL + token
  (HTTP-API sync, independent of git remotes).
- **Web Clipper** (`clip.routes.ts` + `ClipperSection.tsx`): `POST /api/clip` converts HTML →
  Markdown → Tiptap into a new page (editor access required on the target space). The Settings page
  shows a draggable **bookmarklet** that opens the server-hosted `/clipper` interstitial (same-origin,
  session carries auth) and POSTs the clipped HTML. No server-side Readability extraction, no
  source-URL de-dup, no image download — deferred (§7).

### 5.9 Search
SQLite **FTS5** external-content table (`page_fts`) keyed by page id, maintained on create/save.
`/api/search` returns `{ results, spaces, count }`:

- `parseSearchQuery()` turns free-form input into a safe FTS5 MATCH expression: quoted `"phrases"`
  are adjacency, bare words match `word OR word*`, `AND`/`OR`/`NOT` (and `-word`) work, FTS5
  special chars and boolean keywords are neutralized (an invalid MATCH query can never 500)
- **Permission-filtered**: every candidate is run through `resolveAccess()` and dropped if the
  caller can't read it (title/slug/snippet/space name never leak); admins skip per-row checks;
  deleted/system rows excluded at the SQL level
- `searchSpaces()` matches space names; result pages carry `spaceName`
- UI: **Cmd+K palette** and an always-visible **SearchBox** pinned above the editor, both grouped
  into Spaces + Pages and navigated via react-router

### 5.10 Public mode & share links
- **Share links**: `GET /api/share/:token` (public, own password check) → `ShareView.tsx`, a
  standalone read-only Tiptap renderer. Token minting requires editor access on the exact branch.
- **Public mode** (`PUBLIC_MODE=1`): `/api/public/*` read-only endpoints list public pages the
  anonymous caller can actually read and serve their content. Both surfaces run the **full
  permission algorithm** (including the local-boundary hard stop), so a public branch carrying a
  group boundary — or a public child under a restricted ancestor — returns 404 instead of leaking.

### 5.11 MCP server
A JSON-RPC 2.0 endpoint (`/api/mcp`) exposes AI-agent tools that enforce the same permissions as
REST: `list_spaces`, `get_page`, `search_pages` (now also boundary-filtered via `resolveAccess` per
candidate — a leak inside an accessible space was closed), `create_page`, `get_page_tree`. Bearer
API tokens work as credentials.

### 5.12 Admin UI
`AdminSettings.tsx` (admin-only) tabs: **Users & groups** (user create/edit/suspend/delete with
reassign, group membership editing, group CRUD + capabilities), **System** (settings registry,
typed controls, secrets masked), **Git** (GitSection + ClipperSection), **Debug** (admin logs with
filter). The per-user **Settings** page (all users) covers theme/accent, editor width, and the
plugin toggles.

### 5.13 Theming & UI polish (Track B/C)
Tailwind v4 + shadcn-style primitives on a full design-token system in `theme.css`:
light/dark/contrast/**system** themes + 8 accent colors, persisted per user. Components: dialogs,
popovers, dropdowns, context menus, tooltips, sonner toasts, breadcrumbs, empty states, command
palette, notification bell, interactive tree (`react-arborist`: drag-move, keyboard nav, clone
badge, right-click + "⋯" dual-trigger context menu with create/rename/move/clone/delete dialogs).
Vite `manualChunks` splits react/router/arborist/ui-vendor so the login shell stays light.

### 5.14 Testing
- **25 test files, 218 tests** (`npm test` / `npx vitest run`), including integration suites that
  boot the real Fastify app in-process and exercise routes via `.inject()` with an isolated DB:
  - `src/shared/permissions/__tests__/algorithm.test.ts` — every branch of the permission algorithm
  - `src/shared/__tests__/blockIds.test.ts` — block-ID walkers
  - `src/server/services/__tests__/` — crypto, markdown (incl. round-trips), settings + settings
    framework, token, user-settings, git-service, editor-schema, search-query
  - `src/server/__tests__/` — integration, admin.integration (incl. user deletion/reassign/export,
    session-enrichment), security.integration (page/branch decoupling, bearer tokens, MCP
    permission parity incl. search leak guard), page-branch-mutations, space-permissions, title,
    search, sync (real two-instance child-process test), export, attributes, backlinks,
    notifications, ancestry, page-permissions
- **13 Playwright E2E** (`e2e/`, headless Chromium against the **production build**):
  `editor-features.spec.ts` (8 tests: slash menu, wiki-link insert, @mention, toolbar image upload,
  upload-on-top-of-markdown-imported content, share-view rendering) + `wiki.spec.ts` (5 tests:
  sidebar, space/page creation, edit/save, Cmd+K palette, settings). Image assertions use
  `img:not(.ProseMirror-separator)` because inline images render ProseMirror's invisible separator
  placeholders.
- `npx playwright test --config=e2e/playwright.config.ts` starts its own production server
  (`e2e/start-server.sh` — regenerates the DB, pushes the schema, builds the client).
- **Manual harness** `e2e/manual-verify.mjs` (26 checks) covers the UI behaviors E2E doesn't.
- Known limitation: the unit/integration layer is API/service-level; the React/Tiptap UI is covered
  only by the E2E/manual layers.

---

## 6. Deployment

Target: a Debian LXC container, Node 22, reached by its own LAN IP.

1. `npm ci` (exact pinned versions matter — see §3)
2. Set the mandatory env vars (the server **refuses to boot** without them):
   - `BETTER_AUTH_SECRET`
   - `BETTER_AUTH_URL` (must match the real address the app is reached at — a real bug was hit
     when this didn't match)
   - `SETTINGS_ENCRYPTION_KEY`
   - Optional: `DB_PATH` (default `./data/wiki.db`), `GIT_REPO_ROOT` (default `./data/repo`),
     `FILES_ROOT` (default `./data/files`), `PORT` (3000), `PUBLIC_MODE`,
     `BETTER_EXTRA_TRUSTED_ORIGINS`
3. `npm run db:push` (`drizzle-kit push --force`) to create the SQLite schema
4. `npm run build:client`
5. First run by hand to create an account, then promote it to admin via a one-line Node/
   better-sqlite3 script against the `user` table (`UPDATE user SET is_admin = 1 WHERE email = …`)
6. A systemd unit (`EnvironmentFile=` pointed at a real `.env`) for restart-on-boot/crash

Development: `npm run dev:server` (API + WebSocket on :3000) + `npm run dev:client` (Vite on
:5173, proxies `/api` to :3000). The server needs `SETTINGS_ENCRYPTION_KEY` and
`BETTER_AUTH_SECRET` set; a `/tmp/wiki-env.sh` helper with the dev key exists on the dev machine
but is not tracked. If the key is regenerated, the `system_settings` table must be reset together
with it (it encrypts `smtp_pass`/`git_remote_token` etc.).

---

## 7. What's deliberately deferred / known open items

Ordered by remaining value vs. cost. Nothing below is required for the current feature-complete
state.

1. **Trash / restore view** — delete-everywhere soft-deletes the page row directly; the `is_system`
   branch flag and the algorithm's system-branch guard exist to support a real trash later.
2. **Editor tables, columns, details, callout, math** (Docmost set) — not installed; real code +
   testing weight.
3. **SSG-ready export polish** — export endpoints exist (page/space → zip, clean Markdown); not yet
   done: image copy + relative src rewriting, optional frontmatter, internal-link rewriting. The
   git working tree is effectively today's export folder.
4. **Web clipper depth** — no server-side Readability extraction, no source-URL de-dup, no image
   download/hosting, no browser extension (a bookmarklet ships instead).
5. **OAuth SSO credentials** — config slots exist; real Google/GitHub/Authentik creds are
   operational, not code.
6. **Outbound email** — SMTP settings + `mailer.service.ts` exist; the share-link watchdog still
   logs to `system_logs` rather than emailing (a "test email" button is a natural follow-up).
7. **Tabbed multi-page editing (UI plan B11)** — deliberately separated milestone; not built.
8. **Toolchain refresh** — Vite 5→8 (fixes the esbuild dev-server advisory, moderate/dev-only) is
   deferred; `react-router-dom@7.18.2`'s CVE-2025-31127 advisory is **non-applicable** (requires
   RSC / `RouterContextProvider`, absent in this Vite SPA).
9. **MCP surface expansion** — `update_page`, `delete_page`, attribute tools.
10. **Scripting/eval plugins, sandboxing, AI chat** — out of scope; MCP is the AI surface.

---

## 8. A note on process — why this document can be trusted

Every claim about what's "built and tested" was verified against running code — actual
`curl`/`.inject()` requests, database inspections, `git log` checks — not inferred from intent.
Several real bugs were found because of that discipline, each with a permanent regression test:
the empty-document bug (zero block nodes made new pages unclickable), the file-size-limit bug, the
production static-serving routing bug, the page/branch decoupling auth bug (cross-branch
overwrite/read), the inert API-token engine, the `Position out of range` upload bug, the
lazy-vs-eager encryption-key check, the `checkIsRepo()` git-init bug, the malformed slash-command
filtering, the comment-anchor and code-block-comment bugs, the MCP search boundary leak, and the
dead `window.location.hash` navigation patterns. The current suite (218 + 13) locks all of these
in.
