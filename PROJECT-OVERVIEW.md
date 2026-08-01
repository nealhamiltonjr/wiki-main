# Custom Wiki App — Comprehensive Project Overview

**Purpose of this document:** A complete, standalone handoff — what this is, why it's built the way
it is, exactly what exists today (verified against the actual code, not reconstructed from memory),
and precisely what's left and how to build it. Written so this document alone, handed to a new
person or a new AI session, is enough to understand and continue the project without re-deriving any
of the reasoning below.

---

## 1. What this is

A custom, self-hosted, multi-user wiki/knowledge-base web application, built from scratch after
evaluating existing tools (Wiki.js, BookStack, Outline, Docmost, Trilium/TriliumNext, SiYuan, Joplin,
Obsidian) and finding that no single one combined the specific things wanted without a dealbreaker:
Docmost's editor quality (but its API is Enterprise-gated), Trilium's note-cloning/placement model
(but it's strictly single-user), and SiYuan's stable block-ID referencing (but its Markdown export
loses cross-references).

**Deployment context:** runs on a Debian LXC container on the owner's home Proxmox server, reached
directly by IP on the local network (e.g. `http://192.168.1.204:3000`) — no port-forwarding, nothing
exposed to the public internet. A separate, smaller public-facing instance is planned later for
selectively publishing non-sensitive content (Phase 8, not started).

## 2. Who it's for, and what it needs to hold

A single technically capable owner and a small circle of people they grant access to (friends,
possibly coworkers) — not a large organization. Content spans:
- Homelab/infrastructure documentation (Proxmox, network configs, code snippets)
- Amateur radio reference material (schematics as images, HF band data)
- Long-form personal/hobby writing
- HR-type or otherwise sensitive content requiring real access restriction, separate from general
  content
- A future public-facing slice for non-sensitive material (e.g. a Linux command reference)

---

## 3. Tech stack — what, and why

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict mode, end-to-end | One type system shared between DB schema, API, and frontend — no duplicated type definitions, no serialization surprises |
| Database | **SQLite** via `better-sqlite3` (WAL mode) | Appropriate for actual scale (dozens of users, not thousands); single-file backup story; zero separate DB server to operate. Deliberately re-evaluated against Postgres mid-project and kept — see §9 for the honest tradeoffs recorded at that decision |
| ORM | **Drizzle ORM** | Type-safe schema-as-code; chosen over Kysely specifically because Docmost (one of the tools this project drew inspiration from) also uses it, so patterns were known to work at this kind of app's scale |
| Backend framework | **Fastify** | Native schema validation hooks, lower boilerplate than Express for the kind of declarative route configuration this project relies on heavily (see §5.2) |
| Auth | **better-auth** | Handles password hashing, session management, and OAuth flows correctly out of the box rather than hand-rolling them. A significant architectural decision was made here: better-auth is allowed to **own identity entirely** — there is no separate custom `users` table. Its own generated `user`/`session`/`account`/`verification` tables are used directly (see §5.1), with one custom field (`isAdmin`) added via better-auth's own `additionalFields` mechanism, not a parallel table |
| Editor | **Tiptap v3** (`@tiptap/core@3.29.2`, `@tiptap/react@3.29.2`, `@tiptap/starter-kit@3.29.2`, `@tiptap/extension-image@3.29.2`, `@tiptap/extension-link@3.29.2`, `@tiptap/extension-underline@3.29.2`) | Real, genuine npm packages (verified — not homebrewed). Content is stored as native Tiptap/ProseMirror JSON, treated as the canonical format (not translated to/from a separate custom schema) — pragmatic tradeoff: means a future editor swap isn't free, but avoids maintaining a second document format for no real benefit at this stage. Upgraded from v2.27.2 → v3.29.2 on 2026-08-01; the only breaking changes were `BubbleMenu` import path (`@tiptap/react/menus`) and `setContent` second arg (boolean → options object). |
| Frontend | **Vite + React 18**, no Next.js | No SSR need — this is a private, authenticated app behind a login screen, not a public site needing server-rendered pages |
| Version control for content | **simple-git**, a local Git repository on disk | Every save and every manual "snapshot" becomes a real Git commit of the page's Markdown export, giving free diff/rollback history with no separate versioning subsystem to build |
| Testing | **Vitest**, plus Fastify's built-in `.inject()` for integration tests | `.inject()` tests real routes in-process with no network port, no background-process management — chosen after repeated flakiness testing via real `curl` + backgrounded servers during manual development |
| Multi-part uploads | `@fastify/multipart` | — |
| Static frontend serving (prod) | `@fastify/static`, scoped to `/assets/` only | Serving it unscoped was found to shadow unmatched `/api/*` routes with its own internal wildcard handler — see §8's bug log |

**A real, hard-won lesson on dependency versions:** `better-auth`, `drizzle-orm`, `drizzle-kit`, and
`better-sqlite3` have interlocking peer-dependency requirements that caused three separate rounds of
install failures during development. All four are now **pinned to exact versions** (no `^` ranges) in
`package.json`, verified by deleting `node_modules` and `package-lock.json` entirely and reinstalling
from scratch. Do not loosen these pins without re-testing a clean install.

---

## 4. Core architectural decisions — what, and why

### 4.1 The data model: `pages` + `branches`

The single most important design decision in the project. Two tables, deliberately separated:

- **`pages`** — the abstract content itself. Has a permanent ID, a `slug`, the Tiptap JSON content,
  and an `owner_id` (authorship, never changes).
- **`branches`** — a *placement* of a page inside a tree. Points at a `page_id`, has a
  `parent_branch_id` (enabling arbitrary nesting), a `position`, and — critically — its own
  `space_id`, `visibility`, and `is_system` flag.

**Why split this way:** the goal was Trilium's cloning ability (the same content placed in multiple
locations, e.g. an "Antenna Specs" page visible in both a private Amateur Radio space and a public
space) combined with SiYuan's stable-ID referencing. Early in the project, `space_id`/`visibility`
were mistakenly placed on `pages` instead of `branches` — this was caught and fixed before real data
existed: if security context lived on the content itself, a single page could not simultaneously be
"public" in one placement and "private" in another, which is exactly the cloning use case this design
exists to support. **Space and visibility are properties of a placement, not of content.**

**Downstream consequence:** anything permission-sensitive (`group_permissions`, share-link tokens,
sync targets) addresses a **branch**, never a bare page ID — a page ID alone doesn't carry enough
context once cloning is possible.

### 4.2 Permission resolution — one formally-specified algorithm

Implemented once, in `src/shared/permissions/algorithm.ts`, and required by architecture to be the
*only* place permission logic lives — called by REST routes, and designed to be called identically by
any future MCP tools or real-time collaboration checks.

Resolution order, precisely:
1. **System-branch guard** — if the target or any ancestor is `is_system` (e.g. a future Trash
   branch), deny outright unless the requester is a global admin. Checked first, always.
2. **Admin bypass** — a global admin has full access, full stop.
3. **Visibility resolution** — the target branch's own explicit `visibility` (if not `inherit`)
   always wins over any ancestor's; only walk up to ancestors when the target itself is `inherit`.
4. **Local boundary (group permissions)** — walking from the target branch outward, the *nearest*
   branch with an explicit `group_permissions` grant **fully replaces** everything above it — a
   match returns that role, a non-match returns `none`. This is a hard stop, never merged with a
   more permissive value found later. This is what lets a restricted subtree (e.g. HR) exist inside
   an otherwise-open space, or a public subtree exist inside an otherwise-restricted one.
5. **Space fallback** — if no branch-level override exists anywhere in the chain, fall back to the
   requester's space-level role (`space_members` direct role, or the best role available via any
   `space_group_permissions` grant through their groups), floored by the visibility baseline.

Two real bugs were found and fixed in earlier drafts of this exact algorithm (an ancestor's
visibility overriding the target's own explicit setting, and a non-matching local boundary silently
falling through to a public baseline instead of denying) — both are now permanent regression tests in
`src/shared/permissions/__tests__/algorithm.test.ts`, 10 tests, covering every branch of the logic
above including the cloning-across-spaces case.

**Enforcement mechanism:** every `/api/` route (except `/api/auth/*`, which establishes identity
rather than requiring it) must declare a `config.access` policy at route-registration time — either
`"public"`, `"authenticated"`, `"admin"`, a `{ branchParam, minRole }` object (resolved via the
algorithm above), or a `{ spaceParam, minRole }` object for routes not scoped to one specific branch.
This is validated by an `onRoute` hook at **server startup**, not guessed at request time — a route
missing this declaration crashes the server immediately with a clear error naming it, rather than
silently being open or producing a confusing runtime failure. This replaced an earlier, less reliable
attempt to detect "is this a real unconfigured route, or just Fastify's own internal 404 dispatch" by
inspecting request shape at runtime, which was found to be unreliable in production testing.

### 4.3 Users, groups, spaces — how they compose

- **Identity**: better-auth's own tables (`user`, `session`, `account`), `isAdmin` added as an
  additional field. `account` (better-auth's own multi-provider-per-user table) is what handles a
  user having both password and SSO logins resolving to one identity — no separate `identities` table
  was needed once this was recognized.
- **Groups** (`groups`, `user_groups`) are the **sole** permission-granting mechanism — an earlier,
  now-rejected design had a separate per-user grant table alongside groups; it was dropped specifically
  to avoid two overlapping grant paths with no stated precedence. A "just this one person" case is
  handled with a single-member group.
- **Spaces** (`spaces`, `space_members`, `space_group_permissions`) are top-level containers,
  Docmost-style — each space's membership and default role are independent of any other space's.

### 4.4 Tokens — one engine, two purposes

A single `tokens` table backs both **share links** and **API tokens**, distinguished by a `type`
column. Critical, structurally-enforced rule: a share link's `scope_type` can **never** be `"account"`
— it is always scoped to a specific `branch` or `space`, validated by Zod schema at the route level
(so an account-scoped share link is a `400`, not something the code has to remember to check). Raw
tokens are shown once at creation and stored only as a SHA-256 hash — never in recoverable form.

"No expiration" on a share link is a deliberately gated, permissioned action (currently: global admin,
or membership in a group literally named `link-managers` — a placeholder for a fuller capability
system that doesn't exist yet, noted honestly in the code). A watchdog sweep (run hourly from the
background worker) warns the link's creator after a configurable inactivity window, up to three times,
then auto-revokes — verified with a test that backdates a token and runs five simulated sweeps.

**API tokens are now actually usable as credentials.** Previously a token could be created but no
route would accept it — the token engine was inert (a real bug, found during review). Now the
permission middleware accepts `Authorization: Bearer <token>` on every `/api/` route, and enforces the
token's own scope, not just the creator's session:

- `account` scope — the token acts as its creator, with the resolved access **capped** at the token's
  `permission` (a `view` token can never edit, even if the creator is a space admin).
- `branch` scope — grants the token's permission on exactly that branch (branch tokens top out at
  `editor`; there is no branch-level admin).
- `space` scope — grants the token's permission within exactly that space.

Branch/space-scoped tokens are *scoped credentials*: they are rejected (`403`) on general
"authenticated" routes like `/api/spaces` — only account-scoped tokens satisfy those. Password-
protected tokens are deliberately **not** usable as bearer credentials (there is no defined way to
supply a password over the API; using them anyway would silently bypass the protection) — the public
`/api/share/:token` view performs its own password check. Covered by 6 integration tests.

### 4.5 Background jobs and Git versioning

A minimal SQLite-backed job queue (`job_queue` table + a polling worker loop in the same Node
process — no Redis) handles anything that shouldn't block an HTTP response: primarily, converting a
saved page's Tiptap JSON to Markdown and committing it to the local Git repository. Autosave and
manual "Snapshot" commits are distinguished by message format; both are filtered per-page correctly
(a real bug was found and fixed here — manual snapshot commits didn't originally embed the page ID in
their message, which would have caused one page's history view to show *every* page's snapshots).

### 4.6 Settings — system-wide vs. per-user

- **`system_settings`**: admin-only, key/value, with an `is_secret` flag. Secret values (OAuth client
  secrets, email API keys) are encrypted at rest with AES-256-GCM, using a key that lives in an
  environment variable (`SETTINGS_ENCRYPTION_KEY`), never in the database. The server refuses to boot
  without this key set — checked eagerly at startup, matching the same pattern `BETTER_AUTH_SECRET`
  already uses (a real bug was found and fixed where this check only fired lazily on first use,
  producing a confusing runtime `500` instead of a clear boot-time failure).
- **`user_settings`**: per-user preferences, key/value, isolated per user (verified with a real
  cross-user leak test). Currently used for exactly one thing: the editor's full-width/narrow-view
  preference.

---

## 5. What's actually built and tested today

Everything below is verified against the running code, not just described — either by an automated
test or by a manual reproduction during development (both are noted where relevant).

### 5.1 Authentication
Email/password sign-up and sign-in via better-auth, fully working. SSO (Google, GitHub) has
**configuration slots wired but no real credentials** — the code checks for `GOOGLE_CLIENT_ID` etc.
in the environment and only registers the provider if present; nothing will break by their absence,
but no OAuth login is actually usable until real credentials are supplied. Authentik/generic OIDC has
no code at all yet, just a mention in the original design notes.

### 5.2 Permissions, spaces, groups
Full CRUD for spaces (create, list — no delete/rename yet) and groups (create, list, delete, add/
remove members), all admin-gated for groups, all enforced through the one permission algorithm
described in §4.2.

### 5.3 Pages and the tree
- Create a page (top-level, or **nested under any existing page** — this was found completely
  missing from the UI partway through development, despite the backend always supporting it; fixed
  and covered by a 3-level-deep nesting regression test)
- Read a page's content, scoped through a specific branch
- Save (update) a page's content, with **Optimistic Concurrency Control** — a stale save based on an
  outdated `updatedAt` timestamp is rejected with `409`, forcing a reload rather than silently
  clobbering someone else's edit
- **Page/branch cross-validation on save, snapshot, and history** — a real authorization bug was found
  and fixed here: these routes permission-check only the URL's `branchId` but operate on a separate
  URL `pageId`, so anyone with editor access to *any* branch could overwrite/read a page they were
  never granted access to (the file-serving path already defended against the same class of bug; the
  content path didn't). All three now verify `branch.pageId === pageId` and return `404` on mismatch,
  with permanent regression tests (the previously-missing equivalent of the §5.5 file check)
- List a space's full tree structure
- **Clone a page into another space** (`POST /api/branches/:branchId/clone`) — a new placement
  (branches row) for the *same* page content, visibility defaulting to `inherit`. Source requires
  viewer access (you must be able to see what you're cloning); destination requires editor access on
  the target space or target parent (mirroring `POST /api/pages`). Cross-space is the normal case —
  that's the whole point of the pages/branches split
- **Move/reparent a placement** (`PUT /api/branches/:branchId/move`) — same-space only (cross-space
  moves are rejected with a pointer to clone), with a cycle guard (can't move a branch under itself
  or a descendant), editor access required on both the branch being moved and the new parent, and a
  system-branch guard on both ends
- **Rename a page** (`PUT /api/pages/:pageId/branches/:branchId/slug`) — the slug is shared by every
  placement, so it's authorized via a witness branch exactly like content saves, with the same
  page↔branch cross-validation (`404` on mismatch)
- **Delete a placement** (`DELETE /api/branches/:branchId`) — removes one branches row; the page
  persists if other placements exist. Blocked while the placement still has children (they'd
  otherwise be silently reparented) and on system/trash branches
- **Delete a page everywhere** (`DELETE /api/pages/:pageId?branchId=<witness>`) — soft-deletes the
  page row (`pages.deletedAt`, already honored by the tree and page-fetch paths) and removes every
  placement. Requires editor access on **every** placement of the page (not just the witness branch),
  so you can't destroy placements in spaces you only view

### 5.4 The editor
Tiptap bound to the canonical content, autosaving on a debounce. As of the most recent work:
- **Full-width by default**, with a persisted per-user toggle for a narrower reading width
- **Read-only by default**, with an explicit "Edit"/"Done editing" toggle (SiYuan-style) rather than
  always being live-editable — reduces the risk of an accidental keystroke silently autosaving
- A real, visible formatting toolbar (bold, italic, inline code, H1–H3, bullet/numbered lists,
  blockquote, code block, undo/redo) — this did not exist for a meaningful stretch of development;
  formatting only worked via keyboard shortcuts with zero visible UI, which was flagged as a real gap
- **Zero custom CSS anywhere** — verified directly, no stylesheet exists for the editor content at
  all. Headings, code blocks, and lists render with nothing but the browser's bare default styling,
  which is the primary reason the app currently looks far plainer than comparable tools like Docmost
  or SiYuan (this is a styling gap, not a functional one)
- As of the §7.3 work: Image, Link, and Underline extensions are installed. Uploading an image file
  renders an `<img>` node inline; non-image files insert a markdown-style link. The `LinkExtension`
  is configured with `openOnClick: false` (clicking doesn't navigate away) and `autolink: true`
  (pasted URLs auto-convert). A `BubbleMenu` appears on text selection with bold/italic/underline/
  link controls. Tables are still not installed (pending a specific need).

### 5.5 File uploads
Upload and download both work, enforced with a specific security property: a file is only ever served
relative to the specific branch the requester is authorized against — verified with a test proving a
file cannot be fetched via a *different, unrelated* branch even when the requester has full access to
that other branch. A real bug was found and fixed where Fastify's default 1MB body size limit silently
rejected any realistic photo upload with an unhelpful `500`; raised to 25MB and confirmed with tests
that both a 2MB upload succeeds and a genuinely oversized 30MB upload fails cleanly with `413`.

### 5.6 Git versioning, snapshots, history
Every save triggers a real Git commit of the page's Markdown export (verified: an actual `git log`
inspection during testing showed real converted content, not a placeholder). Manual "Snapshot" with a
user message works the same way. **History can be viewed (commit hash, message, date) but cannot be
acted on** — there is no restore/revert endpoint at all. Viewable, not usable, is the honest
description of this feature today.

### 5.7 Templates
A page can be saved as a template (global, admin-only, or personal) and used to seed a new page's
initial content — verified end-to-end including that the seeded content is a genuine copy, not just
non-empty.

### 5.8 Admin settings UI
Group management (create/delete groups, add/remove members) and system settings (set/view/delete,
with secrets properly masked in the list view — verified that a secret value never appears anywhere
in a list response, even as a substring) are both built and reachable via a "Settings" button visible
only to admins.

### 5.9 The critical bug class that was found and closed
Two page-creation code paths were found constructing a Tiptap document with **zero block nodes**
(`{ type: "doc", content: [] }`) — not valid ProseMirror content, meaning a brand-new page's editor
area was completely unclickable, with nothing to type into. Fixed at both the schema default and the
explicit creation-time value; a regression test now confirms every page-creation path (including
template-seeded creation) always produces at least one block node.

### 5.10 Testing
**80 tests, `vitest run` / `npm test`**, all passing from a clean install:
- `src/shared/permissions/__tests__/algorithm.test.ts` — the permission algorithm, all branches
- `src/server/services/__tests__/{crypto,markdown,settings,token,user-settings}.test.ts` — service-
  level unit/integration tests against a real (isolated, disposable) SQLite database
- `src/server/__tests__/{integration,admin.integration,security.integration}.test.ts` — full HTTP-layer
  integration tests via Fastify's `.inject()`, including a dedicated production-mode block that boots
  the app with `NODE_ENV=production` and reproduces the exact static-file-serving bug found during real
  deployment; `security.integration` covers the page/branch cross-validation regression and the
  bearer-token engine (§4.4)
- `src/server/__tests__/page-branch-mutations.integration.test.ts` — 23 tests covering the §7.1
  clone/move/rename/delete endpoints: happy paths, cross-space rejection, cycle guard, branch-level
  grant enforcement on the move target, system-branch protection, children-blocked deletion, and the
  "editor on every placement" rule for delete-everywhere

**Known, acknowledged limitation of the test suite:** it is entirely API/service-level. **Nothing
renders the actual React/Tiptap UI in a browser.** This is precisely why the empty-editor bug and the
missing-toolbar gap were not caught automatically — both were found by a human actually using the app.
If UI-level regressions keep recurring, adding a browser-based test layer (Playwright is the natural
choice) would close this gap; it has not been started.

---

## 6. Deployment

Full step-by-step instructions were planned for a separate `DEPLOY.md` — **that file is currently
missing from the workspace** (a handoff gap, not a code bug); the essentials are summarized here and
the standalone file should be re-created from this before deployment:

- Target: a Debian LXC container, Node 22, reached by its own LAN IP
- `npm ci` (not `npm install` — the exact pinned versions matter, see §3)
- `npm test` should show 80 passing before trusting a build
- `npm run build:client`
- Three environment variables are **mandatory** — the server refuses to boot without any of them,
  deliberately: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (must match the real address the app is
  reached at — a real bug was hit here when this didn't match), `SETTINGS_ENCRYPTION_KEY`
- `npx drizzle-kit push --force` to create the SQLite schema
- First run by hand to create an account, then promote it to admin directly via a one-line Node/
  better-sqlite3 script against the `user` table
- A systemd unit (`EnvironmentFile=` pointed at a real `.env` file) for restart-on-boot/crash

---

## 7. What's left, and how to build it

Ordered by an agreed priority (smallest/most-blocking first), each with the architectural approach
that fits what already exists — not a generic suggestion, the actual pattern to follow given the code
above.

### 7.1 Page clone / delete / move / rename — **built (backend)**
The entire reason the `pages`/`branches` split exists is to support cloning (same page, multiple
branches/placements) — the API surface below now exists, verified by 23 integration tests (§5.10).
The architecture was implemented as specified here:

- `POST /api/branches/:branchId/clone` — body: `{ targetSpaceId, targetParentBranchId }`. Creates a
  new `branches` row with the **same `page_id`**, `visibility` inherit by default,
  permission-checked as `{ branchParam: "branchId", minRole: "viewer" }` on the *source* (you need to
  be able to see what you're cloning) and an editor-level check on the *destination* (space when
  top-level, parent branch when nested — mirroring `POST /api/pages`).
- Delete: two distinct actions, not one — "remove this placement" (`DELETE /api/branches/:branchId`;
  the page persists if other branches exist) vs. "delete this page everywhere"
  (`DELETE /api/pages/:pageId?branchId=<witness>`, which soft-deletes the page via the existing
  `pages.deletedAt` flag and removes every branch). A few deliberate guardrails added while building:
  a placement with children can't be removed/deleted (children would otherwise be silently
  reparented), system/trash branches are protected on every endpoint, and delete-everywhere requires
  editor access on **every** placement of the page, not just the witness branch.
- Move: `PUT /api/branches/:branchId/move` — body: `{ newParentBranchId }`. Permission-checked on
  both the branch being moved and the new parent (or the space itself for moves to the root), with a
  cycle guard (no moving under a descendant) and same-space enforcement (cross-space moves are
  rejected with a pointer to clone).
- Rename: `PUT /api/pages/:pageId/branches/:branchId/slug`, permission-checked exactly the way page
  content saves are, including the page↔branch cross-validation.

**Still open, deliberately:** the original design also called for a soft-delete **trash** (`is_system`
branch) rather than a hard delete; delete-everywhere currently soft-deletes the page row directly.
The `is_system` flag and the permission algorithm's system-branch guard (§4.2, step 1) exist
specifically to support a future trash/restore view — a trash implementation should reuse them, not
reinvent a separate soft-delete mechanism. **No UI exists yet** for any of these endpoints (the tree
component has no clone/move/rename/delete affordances); wiring them in is a natural follow-up with
§7.2's client-side navigation.

### 7.2 Real client-side navigation — **built**
Confirmed: zero client-side routing existed anywhere. The browser URL never changed as you navigated,
which meant nothing was bookmarkable or shareable, and was the direct cause of share links "not
working" — the backend's `/api/share/:token` endpoint was real and functional, but there was no
frontend page that consumed it; pasting that URL just booted the app fresh with no idea what to do
with the token in the URL.

**What was built:**

- **`react-router-dom@7.18.2`** installed. The associated CVE-2025-31127 advisory ("RSC-mode SSRF /
  CSRF") is **non-applicable** to this project: it requires React Server Components (RSC) and the
  `RouterContextProvider` API, neither of which exist in a Vite-built client-side SPA. Documented
  here for the same reason the esbuild and Vite advisories are documented in §8 — the next person
  who runs `npm audit` will see it and should understand immediately it can be ignored.

- **`main.tsx`** wraps the entire app in `<BrowserRouter>` with two top-level routes:
  - `/share/:token` → `<ShareView />` (unauthenticated, no session cookie needed)
  - `*` → `<App />` (the authenticated shell, which contains its own `<Routes>` for
    `/pages/:branchId`, `/settings`, and `/`)

- **`App.tsx`** refactored: the old `useState`-based branch/settings switching is replaced by an
  inner `<Routes>` block. A new `Sidebar` component uses `useNavigate()`, `useParams()`, and
  `useLocation()` to drive the tree and user footer — clicking a page in the tree navigates to
  `/pages/<branchId>`, the Settings button goes to `/settings`, and the selected branch is
  highlighted from the URL. The `Editor` component itself is **unchanged** — it still takes
  `branchId` as a prop, with a thin `EditorRoute` wrapper that reads it from `useParams()`.

- **`ShareView.tsx`** — a standalone unauthenticated component that fetches
  `GET /api/share/:token` (public endpoint, no cookie) and renders the content in a read-only
  Tiptap editor. Password-protected links show an inline password prompt.

- **SPA fallback** was already correct in production (`setNotFoundHandler` serves `index.html` for
  all non-API GETs — §5.6), and Vite's dev server does the same by default. Verified with `curl`:
  `/pages/<id>`, `/share/<token>`, `/settings`, and `/` all return the HTML shell (200, text/html).

### 7.3 Real Tiptap extensions — **built**
Installed `@tiptap/extension-image@3.29.2`, `@tiptap/extension-link@3.29.2`,
`@tiptap/extension-underline@3.29.2`. **Upgraded all Tiptap packages from v2.27.2 → v3.29.2**
(major version; v3.0.0 shipped July 2024 — over two years stable). The only breaking changes were
`BubbleMenu`'s import path moving to `@tiptap/react/menus` and `setContent`'s second argument
changing from `boolean` to `SetContentOptions`. Zero behavioral differences observed.

**What changed in the editor:**

- **Extensions registered:** `Image`, `LinkExtension` (configured with `openOnClick: false` so
  clicking a link doesn't navigate away from the app; `autolink: true` so pasting a URL
  auto-converts to a link), and `Underline`.
- **`BubbleMenu`** added — when text is selected in editing mode, a small floating toolbar appears
  near the cursor with Bold, Italic, Underline, and Link controls. The link button edits or removes
  the link on the current selection.
- **Toolbar updates:** new **U** (underline), **🔗** (set link via prompt), and **🖼** (insert image
  — triggers the same file-upload flow as the header's "Upload file" button) buttons.
- **Image upload fixed:** the `uploadFile` handler now checks `file.type.startsWith("image/")` and
  calls `editor.chain().focus().setImage({ ... })` instead of inserting the literal text
  `[filename](url)`. Non-image files still produce a markdown-style link.

**Round-trip verified** with `curl`: content containing underline marks, link marks (with `href` and
`target` attrs), and `image` nodes are all preserved through `PUT /api/pages/:id/branches/:bid` →
`GET /api/branches/:bid/page`.

**Not done (deferred):** CSS for the editor content area — images render at whatever their natural
size is and the ProseMirror default link styling applies; a proper content CSS module with image
sizing, link colors, and table styles is §7.3's CSS follow-up.

### 7.4 Snapshot/version restore — **built ✓**
History is viewable (§5.6) and now actionable. Built 2026-08-01:

**Backend:**
- `markdownToTiptap()` in `markdown.service.ts` — a dependency-free reverse converter handling all
  the same node and mark types as the forward converter (headings 1–6, paragraphs, code blocks,
  blockquotes, bullet/ordered lists with nesting, horizontal rules, images, and inline bold/italic/
  code/link marks). Built without remark/unified to mirror the forward converter's approach.
- `getFileContentAtCommit(pageId, commitHash)` in `git.service.ts` — uses `git show` to retrieve
  a page's Markdown content at a specific commit, trying the snapshot path (`_snapshots/<pageId>.md`)
  first, then falling back to `diff-tree` to discover the space-path filename.
- `POST /api/pages/:pageId/branches/:branchId/restore` route (editor access required) — body:
  `{ commitHash }`. Reads the Markdown at that commit, converts it back to Tiptap JSON, and saves
  it as a new forward-moving version (itself creating a fresh autosave commit — restore is a
  forward edit, not a git-history rewrite). Uses OCC with the current `updatedAt` fetched at
  restore time.
- Client API: `api.restoreHistory(pageId, branchId, commitHash)` added to `client.ts`.

**Frontend:**
- Each history entry in the Editor sidebar now shows a "Restore" button (visible only when the user
  has editor access). Confirms with the user before restoring, disables the editor during the
  operation, and reloads the page content on success.

**Bug fixed in passing:** `initGitRepo()` previously used `simple-git`'s `checkIsRepo()` which
traverses upward to parent `.git` directories — if the app's working directory was inside another
git repository (common in development and deployment), it would falsely report "already initialized"
and skip `git init`/`git config`, causing every commit to fail with "Author identity unknown".
Fixed by checking for `.git` inside `REPO_ROOT` directly via `fs.access()`.

**Smoke-tested with `curl`:** create page → save v1 → snapshot → save v2 → restore from v1 snapshot
→ verify content matches v1 (heading, bold marks preserved through Markdown round-trip).

### 7.5 Slash commands, via a real plugin registration system — **built ✓**

Built 2026-08-01. Three layers, bottom-up:

**Plugin engine** (`pluginEngine.ts`) — a central registry with three registration hooks:
- `registerSlashCommand(name, group, label, icon?, description?, command)` — registers a `/`-triggered command for the suggestion menu. Commands are grouped by category (Headings, Text, Lists, Content) with icons and descriptions.
- `registerToolbarButton(name, label, title?, group?, isActive, onClick)` — registers a toolbar button. Buttons in the same `group` sit together with separators between groups.
- `registerEditorExtension(extension)` — registers a Tiptap extension for the editor instance.
- `getSlashCommands()`, `getToolbarButtons()`, `getEditorExtensions()` — query the registry.

**Slash command extension** (`slashCommandExtension.tsx`) — a Tiptap extension wrapping `@tiptap/suggestion` (`@tiptap/suggestion@3.29.2`). The `/` character triggers a React-rendered popup (`SlashCommandPopup.tsx`) positioned via the suggestion plugin's `clientRect`. Keyboard navigation (↑↓/Enter/Escape) works. The command handler deletes the `/` + query range before executing the selected command. The popup renders grouped sections with section headers.

**Core dogfooding** (`editorPlugins.ts`) — all existing hardcoded toolbar buttons and the slash command extension itself are registered through the engine, proving the registration surface is sound:
- 12 slash commands: Headings 1–6, Paragraph, Blockquote, Code block, Bullet list, Numbered list, Horizontal rule, Image (URL prompt)
- 13 toolbar buttons (5 groups: marks, headings, blocks, plus image/undo/redo which remain outside the registry for now since they need non-standard callbacks)

**Toolbar refactored:** `Toolbar.tsx` now reads `getToolbarButtons()` from the engine and renders buttons grouped by their `group` name with separators, eliminating all hardcoded button JSX.

**Editor updated:** `Editor.tsx` imports `editorPlugins.js` to populate the registry at startup and passes `getEditorExtensions()` into the `useEditor` extensions array alongside the base extensions (StarterKit, Image, Link, Underline).

**Verified:**
- TypeScript, build, all 80 tests pass (`npm test`)
- Live browser smoke test: signed up, created page, typed `/` — popup appeared with all groups and commands — clicked H1 — `/` deleted, empty H1 created. Toolbar renders from registry with correct grouping and separators.

The Image slash command and the 🖼/↶/↷ toolbar buttons remain outside the registry for now (they need callbacks that are editor-specific: image opens a file picker, undo/redo don't fit `isActive`). These are reasonable to keep direct — the engine is proven functional for the main pattern.

### 7.6 Inline comments — **genuine new subsystem, not a feature add-on**
Needs its own schema (a `comment_threads` table anchored to a text range in a page, a `comments`
table for individual replies within a thread) and its own permission-checked CRUD API, reusing
`resolveAccess()` from §4.2 rather than inventing new permission logic. **A real, confirmed
architectural gap was found while scoping this:** the plugin engine (§7.5) has no mechanism for a
plugin to bring its own database tables — every current plugin hook operates on data that already
exists. This means comments' *data model and API* must be core code, not a plugin, even though the
*UI* (sidebar thread panel, highlight mark on commented text) is a legitimate candidate to build via
the plugin registration hooks from §7.5, once those exist.

### 7.7 Web clipper — **backend piece is small; the browser extension is its own project**
Two genuinely separate pieces:
- **Backend "clip" endpoint** (`POST /api/clip` — accepts HTML + source URL + title, creates a page):
  the Markdown→Tiptap reverse converter now exists (built for §7.4, see above), so the conversion
  pipeline is ready — what remains is the route itself plus an HTML→Markdown step (e.g. `turndown`
  or `rehype-remark`). Building this both unblocks the clipper and was needed for version restore
  (§7.4) — now built once, usable by both.
- **An actual browser extension**: a real, separate codebase (its own `manifest.json`, a content
  script, its own build process) — not part of this app's frontend at all. Should authenticate back
  to the server using the API token engine (§4.4) as a `space`-scoped bearer token — the engine is
  now genuinely functional (it was inert before the security pass; see §4.4).

### 7.8 Not on the immediate list, but real, acknowledged gaps for later
- **Real-time collaboration** (Hocuspocus/Yjs) — planned in the original design (with a specific,
  already-reasoned-through rule: only enabled for single-branch pages, since a cloned page's multiple
  placements would otherwise leak live keystrokes across security boundaries), not started
- **MCP server** exposing pages/search/etc. as tools for AI agents — designed, not started
- **Instance-to-instance sync** (pushing specific spaces to a smaller public-facing deployment) — the
  original motivating use case for public publishing, not started
- **Outbound email** — the share-link watchdog (§4.4) currently logs warnings to `system_logs` rather
  than emailing anyone; no mailer is wired up
- **Theming engine** — no CSS variables/token system exists; tied to the CSS gap in §7.3

---

## 8. A note on process — why this document can be trusted

Every claim above about what's "built and tested" was verified directly against running code during
this project — actual `curl`/`.inject()` requests, actual database inspections, actual `git log`
checks — not inferred from what was intended or previously reported. Several real bugs were found
specifically *because* of this discipline (the empty-document bug, the file-size-limit bug, the
production static-serving routing bug, the malformed Git author string, the lazy-vs-eager encryption
key check), each with a permanent regression test added afterward.

**A dedicated security review pass added two more** (also each with regression tests):
- the page/branch decoupling bug in save/snapshot/history (§5.3) — a cross-branch content
  overwrite/read, proven exploitable against the running app before the fix;
- the inert API-token engine (§4.4) — tokens could be created but no route accepted them.

The same pass upgraded `@fastify/static` to a patched release (clearing all high/critical audit
findings), removed the unused `react-router-dom` (no clean version existed at the time; §7.2
re-installs it), removed the broken `db:migrate` script, and deliberately **deferred** the one
remaining audit item — `esbuild` via the Vite dev server (moderate, dev-only, fix requires a
breaking Vite 5→8 upgrade that conflicts with the pinning discipline in §3; revisit when the
toolchain is next refreshed).

The one honest, acknowledged limit to this discipline is noted in §5.10: the test suite has no
browser-level coverage, so anything that
only manifests visually in the UI is not automatically guarded against yet.
