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
- A real, visible formatting toolbar (bold, italic, underline, inline code, H1–H3, bullet/numbered/
  task lists, blockquote, code block, highlight, align left/center/right, undo/redo) rendered from
  the plugin registry (§7.5) — plus a drag-handle block menu and a search-&-replace popover
- **Task lists** (checkbox toggle, nested), **highlight**, and **text alignment** all work and
  persist — verified live: typing `/hig` filters the slash menu to Highlight and clicking it inserts
  cleanly with no leftover query text; alignment center persists as `textAlign: center` on the block
- **Slash command extension fixed for filtering + click** — the menu used to disappear once a
  multi-character query was typed, and clicking a command after typing a query left the query text
  behind; both fixed in `slashCommandExtension.tsx` (`allow` now checks the text before the caret
  ends with `/` + query; the React renderer keeps a `latestProps` ref so the popup handlers always
  use the current `range`/`command`)
- As of the §7.3 work: Image, Link, and Underline extensions are installed. Uploading an image file
  renders an `<img>` node inline; non-image files insert a real link node (via the same
  `markdownToTiptap` converter used for markdown paste — previously they inserted literal
  `[name](url)` text). The `LinkExtension` is configured with `openOnClick: false` (clicking doesn't
  navigate away) and `autolink: true` (pasted URLs auto-convert). A `BubbleMenu` appears on text
  selection with bold/italic/underline/link controls. Tables are still not installed (pending a
  specific need).
- **The Image node is configured `inline: true`** (`baseExtensions.ts`), matching what the markdown
  importer/exporter already emit (`![alt](src)` → `paragraph > image`). This was a real bug: with the
  default block-level image, any page whose markdown contained a standalone image line had *invalid
  content* (`contentMatchAt` threw on every later insert), so file uploads silently did nothing on
  affected pages. Inline images render with invisible `.ProseMirror-separator` placeholder `<img>`s
  (standard ProseMirror cursor-positioning behavior) — browser/DOM tests must exclude them with
  `img:not(.ProseMirror-separator)`. Uploads are laid out Docmost-style: the image always lands on its
  own line (paragraph split before and after), never side-by-side with existing text — see the
  `uploadFile` command-order note in §5.5.
- Styling status: the editor and app render with custom CSS in `src/client/theme.css`, but a formal
  theming/token system (CSS variables, light/dark/contrast themes) is still on the board as §7.8a.

### 5.5 File uploads
Upload and download both work, enforced with a specific security property: a file is only ever served
relative to the specific branch the requester is authorized against — verified with a test proving a
file cannot be fetched via a *different, unrelated* branch even when the requester has full access to
that other branch. A real bug was found and fixed where Fastify's default 1MB body size limit silently
rejected any realistic photo upload with an unhelpful `500`; raised to 25MB and confirmed with tests
that both a 2MB upload succeeds and a genuinely oversized 30MB upload fails cleanly with `413`.

The upload **button** now lives on the editor toolbar (`🖼`/`📎` — it clicks a hidden
`<input type="file">`), so the page content is never touched while just viewing. Two upload bugs were
fixed in the current phase: (1) image uploads — and non-image uploads too — silently did nothing on
pages whose doc contained a block-level image inside a paragraph (`contentMatchAt` threw); the schema
now declares `Image` as `inline: true`, which also matches what markdown import/export emit, so no
page can hold invalid content. (2) Non-image files now insert a real link node via `markdownToTiptap`
instead of the literal text `[name](url)`. A schema-level regression test asserts `image` is inline
and that `paragraph { image }` validates; three E2E tests cover the toolbar upload, upload-on-top-of-
markdown-imported-content, and anonymous share-view image rendering.

A third upload bug was found and fixed 2026-08-04: image uploads after typing text threw
`RangeError: Position N out of range` whenever the cursor sat in a non-empty paragraph. `uploadFile`
ran `splitBlock → setImage → splitBlock` through a **single Tiptap chain**; chained commands share one
transaction, and Tiptap's `splitBlock` command reads the transaction's *already-mapped* selection
(`tr.selection`) and maps it a **second** time through `tr.mapping`, so the final position landed past
the end of the document. Fix: dispatch the three commands **separately**
(`ed.commands.splitBlock()`, then `ed.commands.setImage(...)`, then `ed.commands.splitBlock()`), so
each runs against a fresh state and the selection is remapped exactly once. This also enforces the
Docmost-style layout rule — an image always lands on its own line (a non-empty paragraph is split
before the image, and a trailing empty paragraph is split after it) — without the chained-command
position drift. Covered by the E2E "shared page renders embedded images" test and the manual 21-check
run.

### 5.6 Git versioning, snapshots, history
Every save triggers a real Git commit of the page's Markdown export (verified: an actual `git log`
inspection during testing showed real converted content, not a placeholder). Manual "Snapshot" with a
user message works the same way. **History is viewable (commit hash, message, date) and actionable** —
each entry has a Restore button (editor access required) that reads the Markdown at that commit,
converts it back to Tiptap JSON, and saves it as a new forward-moving version (§7.4). Verified live in
this phase: restoring a commit whose Markdown contains task lists and `==highlight==` reconstructs the
task items (with checked state) and highlight marks correctly, and the regenerated export matches.

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
**166 unit/integration tests, `vitest run` / `npm test`**, all passing from a clean install, **plus
11 Playwright E2E tests** in `e2e/` (2 specs, headless Chromium against the production build):
`editor-features.spec.ts` (6 tests) covers slash-menu selection, wiki-link insert, @mention insert +
saved JSON, toolbar image upload, upload on top of markdown-imported image content (regression for
the `contentMatchAt` bug), and anonymous share-view image rendering; `wiki.spec.ts` (5 tests) covers
sidebar, space/page creation, edit/save, Cmd+K palette, and settings. Image assertions in browser
tests use `img:not(.ProseMirror-separator)` because inline images render ProseMirror's invisible
separator placeholders. Run with `npx playwright test --config=e2e/playwright.config.ts` (the
webserver config auto-stops any stale dev server that would otherwise be reused on port 3000):
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

**Known, acknowledged limitation of the test suite:** the unit/integration layer is entirely
API/service-level; the React/Tiptap UI is covered only by the Playwright E2E layer (which has its own
gap: it drives the DOM, so invisible ProseMirror internals like the `.ProseMirror-separator`
placeholders and Tiptap's cosmetic React "duplicate key `marks`" warning are not covered). The
empty-editor and missing-toolbar bugs were only caught by a human using the app; the E2E suite now
includes regression tests for the editor flows that historically broke (uploads, markdown paste,
share rendering).

**Manual verification harness (`e2e/manual-verify.mjs`, 26 checks):** a headless-Chromium script that
runs against the dev server and asserts the UI-level behaviors the E2E specs don't cover: narrow view
(canvas narrows to 780px while header/toolbar stay full-width), slash-menu alias search, image-own-line
layout, attachment `data-kind` icon, invisible separators, comment hover popup (appears/shows body/
shows author), sticky comment panel, **search palette (Pages section, content-word match, matching
slug, Spaces section, space match)**, and tree chevron/collapse/expand/indent. All 26 checks pass.
Dev-server helper `e2e/start-dev-server.sh` records the exact env vars needed to run the real app
for manual verification (no `.env` file exists in the repo).

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
  blockquotes, bullet/ordered lists with nesting, task lists (`- [ ]`/`- [x]`), horizontal rules,
  images, and inline bold/italic/code/link/highlight (`==…==`) marks). Built without remark/unified
  to mirror the forward converter's approach. Task-list and highlight support added in Phase 2
  (2026-08-01) so restored history that contains them round-trips losslessly.
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

**Status: BUILT** (schema, permission-checked CRUD routes, CommentPanel sidebar, `@sereneinserenade/tiptap-comment-extension`
mark rendered as `span[data-comment-id]`/`.wiki-comment`, resolve/reply/delete). Three anchoring bugs
were found and fixed on 2026-08-01, verified live:
- **Mark never applied at creation:** `addCommentOnSelection` captured `from`/`to`, then opened a
  native `window.prompt()` — the prompt steals focus and collapses the editor selection, so
  `editor.chain().setComment(threadId)` ran `setMark` against a collapsed selection and highlighted
  nothing. Fix: re-select the captured range explicitly
  (`setTextSelection({ from, to }).setComment(...)`) after the prompt returns. (Docmost — the closest
  upstream reference, same Tiptap comment mark — never hits this because its comment entry is an
  inline React popup, not a native prompt.)
- **Highlights lost on reload:** the `comment_threads` row (with `rangeFrom`/`rangeTo`) is the
  canonical anchor, but nothing re-applied marks from it — marks only rendered when they happened to
  be serialized into the saved doc JSON. Fix: after `setContent`, `Editor` fetches the page's threads
  and re-applies a `comment` mark at each thread's stored range (clamped to the current doc, skipping
  ranges already anchored and preserving the user's selection). Marks applied this way are also
  autosaved back into the doc JSON, so the JSON heals over time.
- **Comments on code blocks were invisible (the Linux page bug):** ProseMirror's stock `codeBlock`
  node forbids ALL marks (`marks: ""`), so `Transform.addMark` (which checks
  `parent.type.allowsMarkType`) silently dropped the comment mark — the thread existed in the DB and
  the panel, but no text was ever highlighted, and nothing was clickable. Fix: `baseExtensions.ts`
  now registers a custom `CommentableCodeBlock` (`CodeBlock.extend({ marks: "comment" })`) that allows
  only the `comment` mark inside code (bold/italic/underline still forbidden). This is a one-line
  schema override; the same `setMark`/re-anchor paths then work in code blocks, and `$from.marks()`
  still surfaces the mark to the comment extension's `onSelectionUpdate` (click-to-open works).
- **`comment_threads.selection`** column added (nullable text): the exact selected text is captured at
  creation and shown in the CommentPanel as an "ON SELECTION" block — so a note visibly states what it
  references even if the position range later drifts. Backfilled for existing threads from their
  current doc text via `prosemirror-model`. The block is clickable and scrolls the editor to the
  highlighted span with a `comment-flash` pulse (mirrors Docmost's `.comment-highlight` jump behavior).
- **Hover popup stuck on "…" (fixed 2026-08-04):** the popup component's load effect included
  `state.threadId` in its dependency array, so every thread change (including the initial `null → id`
  transition and any re-render where the object identity changed) tore down an in-flight fetch and
  started a new one — the first request's abort raced the second, and the popup never resolved its
  loading state. Fix: the effect now guards with a ref and omits `state.threadId` so it fetches once
  per mount; covered by the manual-verify "hover popup appears / shows body / shows author" checks.

Reference source for these choices was pulled into `../reference/` (workspace root, not part of this
repo): `docmost`, `siyuan-note/siyuan`, `zadam/trilium` (all shallow clones). A deep-dive comparison
of exactly how each tags a comment to its text, done 2026-08-01:

**Docmost (closest upstream — same Tiptap comment mark, same `span[data-comment-id]`/`.comment-mark`):**
- *Create:* bubble-menu "Comment" item generates a `uuid7()` client-side, applies an immediate
  **ProseMirror `Decoration`** (`setCommentDecoration()`, `comment-decoration.ts`) so the user sees the
  highlight while composing, shows an inline React popup (never a native prompt, so the selection is
  never lost), then on save calls `setComment(createdComment.id)` + `unsetCommentDecoration()`. The
  `selection` snippet is stored with the comment and rendered as a clickable `.textSelection` box.
- *Click highlighted text → open comment:* the mark's `renderHTML` builds a **DOM element with a click
  listener** that dispatches a bubbling `CustomEvent("ACTIVE_COMMENT_EVENT", {detail: {commentId}})`;
  `page-editor.tsx` listens on `document` and opens the aside panel on that thread.
- *Click comment in panel → find text:* `handleCommentClick` does
  `document.querySelector('.comment-mark[data-comment-id=…]').scrollIntoView()` and adds a temporary
  `.comment-highlight` class (red→gold 3s `flash-highlight` keyframe).
- *Persistence:* mark serialized in the doc JSON; resolved state rendered as `.comment-mark.resolved`
  (no styling).
- *Code blocks:* Docmost's `CustomCodeBlock` also keeps `marks: ""` — so their comment mark has the
  **same silent-drop limitation in code blocks**; they do not special-case it. Our
  `CommentableCodeBlock` override is strictly better here.

**SiYuan (block-ID model — most robust, structurally different):**
- Every block (paragraph/heading/list/code) carries a stable `data-node-id`; cross-references are
  block refs (`data-type="block-ref" data-id="…"`), not char ranges, so they never drift.
- Inline notes are `inline-memo` marks (`data-type="inline-memo"`, content stored in
  `data-inline-memo-content` on the element itself, written back through Lute to the .sy file);
  clicking one opens `protyle.toolbar.showRender(...)` to view/edit. This is the closest analogue to
  our comment mark, but the memo text is embedded in the doc rather than a separate thread table.
- Block-level "备注" (remarks) attach to a block's `protyle-attr`, shown as a marker beside the block.

**Trilium (CKEditor5 — different paradigm):**
- References are **inline widgets** (`<span class="reference-link">`) inserted where text is allowed
  (`allowWhere: '$text'`, `isObject: true`), holding a note `href`; they are chips, not marks over a
  selection. No inline text-annotation system comparable to Docmost/SiYuan/our app.
- Trilium is single-user; versioning/history is handled by its own note revision system, not relevant
  to collaborative comment anchoring.

**Net takeaways applied to this app:** (1) comment mark + stored selection snippet (Docmost) is the
right model and is what we built; (2) the draft-time Decoration and inline popup are worth adopting if
the native `window.prompt` ever causes selection loss again; (3) our `$from.marks()`-based click
activation is equivalent to Docmost's DOM-event approach for normal text AND now works in code blocks
too; (4) block-ID anchoring (SiYuan) or inline reference widgets (Trilium) would be a larger schema
change — deferred; the `selection` snippet already mitigates range drift in the UI.

### 7.7 Web clipper — **backend endpoint is built; the browser extension is its own project**
Two genuinely separate pieces:
- **Backend "clip" endpoint** — **BUILT** (`POST /api/clip`, `clip.routes.ts`): accepts HTML +
  source URL + title + spaceId, converts via `turndown` (HTML→Markdown) then
  `markdownToTiptap` (built for §7.4) into a new page. Validates editor access on the target space.
  What it does NOT yet do (Trilium comparison, see §7.9): no Readability extraction server-side,
  no de-dup by source URL (re-clipping the same page creates a duplicate instead of appending),
  no image download/hosting, no selection/screenshot clip modes.
- **An actual browser extension**: a real, separate codebase (its own `manifest.json`, a content
  script, its own build process) — not part of this app's frontend at all. Should authenticate back
  to the server using the API token engine (§4.4) as a `space`-scoped bearer token — the engine is
  now genuinely functional (it was inert before the security pass; see §4.4). Reference:
  Trilium's web-clipper (`reference/trilium/apps/web-clipper`, wxt-based) is the model to imitate.

### 7.8 Not on the immediate list, but real, acknowledged gaps for later
- **Real-time collaboration** (Hocuspocus/Yjs) — planned in the original design (with a specific,
  already-reasoned-through rule: only enabled for single-branch pages, since a cloned page's multiple
  placements would otherwise leak live keystrokes across security boundaries), not started
- **MCP server** exposing pages/search/etc. as tools for AI agents — designed, not started
- **Instance-to-instance sync** (pushing specific spaces to a smaller public-facing deployment) — the
  original motivating use case for public publishing, not started
- **Outbound email** — the share-link watchdog (§4.4) currently logs warnings to `system_logs` rather
  than emailing anyone; no mailer is wired up
- **Theming engine** — see §7.8a below

#### 7.8a Theming — **COMPLETED (2026-08-02)**
Status: done. A full design-token rewrite of `src/client/theme.css` plus class-hook refactors so the
whole app is theme-driven. What shipped:
- **Token system**: single `:root` block (light) with `[data-theme="dark"]` and `[data-theme="contrast"]`
  overrides. Tokens cover surfaces (`--color-bg*`, `--color-surface*`), borders, text (3 shades +
  placeholder), accent (`--color-primary*`, `--color-link`, `--color-focus-ring`), semantic
  (danger/warning/success + tinted backgrounds), code/prose (code bg/text, inline-code, highlight,
  blockquote, table header), selection, scrollbars, typography scale, spacing scale, radii, shadows,
  layout vars, transitions, z-index. Native controls follow the theme via `color-scheme`.
- **Global polish**: `::selection`, `:focus-visible` ring, thin theme-aware scrollbars, form-control
  focus rings, button hover/active/disabled transitions.
- **Component stylesheet** (class-based, replacing scattered inline styles): sidebar footer +
  avatar chip + theme switcher, sidebar tree (hover/selected + primary indicator + reveal-on-hover
  row actions), page chrome (slug pill, status colors, action buttons incl. primary/success variants,
  conflict banner, history list), toolbar (grouped, active state), login card, settings page
  (cards/pills/buttons), comment panel, share page, public shell, popups (slash menu, bubble menu,
  drag-handle menu), editor typography (headings with subtle bottom borders, blockquote, code blocks,
  tables, task-list checkboxes, `mark` highlight, comment marks + flash animation, drag handle,
  search-result decorations).
- **Bug fixed**: `SlashCommandPopup` previously hardcoded `#fff`/`#f0f0f0`/`#999` — it rendered as a
  white card in dark/contrast themes. Now uses the shared `wiki-popup`/`popup-item` classes.
- **Verified live** (Vite + API): light/dark/contrast all render correct token values (sampled pixels
  match `#0d1117`/`#161b22`/`#1c2128` dark tokens and `#000` contrast); slash popup interior =
  `--color-surface-elevated`, selected item = `--color-primary`; login card + settings cards render;
  sign-up flow works. All 111 tests + typecheck + `vite build` pass.
- Note: inline styles remain in a few spots (AdminSettings table rows, TreeItem clone row) but they
  already reference CSS variables, so they theme correctly.

---

### 7.9 Planning record — plugin engines, web clipper, and the SiYuan block-ID model
Deep-dive comparison done 2026-08-01 against the three shallow-cloned reference repos
(`reference/{docmost,siyuan,trilium}`). User decision: **implement the SiYuan block-ID model**
(block-stable anchoring for comments, plus block refs/backlinks) and **model the web clipper on
Trilium's**. Planning only — no code changes yet.

#### 7.9a Plugin engine: ours vs Trilium vs SiYuan — verdict: NOT comparable yet
Our engine (`client/features/editor/pluginEngine.ts`) is a **first-party, compile-time registration
surface** — three arrays (`registerSlashCommand`, `registerToolbarButton`, `registerEditorExtension`)
populated at module load. Core features dogfood it (proving the shape is sound), but it has none of
the runtime machinery of either reference:

**Trilium** (`packages/trilium-core/src/services/script.ts`, `script_context.ts`, `handlers.ts`,
`backend_script_api.ts`):
- Notes of type "Code: JS backend/frontend" / "Render" / "Widget" are the plugins; they are executed
  via `eval()` in a `ScriptContext` that injects a ~90-method `api.*` object (createNote, getNote,
  searchForNotes, attributes, sql, cloning, launcher, options, backup, markdownToHtml, …).
- **Attribute-based hooks**: relations on any note to a script note, e.g. `runOnNoteCreation`,
  `runOnNoteTitleChange`, `runOnNoteContentChange`, `runOnAttributeChange`, `runOnBranchChange`,
  `runOnNoteDeletion`; `handlers.ts` subscribes an internal `eventService` and dispatches. This is
  the most valuable extension point we lack.
- Security: `backendScriptingEnabled` global toggle is the real boundary; `ScriptContext` has a
  module allowlist (dayjs, marked, turndown, cheerio, axios, …) and a hard blocklist
  (child_process, fs, os, net, path, …).
- ETAPI (token-based external HTTP CRUD for notes/branches/attributes/revisions) — our MCP server
  (§7.8d) is the analogous external surface.

**SiYuan** (`app/src/plugin/`): class-based, installable bundles.
- `class MyPlugin extends Plugin` with lifecycle `onload()`, `onunload()`, `uninstall()`,
  `onDataChanged()`; loaded by `loader.ts` via `/api/petal/loadPetals`, `eval`'d with
  `require('siyuan')` returning the `API` object.
- Rich API: `Constants`, `Dialog`, `Menu`, `Setting` (declarative settings UI), `Protyle`/
  `ProtyleMethod` (editor manipulation), `openTab`/`openWindow` (doc by block id), `showMessage`,
  `fetchPost`/`fetchSyncPost`, `getAllEditor`, `platformUtils`, `expandDocTree`, `openAttributePanel`.
- **EventBus** per plugin (`on/once/off/emit`) for subscribing to app events (context menus, tabs…).
- **Kernel plugins** (`kernel.rpc.call/notify/bind`, JSON-RPC over POST + WebSocket) extend the
  backend, not just the UI.
- UI surfaces a plugin can add: `topBarIcons`, `statusBarIcons`, `docks` (custom panels),
  `models` (custom tab content), `protyleSlash` (slash commands — same concept as ours),
  `customBlockRenders`, `commands` (keymap), `agentActions`, plus `plugin.data` key-value storage
  and i18n. Distribution = bazaar marketplace.

**What a realistic "comparable" upgrade looks like for us** (phased, first-party-first):
1. **Lifecycle** — plugins get `onLoad`/`onUnload`/`onSettingsChange` instead of bare arrays.
2. **Event bus** — a typed pub/sub (`on`/`off`/`emit`) for editor, document, and tree events
   (Trilium's eventService, SiYuan's EventBus).
3. **Server-side hooks** — `runOn*`-style hooks for first-party modules: `onPageCreated`,
   `onPageContentChange`, `onCommentCreated`, `onBranchCloned`, … dispatched from the REST routes /
   collab layer. This is the piece with the most practical value and the cheapest to build for
   first-party code (no sandbox needed — the sandbox is only needed if third parties ship code).
4. **Plugin data** — a key-value JSON store keyed by plugin name (SQLite, like SiYuan `plugin.data`).
5. **Settings UI** — a declarative settings schema rendered by the existing admin/settings UI.
Only *if* third-party distribution ever becomes a goal would we need sandboxing/eval (which is a
security program of its own — Trilium guards it with a kill-switch and blocklist; SiYuan ships
plugins as trusted marketplace bundles).

#### 7.9b Web clipper — Trilium is the model; gaps to close
Trilium's clipper (`apps/web-clipper`, wxt browser-extension framework):
- **Clip modes**: save selection, save whole page, save tabs, cropped screenshot (drag-select
  overlay), whole-page screenshot, save link-with-note; plus a "already clipped" popup status and a
  search trigger.
- **Extraction**: clones the DOM and runs Mozilla **Readability** (`lib/Readability.js`) to get the
  readable article body; makes links absolute; rewrites `<img>` to uploaded attachments
  (`entrypoints/content/index.ts` → `background` → server `POST /clippings`).
- **Server-side** (`apps/server/src/routes/api/clipper.ts`): sanitizes HTML, downloads images via
  `noteService.downloadImages`, and **de-dups by source URL** — a `pageUrl` label lookup means
  re-clipping the same page *appends to the existing note* instead of duplicating. Clips land under
  today's daily note or a `clipperInbox`-labeled note.
Ours today: `POST /api/clip` exists but takes already-clean HTML; no Readability, no de-dup, no
images, no selection/screenshot modes, no extension.
**Direction agreed with user** (Trilium-style):
1. Server: add **de-dup by `sourceUrl`** (store a `sourceUrl` column/label on the page; on re-clip,
   append to the existing page instead of creating a duplicate); accept image data-URLs and persist
   them via the existing file-upload path.
2. Client: a real browser extension (or a bookmarklet first) that runs Readability in-page, offers
   clip mode (article / selection), authenticates with a space-scoped token (§4.4), and POSTs to
   `/api/clip`.
3. Screenshot + tabs modes = later, optional (heaviest lift).

#### 7.9c SiYuan block-ID model — the agreed implementation plan (Phases 1–3 DONE, Phase 4 = §8.2)
**Status (2026-08-02):** Phases 1 (block IDs everywhere) and 3 (block-anchored comments) of the plan
below are **implemented and tested**. Phase 2 (backfill) landed at the same time as Phase 1 via
server-side `ensureBlockIds()` on every write path — see "Block-ID model — what shipped" at the end
of this section. Phase 4 (block refs + backlinks) remains open as §8.2.

Why: our comment threads anchor to **character offsets** (`comment_threads.range_from/range_to`),
which drift on edit; the `selection` snippet only softens that. SiYuan solves it structurally:
every block carries a stable `data-node-id`, and references point at the ID, never at a char range.

**SiYuan mechanics observed in reference source:**
- Block ID format `YYYYMMDDHHMMSS-XXXXXXX` — 14-digit local time + `-` + 7 random chars
  (`kernel/util/path.go` `NodeIDByTime`; Lute's `ast.NewNodeID()`), sortable and collision-resistant.
- IDs live on the DOM as `data-node-id`; references are `data-type="block-ref" data-id="…"` inline
  spans; inline annotations are `data-type="inline-memo"` marks (`protyle/toolbar/InlineMemo.ts`).
- Backlinks are computed by scanning all docs for refs to an ID and stored in a SQL `refs` table
  (`kernel/sql/upsert.go`, `kernel/model/backlink.go` `RefreshBacklink`); a mention (`[[…]]`) is a
  second reference flavor (`backmention`).

**Plan phases for our app (Tiptap v3 / Yjs):**
1. **Block IDs in the schema.** Tiptap v3 has no bundled global-attributes extension (checked; not
   installed). Add a stable `id` attribute to every block-level node (paragraph, heading, codeBlock,
   blockquote, listItem, image, …) — either a `withBlockId()` node factory mirroring the existing
   `CommentableCodeBlock` pattern, or explicit per-node `addAttributes` that preserves an existing
   `id` on parse and generates one on create (timestamp-prefixed like SiYuan for sortability).
   Serialization is automatic (content is stored as Tiptap JSON), and Yjs syncs attrs natively.
2. **Backfill migration.** Walk every page's stored JSON, assign missing block IDs, persist. Only
   two real pages exist today, so this is cheap and safe.
3. **Re-anchor comments to blocks.** Add `comment_threads.block_id` (nullable). On create, record
   the block containing the selection start (+ relative offset within the block). On load,
   find the block by ID and apply the comment mark at the absolute position derived from it; if the
   block is gone, fall back to the existing `selection`-snippet search. This makes comments survive
   insertions/edits that don't delete their block — the permanent highlight fix the user asked for.
4. **Block refs + backlinks** (superset of the pending "internal page linking / backlinks" item).
   Add an atomic inline `blockReference` node (id attr; renders as a chip with the target's text
   preview). Slash command + search to insert. A server endpoint scans page JSONs for `blockReference`
   ids and returns both "pages that reference this block" and "blocks this page references"
   (SiYuan-style bidirectional). Click a ref → open target page and scroll to the block by id.
5. **Deferred (not required):** SiYuan `inline-memo` (our comment mark already covers inline
   annotation) and block-level `protyle-attr` remarks.

**Sequencing / risks:** Phase 1 is the foundation and must land first (with backfill + a regression
test that a comment survives edits to earlier text). Phase 3 is the user-visible payoff for the
current comment bug. Phase 4 unlocks real wiki cross-linking. Risks: keeping IDs stable across
ProseMirror join/split transforms (verify with tests), collab session vs. backfill interaction
(both write the same JSON), and the `CommentableCodeBlock` override must also gain the id attribute.
Minimal-change guardrail: keep `range_from/range_to` columns and add `block_id` alongside rather
than replacing, so nothing breaks if a block lookup misses.

**Block-ID model — what shipped (Phases 1–3, 2026-08-02):**
- **`src/shared/blockIds.ts`** — pure, dependency-free JSON walkers used by BOTH server and client:
  `ensureBlockIds()` (assigns ids to every block missing one, preserves existing, immutable),
  `collectBlockIds()`, `blockRangeForId()` (ProseMirror position range for a block id, exact
  PM size math), `blockIdAtPosition()`, `isBlockType()`, `defaultGenerateId()` (12-char nanoid-style,
  matching the client extension so both sides produce the same id shape). 13 unit tests.
- **Client:** `UniqueID` from `@tiptap/extension-unique-id` added to `baseEditorExtensions()` with
  `types: "all"` (every block node type except doc/text) and `filterTransaction: !isChangeOrigin()`
  so remote collab edits never regenerate ids on someone else's content. Because it lives in
  `baseExtensions()`, the read-only ShareView gets the same id-bearing schema for free.
- **Server backfill (§ plan step 2):** `ensureBlockIds()` runs on every write path — `createPage`
  (new pages + template content), `savePageOCC` (restore/import/hand-crafted JSON that skipped a
  live editor), and the collab `onLoadDocument` seed. Existing ids are preserved byte-for-byte;
  only missing ones are added. No one-time migration script was needed — every write path
  self-heals, which also covers the collab-vs-backfill interaction the plan flagged.
- **Block-anchored comments (§ plan step 3):** `comment_threads.block_id` (nullable) added to the
  schema; the create-thread route accepts and stores it; the GET response returns it. The client
  captures the containing block id at creation (`doc.resolve(from).parent.attrs.id`) and, when
  re-applying marks on load, re-anchors to the block's CURRENT range via a doc walk, falling back
  to the stored `range_from/range_to` if the block id is missing or gone (pre-Phase-1 threads).
  Guardrail respected: `range_from/range_to` columns untouched, so old clients/threads keep working.
- **New deps:** `@tiptap/extension-unique-id` (v3, peer-clean). `nanoid` was already installed.
- **Verification:** full suite 107/107 green (was 89 baseline): +13 `blockIds` unit tests and +5
  integration tests covering default-content ids, save-time backfill, id stability across saves,
  blockId round-trip, and pre-Phase-1 (blockId-less) thread acceptance. `tsc --noEmit` clean
  (caught and fixed a real regression: the initial schema edit had accidentally dropped the
  `selection` column — restored). Dev DB schema pushed (`block_id` column live).
- **Follow-ups:** Phase 4 (block refs + backlinks, atomic `blockReference` node, backlink scan
  endpoint) = §8.2. The vendored `search-and-replace` and `drag-handle` extensions are staged in
  `src/client/features/editor/vendor/` (not yet wired into the editor; `@ts-nocheck` on the
  search-and-replace file since it's unmaintained third-party code).

---

### 7.10 Planning record — robust Settings framework + Git management section (NOT started)
User direction (2026-08-01): the wiki needs a proper Settings area to *setup, administer, and control*
the app — and because git is now a core subsystem, Settings must include a comprehensive **Git**
section that can push/pull/sync to a remote (internally hosted Git server or GitHub). Planning only —
no code changes yet.

#### 7.10a Current state (verified against code)
- **Settings storage is generic key/value only.** `system_settings` (admin-only, `is_secret` flag,
  AES-256-GCM at rest via `SETTINGS_ENCRYPTION_KEY`) and `user_settings` (per-user). No schema, no
  validation, no typed controls. The admin UI is a raw text-input editor over the key/value table
  (`AdminSettings.tsx` "System settings" section).
- **Only one real consumer today:** `mailer.service.ts` reads `smtp_host/port/user/pass/from` at
  first use. The settings table is currently **empty** (verified live).
- **Git service (`git.service.ts`) is local-only.** `initGitRepo()` creates `./data/repo`, autosave
  commits the page's **Markdown export** (`page:<id>: Update - …`), manual snapshots go to
  `_snapshots/<pageId>.md`, `getPageHistory()` filters `git log` by message, `getFileContentAtCommit()`
  does `git show`. **No remote, no push/pull/sync anywhere.** `git remote -v` is empty.
- **§5.6 honesty check:** history is *viewable but not actionable* — there is no restore-from-history
  UI (the restore endpoint exists at the API level, §7.4, but nothing in the UI reaches it).
- **Instance sync exists separately** (`sync.routes.ts`): push a space to another instance as
  Markdown via target URL + token — an HTTP-API sync, unrelated to git remotes.

#### 7.10b Design — the Settings framework (first, because everything hangs off it)
Replace the raw key/value editor with a **declarative settings registry**, mirroring the existing
`pluginEngine.ts` pattern (§7.5): first-party modules `registerSetting({...})` and the framework
drives both the UI (correct control per type) and the backend (validation + boot-time consumption).

`SettingDef` shape: `{ key, section, label, type: "text"|"number"|"boolean"|"select"|"secret"|"textarea",
 default, options?, help, isSecret?, validate? }`. Registry → admin Settings UI renders sections
(Groups/Security, Email, Appearance, Collaboration, Storage, Git, Sync, Maintenance) with typed
controls, and the server exposes a schema-validated `GET /api/settings` (defs + current values) and
`PUT /api/settings/:key` (validates against the def). Secrets keep the existing mask-in-list +
decrypt-only-internally behavior (§4.6).

**Sections (proposed):**
1. **General** — site name, public-mode, default theme, default editor width.
2. **Authentication** — OAuth client IDs/secrets (GitHub, Google — already consumed from env today;
   move to secrets stored in settings), registration policy, trusted origins.
3. **Email** — SMTP host/port/user/pass/from, TLS mode, "test email" button (wires existing
   `mailer.service.ts` + `resetMailer()` for live re-config).
4. **Collaboration** — real-time collab enable, per-instance settings.
5. **Storage** — read-only display of resolved `DB_PATH` / `FILES_ROOT` / `GIT_REPO_ROOT` (env
   overrides win), plus usage/space stats.
6. **Git** — the comprehensive section (§7.10c).
7. **Sync** — instance-to-instance targets (URL/token) as secret settings.
8. **Permissions/Security** — admin users, signup policy.
9. **Appearance/Theming** — feeds §7.8a (theme tokens, default theme).
10. **Maintenance** — backup DB now, view logs (`/api/admin/logs` exists), job queue status.

#### 7.10c Design — the Git section in Settings (the centerpiece)
Goal: full admin control over the content repo (`data/repo`), including push/pull/sync to a remote.

**Repo status dashboard** (top of the section): branch, HEAD hash + short message, working-tree
dirty count, ahead/behind vs remote, last commit date, total size. Backed by new `git.service.ts`
status helpers (`getRepoStatus()`, `getBranchList()`, `getRemotes()`).

**Remote configuration:**
- Add/edit/remove remotes (URL + auth). Auth stored as **secret settings**:
  `git_remote_url` (text), `git_remote_token` (secret, for HTTPS+token to GitHub/internal Git),
  optionally `git_ssh_key` (secret, for SSH). Plain URL shown in list; token/private key never
  serialized back (same masking rule as §4.6).
- **Test connection** button — runs `git ls-remote <url>` and reports reachability + auth success.

**Push / Pull / Sync controls:**
- **Push** — manual "Push now" (which branches), plus a **schedule** (settings: autosave cadence,
  snapshot cadence, DB-backup cadence). Branches per the storage model agreed in §7.9d/earlier:
  `main` (code), `content` (lossless JSON), `assets` (uploads/clips/plugins), `db` (periodic
  consistent SQLite `.backup` snapshots). Only the branches the admin selects are pushed.
- **Pull** — fetch + bring remote content into the *shadow* repo, then **import** into the DB as a
  restore/merge operation (NOT a live read path — DB stays the runtime truth; see hazards in the
  earlier storage discussion: WAL sidecars, git-blind-to-binary, live-checkout hazard).
- **Sync status** — per-branch last-push time, ahead/behind counts, error history (surfaces in the
  existing `system_logs`).

**History & restore (makes §5.6 usable):** per-page commit list with message/date/author, a diff
preview, and a **Restore** action that calls the existing restore endpoint (Markdown→Tiptap, §7.4)
or JSON restore once history is lossless. This closes the §5.6 gap.

**Safeguards:** every destructive action (restore, pull-import, branch delete) requires a confirm
with the current state; destructive git ops run through the worker queue (long-running) with
progress/error surfaced in the UI; a "never auto-push" default so nothing leaves the box without an
explicit admin action.

#### 7.10d Design — server-side git service extensions
- `setRemote(url)`, `push(branch, opts)`, `fetchAndImport(branch, opts)`, `getRepoStatus()`,
  `getBranches()`, `testRemote(url)` — all wrapped as **queue jobs** (`git_push`, `git_pull`,
  `git_backup`) so long operations never block an HTTP request and reuse the retry/backoff logic
  in `queue/worker.ts`.
- Settings are read at job-run time (not cached), so changing remote/auth never requires a restart
  (mirrors `resetMailer()`).
- History format migration: **JSON, not Markdown**, per the storage-model decision (block IDs,
  comment marks, refs must survive history — Markdown export is lossy). Markdown stays as a
  per-request export artifact.

#### 7.10e Design decisions / honest tradeoffs (flagged, agreed direction)
1. **The git repo is a shadow, never runtime truth** — SQLite + files directory stay the only thing
   the server reads. Git is write-mostly; pull is an import/restore, not a live switch. This keeps
   collab, OCC, and permissions untouched.
2. **Remote auth lives in secret settings** (token/SSH key encrypted at rest) — never in the git
   config file on disk, never in plaintext.
3. **Two repos, two concerns** — the app *source* repo (where this document lives) and the *content*
   repo (`data/repo`) are separate. The Settings Git section controls the **content** repo. If we
   ever want code deploy from Settings, that's a separate, later feature (out of scope here).
4. **Sync to GitHub vs internal Git are both just remotes** — one engine, configurable URL. GitHub
   API features (issues/PRs) are NOT part of this; we use plain git protocol for content.
5. **Pull conflicts** — import-merge policy for `content` branch collisions is last-write-wins with
   a pre-import backup commit (documented), since the wiki is single-author per space today; a true
   merge UI is explicitly deferred.

**Sequencing:** (1) Settings framework (registry + typed UI + validation) → (2) Git service remote
capabilities + queue jobs → (3) Git section UI (status, remote config, push/pull/sync, history
restore) → (4) JSON history migration + DB backup branch → (5) scheduled cadence controls. Each
step is independently shippable; nothing here breaks existing features.

---

### 7.11 Planning record — SSG-ready clean Markdown export (requirement clarified 2026-08-01)
User requirement: the wiki must be able to **export clean Markdown with all wiki-internal metadata
stripped**, for feeding a static site generator (SSG). This is a distinct artifact from the lossless
JSON history (per the storage-model decision — §7.9d): git history stores JSON so block IDs / comment
marks / refs survive; **export produces clean Markdown derived from the JSON at export time**.

#### 7.11a What the current converter already does right (verified)
`tiptapToMarkdown` (`markdown.service.ts`) is already deliberately clean: comment marks fall through
the mark switch (plain text emitted — no highlight spans); heading anchor IDs are explicitly not
emitted (brief §3.13); unknown node types degrade to inline text rather than raw HTML. The git
working tree (`data/repo/<space>/<slug>.md`) is effectively today's export folder.

**Phase 2 addition (verified live + unit tests):** task lists and highlight marks are now handled in
both directions.
- Export: `taskList`/`taskItem` nodes → `- [x]` / `- [ ]` markers; `highlight` marks → `==text==`.
- Import (`markdownToTiptap`): `- [x]`/`- [ ]` lines → `taskList`/`taskItem` nodes with `checked`
  attrs; `==text==` → highlight marks. Round-trip is byte-identical.
- The list collector no longer swallows an unindented paragraph that immediately follows a list item
  into that item (it only continues items on indented lines now), so a list followed by a normal
  paragraph imports correctly.
- **Parser-hang fix:** an unmatched special character (a lone `=`, `!`, `[`, `*`, or backtick that
  doesn't open a valid mark/image/link) used to make `parseInline` loop forever — any page whose
  restored/clipped markdown contained something like `key = value` would hang the request. The
  fallback now emits such characters as literal text and advances. Verified live by restoring a
  commit containing `key = value and a lone ! mark` — no hang, byte-identical re-export. (This
  pre-existing bug was amplified by the new `==highlight==` parser adding `=` to the special-char
  set, which is what surfaced it.)

#### 7.11b Gaps to close for real SSG readiness
1. **Images are not portable.** The editor stores image srcs as branch-scoped API URLs
   (`/api/branches/<branchId>/files/<fileId>`, `Editor.tsx` upload flow). An export must copy the
   referenced blobs from `data/files` and rewrite srcs to relative paths (e.g.
   `assets/<page>/<file>`), or offer a "strip images" mode.
2. **No frontmatter / title.** Pages have a `slug` but no `title` column; the title lives as the H1
   in the doc JSON. SSGs generally want `title` (+ optional `date`, `slug`) in frontmatter. Decide:
   auto frontmatter (from H1/`updatedAt`) vs. fully bare files.
3. **No export endpoint exists.** The only Markdown output today is the git working tree. Need an
   explicit export surface (per page / per space / whole instance → folder or zip), or a dedicated
   git branch the SSG can clone/pull.
4. **Future wiki-internal constructs need explicit stripping rules** (they don't exist yet, but the
   converter should be written to handle them): internal `[[page]]` links (→ plain text or relative
   link, decision needed), block refs (→ flatten to the referenced text), tags/labels/attributes
   (never exported), underline (→ plain text, already), embeds (→ plain text or omit).
5. **Code-block + comment interplay:** with `CommentableCodeBlock`, comment marks inside code blocks
   must also be stripped (they fall through today, but confirm once re-anchoring lands).

#### 7.11c Design direction (draft, to confirm)
- `tiptapToMarkdown` gains an explicit **export mode** (`exportMarkdown(doc, opts)`): guaranteed
  plain-text passthrough for every mark/node it doesn't render; a configurable
  `stripInternalLinks`/`flattenBlockRefs`/`includeFrontmatter`/`imageMode: "copy"|"strip"|"raw"`.
- Export path: `GET /api/spaces/:spaceId/export` → clean `.md` per page (tree-mirrored paths) +
  copied assets, delivered as a zip; and/or a git `export`/`ssg` branch regenerated on demand so an
  SSG pipeline can `git pull` a single branch.
- Images: read `data/files/<pageId>/<uuid>-<name>` via `file.service`, copy into the export tree,
  rewrite srcs. Relative structure follows the space/tree (SSG content folders mirror it).
- Title: derive from first H1 (or slug) for frontmatter when enabled; otherwise zero frontmatter.

Open questions for user: (1) which SSG (affects frontmatter + folder conventions); (2) images —
copy-as-relative, strip, or both as options; (3) internal wiki-links once they exist — strip to
plain text or emit as relative `.md` links; (4) per-page vs whole-space vs whole-instance export;
(5) bare files vs frontmatter.

---

### 7.12 Full reference scan (2026-08-01) + v2 redesign plan
Full-codebase scan of all three reference repos (~943K lines: Docmost 146K, SiYuan 342K,
Trilium 456K) plus our own (~9.2K). Findings and the resulting redesign plan below. **Planning
only — awaiting user approval before implementation.**

#### 7.12a What the scan covered, subsystem by subsystem
**Docmost** — every core module (auth, casl abilities, comment, favorite, group, label,
notification+processor, page+page-access+page-history, search, session, share+SEO, space, user,
watcher, workspace), the collaboration layer (authentication/persistence extensions, history
processor, collab-history via Redis contributor tracking), the full `editor-ext` package (~13.5K
lines: unique-id, mention, link, comment, tables+dnd, details, callout, columns, math, image/audio/
video/pdf/attachment, subpages, transclusion, search-and-replace, markdown clipboard, drag handle,
shared-storage, page-break, embed, drawio/excalidraw), export (page/space, Markdown+HTML, tree
mirroring, attachment URL rewriting, internal link rewriting), share links (JWT-signed attachment
URLs, includeSubPages), search (Postgres `tsvector`/`ts_rank`/`ts_headline`), favorites, per-page
permissions (`pageAccess` + restricted-ancestor logic), trash retention cleanup.
**SiYuan** — block ID model (`NodeIDByTime` = `YYYYMMDDHHMMSS-` + 7 random chars), refs/backlinks
(`refs` SQL table + `RefreshBacklink`), inline-memo + block-ref toolbar, FTS5 search
(`blocks_fts`, `content='blocks'` external-content tables, tokenizer chain), attribute-view
databases (AV: table/kanban/gallery layouts, filters/sorts/relations — a Notion-style feature),
file history (ticker + per-box history generation), plugin system + EventBus + kernel RPC,
bazaar marketplace, MCP server (kernel/mcp — tools for blocks, search, SQL, web fetch, notebook,
daily notes), LLM agent, appearance/theming (light/dark/OS mode, theme.js loading).
**Trilium** — attribute system (label vs relation, `attributes` table, promoted attributes UI,
attribute definitions, `getNotesWithLabel`), scripting engine (`eval` + ~90-method `api.*`,
`runOn*` attribute hooks via `handlers.ts`, module allowlist/blocklist + kill-switch),
note types (special notes: LLM chat, date notes, render/widget/code), link discovery on save
(`saveLinks` scans content → `internalLink` labels + image download), search expression language
(`#label=value`, `.property`, fulltext, ancestor/descendant), ETAPI (token CRUD for
notes/branches/attributes/attachments/revisions/backups), MCP server, LLM chat w/ tools+skills,
export (zip, share themes), note map (graph view), widgets (backlinks, promoted attributes, toc,
collections, bulk actions, quick search), CSS-variable theming (theme-light/dark/next).

#### 7.12b Feature matrix — what we adopt / defer / skip (the "superior app" set)
| Capability | Reference | Verdict | Why |
|---|---|---|---|
| Block IDs on every node | Docmost `unique-id`, SiYuan | **ADOPT** | Foundation for stable comments, refs, links. Docmost's `@tiptap/extension-unique-id` + server-side `addUniqueIdsToDoc` is exactly our phase-1 answer — no hand-rolling |
| Block-anchored comments | SiYuan (structural), Docmost (UX) | **ADOPT** | `comment_threads.block_id` + offset, range fallback |
| Attributes (labels/relations) | Trilium, SiYuan | **ADOPT** | `attributes` table — tags, sourceUrl, isTemplate, sorting, promoted-attributes UI, runOn hook wiring |
| Backlinks / block refs | SiYuan, Docmost, Trilium | **ADOPT** | `refs` table populated on save (Trilium `saveLinks` pattern); backlinks panel; block-reference chips |
| Full-text search | SiYuan FTS5, Docmost tsvector | **ADOPT (FTS5)** | SQLite FTS5 external-content table keyed by page id — light, no new infra; Cmd+K palette UI |
| Mentions → notifications → email | Docmost | **ADOPT (slim)** | mention node + notifications table + queue; email via existing mailer |
| Favorites | Docmost | **ADOPT (tiny)** | `favorites(user_id, page_id)`; star in sidebar/tree |
| SSG export | Docmost (best model) | **ADOPT** | per §7.11 — tree mirror, attachment rewrite, internal-link rewrite, clean Markdown |
| Git remote push/pull/sync + Settings | (our §7.10) | **ADOPT** | settings framework + git section |
| Instance sync | ours (MCP push) | **ADOPT (extend)** | per-page + idempotent + JSON payload (§7.12d) |
| Search-and-replace, drag handle, markdown paste | Docmost | **ADOPT (small)** | vendored MIT extensions (same author as our comment ext) |
| Task list, highlight, text-align, status, typography | Docmost/Tiptap | **ADOPT (small)** | cheap official Tiptap packages |
| Slash menu expansion | Docmost | **ADOPT** | group existing + new commands |
| Tables, columns, details, callout, math | Docmost | **DEFER** | real code+testing weight; revisit after v2 stable |
| Transclusion / subpages embed | Docmost | **DEFER** | complex; block refs cover most value |
| Page-level permissions | Docmost | **ADOPT (engine already exists)** | §4.2 `resolveAccess` step 4 is already a per-branch group-permission hard-stop boundary; `group_permissions` table + branch-context loading + algorithm tests all exist. Missing only: API surface, UI, per-user overrides, and restricted-ancestor integration for share/search (see §7.12g) |
| Attribute-view databases (Notion-style) | SiYuan | **DEFER** | very heavy; would blow the "small" budget |
| Scripting/eval plugins + sandbox | Trilium, SiYuan | **SKIP** | first-party hooks only; no third-party eval |
| LLM chat / AI agent | Trilium, SiYuan | **SKIP** | out of scope; MCP already our AI surface |
| Mobile clients, desktop shell | all three | **SKIP** | out of scope |
| Watchers, page verification, audit UI, EE | Docmost | **SKIP** | heavy or enterprise |

#### 7.12c v2 architecture (target: small, tight, maintainable)
Keep the proven core unchanged: Fastify + better-sqlite3 + drizzle + better-auth + Hocuspocus/Yjs;
the `pages`+`branches` tree model; the §4.2 permission algorithm; token engine; MCP server; worker
queue; git JSON history (per §7.9d). Rebuild/restructure the rest:

- **Single-package layout** (already one repo) with clean layering:
  `shared/` (types, permission algorithm) · `server/{db,services,routes,queue}` (thin routes, logic
  in services) · `client/{api,components,features,styles,lib}`.
- **UI primitives** — hand-rolled `components/ui` (Button, Dialog, Input, Menu, Tabs, Toast,
  CommandPalette, ConfirmDialog) built on the existing CSS-variable theme. **Kill the pervasive
  inline styles** — move to CSS classes (the single biggest "professional UI" gap today). Add a
  small icon set (lucide-react, tree-shakeable) to replace emoji buttons.
- **App shell** — 3-pane: left tree (with Favorites on top), main content, right contextual panel
  (page details: attributes + backlinks + info) toggled per page. Cmd+K command palette
  (search pages/blocks + actions).
- **No UI framework** — React 18 + hand-rolled CSS. Keeps bundle small and dependency count flat.
- **Data model additions**: `attributes(entity,type,name,value)`, `refs(source,target,kind)`,
  `favorites`, `notifications`, `comment_threads.block_id`, `page_fts` (FTS5), `text_content`
  derived on save.
- **New editor extension set** (`baseExtensions` grows deliberately): UniqueID, Mention (users +
  pages), TaskList/TaskItem, Highlight, TextAlign, Status, Link(internal flag), SearchAndReplace,
  MarkdownPaste, DragHandle, plus existing CommentableCodeBlock/Comment. Each behind the existing
  `pluginEngine`-style registration so the set stays composable and testable.
- **Plugin engine** stays first-party compile-time registration (§7.9a), plus the server-side
  `runOn*`-style hook bus (§7.10d) — no eval, no sandbox.

#### 7.12d Phased build plan (each phase ships + tests green)
1. **Foundation: block IDs + backfill.** Add UniqueID extension; server `addUniqueIdsToDoc`
   backfill on save/import; `comment_threads.block_id`; re-anchor comments by block w/ range
   fallback. *Tests:* ID stability across edits, comment survives earlier-text edit, backfill of
   existing pages, collab writes IDs.
2. **Attributes + search.** `attributes` table + routes + promoted-attributes panel; `page_fts`
   FTS5 + `GET /api/search` (space-scoped) + Cmd+K palette + editor search-and-replace. *Tests:*
   attribute CRUD + permission scope, FTS ranking, palette query.
3. **Links: internal `[[page]]`, block refs, backlinks.** Link internal flag; `blockReference`
   node + slash search; `refs` population on save (Trilium `saveLinks` pattern); backlinks panel
   in the right pane; click-to-navigate+scroll. *Tests:* refs round-trip, bidirectional queries,
   anchor scroll.
4. **Mentions + notifications + email.** Mention node (users), notifications table, queue →
   in-app list + email (existing mailer). *Tests:* mention extraction, permission-safe delivery,
   read/unread.
5. **Settings framework (§7.10b) + Page permissions (§7.12g) + Git (§7.10c) + Sync.** Declarative
   settings registry + typed UI; **per-page permissions**: branch group-permission routes + UI +
   restricted-ancestor integration for share/search + algorithm tests for the boundary paths;
   git remote push/pull/status UI; sync per-page + idempotent + lossless JSON. *Tests:* setting
   validation/secret masking, per-page permission grant/deny + inheritance + share-link leak
   guard, git remote job success/failure, sync idempotency.
6. **SSG export (§7.11)** modeled on Docmost: page/space export to clean Markdown, tree-mirrored
   paths, attachment copy+rewrite, internal-link rewrite, optional frontmatter. *Tests:* export
   cleanliness (no comment/attrs/IDs leak), image portability, link rewriting.
7. **UI/professional polish.** CSS-class conversion, 3-pane shell, Favorites, command palette
   polish, empty states, focus/hover states, dark/light/contrast audit. *Tests:* Playwright E2E
   pass over the whole flow.
8. **E2E suite (Playwright, chromium already installed).** Browser tests simulating the full wiki:
   auth, tree navigation, create/edit/save, comment + highlight, collab two-session editing,
   share link + public mode, search palette, settings (incl. git remote against a local bare
   repo), export download. Runs against the real dev server.

#### 7.12e New dependencies (kept minimal, all official/MIT)
`@tiptap/extension-unique-id`, `@tiptap/extension-mention`, `@tiptap/extension-task-list` +
`task-item`, `@tiptap/extension-highlight`, `@tiptap/extension-text-align`,
`@tiptap/extension-typography`, `@tiptap/extension-character-count`, `lucide-react`, `nanoid`,
`@sereneinserenade/tiptap-drag-handle` (MIT, same author as our comment extension). Everything
else is already installed.

#### 7.12g Page-level permissions — clarification (2026-08-01)
User confirmed: page-level permissions are required, not optional. Clarification of what "defer"
meant and what the build actually needs:

**Already in the engine (NOT deferred, verified):**
- `group_permissions(branch_id, group_id, role: viewer|editor)` table exists.
- `resolveAccess` (§4.2) step 4 is a **per-branch hard-stop boundary**: the nearest branch in the
  chain with explicit group permissions fully replaces everything above it — a match grants that
  role, a non-match denies. This is structurally the same restricted-boundary idea as Docmost's
  `page_access`/`page_permissions` (nearest restricted ancestor wins), and the algorithm test suite
  already covers it (the HR-only scenarios).

**What's actually missing (the real "defer" was only about these):**
1. **API surface** — no routes to set/read/remove per-branch group permissions (the table is
   written by nothing today; only read when loading branch contexts).
2. **UI** — no per-page "Permissions" control (page header or right pane): pick groups + role,
   see current overrides, remove them.
3. **Per-user overrides** — Docmost supports user_id OR group_id on a restriction; ours is
   group-only today. Decide: keep group-only (simpler, recommended for v2) or add user rows.
4. **Restricted-ancestor integration** — Docmost uses `hasRestrictedAncestor` to exclude
   restricted subtrees from share links and search results. Our share links + public mode + MCP
   search must consult the same boundary logic, or a shared link could leak a restricted child.
5. **Semantics decision** — ours = nearest boundary fully decides (deny-by-default inside a
   boundary). Docmost = every restricted ancestor must grant, edit from nearest. Ours is simpler
   and already tested; keep it, document it.

**Plan placement:** now a first-class phase (Phase 5 "Settings + Page permissions + Git + Sync"),
before the SSG export and UI polish. It reuses the existing algorithm — this is additive (routes +
UI + tests), not a redesign, and the security-critical core is unchanged.

#### 7.12f Guardrails (what "small and tight" means operationally)
- No new runtime infra (still SQLite+git+files on disk; no Redis/Postgres — Docmost's Redis
  contributor tracking and Postgres tsvector are not needed at our scale).
- Feature gates: the DEFER list stays out of v2; revisit only after the core is stable and
  tested.
- Every phase lands with its tests; the suite must stay green and fast (target: < ~60s full run).
- The MCP server stays the AI surface (ahead of all three references); the export is the SSG
  surface; git is the version/backup/sync surface; DB is the single runtime truth.

#### 7.12h Current phase — "Phase 1 v14" editor UX pass (status as of 2026-08-04)

User-approved scope for this phase (all editor-facing, Docmost/Siyuan reference):
- **Narrow view — COMPLETED.** The full-width/narrow toggle (§4.6) now constrains **only the editor
  canvas** (`.narrow` → max-width 780px, centered). The page header, toolbar, and right-pane stay
  full-width and static — verified by manual E2E measurements (canvas=780px, header=972px on a
  972px-wide viewport) plus the `manual-verify.mjs` narrow checks.
- **Task #13: Block drag-and-drop (paragraph reordering) — COMPLETED.**
  Docmost/Siyuan style: drag a paragraph (via the existing drag handle) and drop it between other
  blocks to reorder. Added `@tiptap/extension-dropcursor` (2px blue `#3b82f6`) to
  `editingExtensions.ts`; the vendored `drag-handle.ts` (§7.9/§8.2) already dispatches
  `NodeSelection` on `dragstart` + serializes the slice to `dataTransfer`, so the dropcursor
  provides the visual ghost line during drag. Verified by a vitest unit test
  ("includes the Dropcursor extension configured with blue color") + all editor loads pass.
- **Task #14: Wiki-wide search — COMPLETED.** The existing SQLite FTS5 engine (§7.12d.2) was kept
  (no external engine needed) and the query layer upgraded:
  - `buildFtsQuery()` (`search.service.ts`) turns free-form input into an FTS5 MATCH expression:
    quoted `"phrases"` require adjacency; each bare word becomes `(word OR word*)` — the unquoted
    alternative lets the porter stemmer handle suffix variants ("crampons"→"crampon") while the
    `*` prefix handles partial words ("net"→"networking", "code"→"codebase"). FTS5 special chars
    (`" * ^ ( ) :`) are stripped and boolean keywords (`and/or/not/near`) are quoted, so arbitrary
    input can never produce an invalid MATCH query.
  - `searchSpaces()` adds name search (`LIKE %q%`, escaped) returning `{ id, name, pageCount }`
    (live, non-system pages only), ordered exact-name-first then by name length.
  - `/api/search` now returns `{ results, spaces, count }` (`results` unchanged/backward-compatible;
    page results gain `spaceName` via a join).
  - `CommandPalette.tsx` (Cmd+K) shows a "Spaces" section above "Pages", each page shows its space
    (`/Space/page`), a result-count line is shown, and navigation was fixed to use React Router
    `useNavigate` (`/pages/:branchId`) instead of the broken `window.location.hash`; clicking a space
    navigates to its first page. Keyboard nav spans both sections.
  - **Search UI integration (rework after user report — COMPLETED).** The palette was mounted in
    `App.tsx` but the user reported no visible search box, so a second, always-visible entry point
    was added: `SearchBox.tsx` renders a search bar pinned at the top of the main panel (below the
    sidebar, above the editor) with a dropdown grouped into Spaces + Pages, same result rendering
    and navigation as the palette. Shared logic extracted into `useWikiSearch.ts`
    (`useWikiSearch` hook: debounced `/api/search` fetch with abort-on-new-query, merged item list;
    `useWikiSearchNavigation`: space→first-page and page→`/pages/:branchId`). `indexPage` now falls
    back to the page slug as the FTS title when a document has no H1, and both the create and save
    page routes index with the slug — so pages are findable by slug immediately (including empty
    pages). Re-indexed the dev DB's surviving pages with this logic.
  - Verified: 4 search integration tests (exact, prefix, multi-word AND, quoted-phrase adjacency,
    space matches + counts + spaceName, empty query), 7 `buildFtsQuery` unit tests, manual-verify
    search checks, 176 vitest total, 11 E2E, 26/26 manual checks.
  - **Dev-DB test-data cleanup — COMPLETED.** Removed 33 test spaces, 41 test pages, and 31 test
    users (the `VerifySpace`/`Dbg*`/`DragSpace`/`KeyFresh*`/`UploadProbe` spaces and their
    `verify-*`/`dbg-*`/`imgdbg-*`/`drag-*`/`probe2` users created by manual-verify and debug runs),
    deleted orphaned `page_fts`/`favorites` rows and stale attachment dirs in `data/files/`, and
    purged the test dirs from the `data/repo` mirror. Surviving data is 4 spaces (Home Lab, Test
    Space, TEST1, Main), 7 pages, 11 users. The idempotent `scripts/cleanup-test-data.ts` re-runs
    this whenever test data accumulates again.
- **Comment hover popup — COMPLETED** (see §7.6 fix).
- **Attachment icon `data-kind` — COMPLETED** (`attachmentExtension.tsx` renders
  `<span data-kind="pdf" …>`, giving browser tests a stable selector; verified by manual-verify).
- **Slash-command improvements (Docmost/Siyuan reference) and file attachments — the upload flow is
  DONE** (slash "Upload file" command routes to the same hidden input as the toolbar button via a
  `window` `wiki-upload-request` event; attachments render as a real block-level node with icon +
  hover full-name; images always land on their own line).

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
