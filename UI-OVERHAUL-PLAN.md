# UI Overhaul — Revised Game Plan

**Status:** Draft for review — supersedes `UI_upgrade.md`
**Date:** 2026-08-04

## Track B status (2026-08-05) — COMPLETED, commit `39694e0` on `snapshot.3`

Track B (frontend overhaul: Tailwind + shadcn + interactive tree) is done and verified. It also
completed Track C (theming) and the tree parts of Track D (B6/B7 dialog flows); the remaining Track D
items (tree context-menu rename/move/share, the Cmd+K palette and toolbar restyle that were always
separate tasks) stay as documented below.

- **B1** Tailwind v4 (`@tailwindcss/vite`, no preflight) + `cn()` + `@/` aliases; React.lazy code-split
  routes (Editor, Settings, PublicView chunks) in `App.tsx`.
- **B2** lucide-react icons replace emoji buttons across the chrome; Sonner `<Toaster/>` mounted.
- **B3** 11 shadcn/ui primitives (button, input, label, select, dialog, popover, dropdown-menu,
  context-menu, command, tooltip, sonner) built on the project CSS tokens. The per-page icon lives in
  a reserved `icon` attribute (survives clones, versioned like other attributes); `buildSpaceTree`
  attaches it to `SpaceTreeNode.icon`, the tree renders it, and a picker grid in `AttributesPanel`
  sets/clears it with live refresh (Editor heading + tree listen for `wiki-page-icon-changed`).
- **B4** (Track C) `ThemeContext` with system/light/dark + 8 accent colors, persisted to
  `user_settings`, applied via data-theme vars.
- **B5** `PageTitleInput.tsx` above the editor (independent debounced save path, Enter/blur commit,
  never touches the slug, browser-tab title sync). `save` reads latest page/title from refs so a late
  body autosave can't revert a freshly renamed title.
- **B6** `Tree.tsx` rebuilt on `react-arborist` (drag-move, expand/collapse, dual-trigger context menu
  for keyboard/touch, create/clone dialogs); Favorites preserved.
- **B7** `PageCreateDialog.tsx`: title-first creation, auto-slug, per-space dedupe, live validation,
  space/parent selection; `api.createPage` sends the title.
- **B8** E2E + `manual-verify.mjs` moved to the dialog flow; new tests for title persistence and the
  icon picker → tree rendering.
- **Tests** 199 unit/integration (unchanged count), 13 E2E (was 11: +1 title, +1 icon), typecheck
  clean, client build green.

## Track A status (2026-08-05) — COMPLETED, commit `81a3db8` on `snapshot.3`

All of Track A (real title column) is done, verified, and pushed:

- **A1** `pages.title` column (notNull, default `Untitled`); `createPage({title?})` defaults to slug;
  create Zod schema + GET page response carry `title`.
- **A3** `savePageOCC({title?, titleProvided?})` applies title outside the body OCC window; title-aware
  clients echoing unchanged content skip the OCC gate (title-only saves don't bump `updatedAt` and
  never 409 against a concurrent body save). Save route resolves `title = body.title || extractTitle(content)`.
- **A4** `commitPageChange` + `commitManualSnapshot` prepend YAML frontmatter (`title`/`slug`/`date`,
  then a newline before the body); `stripFrontmatter` added and used in the restore handler and
  `importMarkdownPage` so frontmatter never leaks into editor content.
- **A5** workaround sites switched from H1 extraction to the real column: favorites list, single + zip
  export filenames, MCP `create_page` (no forced H1, passes title) and `search_pages` (returns title),
  space sync (selects + sends the real title).
- **Tests** 199 total (was 187): +7 `title.integration` (incl. OCC independence + stale-timestamp
  title save), +2 `sync.integration` (real two-instance test with a child-process target), +3 markdown
  frontmatter round-trip. Typecheck clean, full vitest green.
- **Client** `PageContent` type includes `title`; the editor title input itself is Track B (B5).

Remaining: Track D (tree context-menu rename/move/share, palette restyle), toolbar polish — see below.

**Goal:** A clean, modern UI matching Docmost/Trilium's polish — better icons, stronger theming, and
a genuinely interactive tree (right-click context menus for new page / clone / delete / rename / move
/ share), without losing anything the backend already does well.

This revises the plan you were handed, keeping what's sound and changing four things: H1 stays
available in the editor body (only the *auto-first-H1-is-the-title* behavior goes away), bundle
code-splitting moves into the rebuild itself instead of being deferred again, the MCP/sync/collab test
gaps get closed in the same steps that touch that code rather than left for later, and every
context-menu interaction gets a non-right-click trigger too, since right-click alone excludes touch
and keyboard users.

---

## 1. My opinion on the tech stack

**Keep, no argument:** React 18, Vite, Tiptap v3, Fastify, better-auth, Drizzle, better-sqlite3,
Hocuspocus/Yjs, Vitest/Playwright. None of this is UI's fault, and none of it needs to change to get a
Docmost-level frontend. Docmost is the same stack (React + Tiptap) — the gap is component polish, not
architecture.

**Tailwind CSS v4 — good call, one thing to verify before committing.** v4's `@theme` directive is
built to consume existing CSS custom properties, so your light/dark/contrast tokens in `theme.css`
should port cleanly in principle. But v4 is a genuinely different config model from v3 (CSS-first
config instead of `tailwind.config.js`), not just a version bump. I'd treat "does contrast mode still
work" as something to actually check in step 1, not assume from the marketing.

**shadcn/ui — good call.** It's copy-in, not an npm dependency you're stuck with — components land in
your own `src/client/components/ui/` and you own the code, which matches how the rest of this project
is built (nothing here is a black box). Built on Radix, so accessibility (keyboard nav, focus
trapping, ARIA) comes for free instead of being hand-rolled. It's also literally what Docmost uses, so
"make it feel like Docmost" and "adopt shadcn" are the same move.

**react-arborist for the tree — good call, with a caveat.** It's the right foundation for
drag-and-drop, keyboard nav, and virtualization on a large tree. The caveat: your tree isn't a plain
filesystem tree — a page can appear in more than one place (clone), and permission boundaries live on
branches, not pages. react-arborist doesn't know about either of those; the wrapper component you
build around it (which node renders a clone badge, which nodes are draggable given the mover's actual
permission, not just tree structure) is where the real work is. Budget for that wrapper, not just the
library integration.

**Icons — lucide-react is already in your deps and is what shadcn expects. Keep it for UI chrome; don't
add a second icon library.** For *page* icons (the Notion/Docmost "emoji next to the title" feature),
I'd avoid a full emoji-picker library (`emoji-mart` and friends are 100–300KB+ and you're already
flagged for a 959KB bundle) — the native browser input has an OS-level emoji picker on every modern
platform (Windows `Win+.`, Mac `Ctrl+Cmd+Space`), so a plain text input constrained to one grapheme,
with a lucide-react fallback icon set for people who don't know that shortcut, gets you 90% of the
visual effect for near-zero bundle cost. Worth deciding deliberately rather than defaulting to the
heaviest option because Notion has one.

**sonner for toasts — fine, it's small and it's what shadcn recommends.** No objection.

**Framework switch (Svelte, etc.) — still a no,** for the same reason as before: Tiptap's React
bindings are load-bearing, and the actual gap between your app and Docmost is component library and
polish, not framework choice.

---

## 2. What "clean, modern, interactive" actually means here — concrete requirements

Translating your goals into things that get built, so the plan below has clear acceptance criteria:

- **Modern UI**: Tailwind + shadcn primitives throughout — dialogs, dropdowns, popovers, tooltips,
  context menus, tabs all use the same primitive family instead of one-off hand-styled elements.
- **Better icons**: lucide-react for all UI chrome (buttons, menu items, empty states, nav); a
  lightweight per-page icon (emoji, stored as an attribute — the `attributes` system already supports
  this, no schema change needed).
- **Better theming**: keep light/dark/contrast (don't regress this), add system-preference
  auto-detection (`prefers-color-scheme`) as a fourth "Auto" option, and — since you already have
  isolated per-user settings — a small set of accent-color choices stored in `user_settings`, not a
  full theme-builder.
- **Interactive tree**: right-click *and* a hover-revealed "⋯" button open the same context menu
  (New page, Rename, Move, Clone, Delete, Share, Copy link) — the second trigger matters because
  right-click has no equivalent on touch devices and no keyboard-accessible fallback. Drag-and-drop
  reordering, keyboard arrow navigation, active-page highlighting, and a clone badge round out the
  tree itself.

---

## 3. Revised implementation sequence

Same two tracks, reordered and adjusted per the changes above. Each step still gates on
`npm test && npm run typecheck && npm run build:client` before moving to the next, and each step is
still its own commit.

### Track A — Backend: real `title` column (~1 day, unchanged scope)

**A1. Add `title` column to `pages`**
`title: text("title").notNull().default("Untitled")`, Drizzle migration, `createPage()` accepts
`title`, Zod schemas updated on create/save.

**A2. Migration script for existing pages**
`scripts/migrate-titles.ts` — idempotent, extracts each page's first H1 into the new `title` column.
**Change from the original plan: the H1 stays in the content JSON.** The original plan stripped it
out entirely, which would mean nobody can ever use an H1 inside a page body again (no big section
break, no pasted content with a top-level heading). Only the *behavior* of "the first H1 silently is
the title" goes away — the H1 extension stays registered in Tiptap, and after migration a page can
have zero, one, or several H1s in its body with no special meaning attached to the first one.

**A3. Split title/content on save**
`savePageOCC` takes `title` and `content` as independent parameters — title edits and body edits no
longer share an OCC conflict window. **Add the title-during-collab test here, in this step, not as a
future task**: two Yjs clients editing the body simultaneously while a third changes the title should
never conflict, since title isn't in the Yjs doc at all. This closes part of the "no collab tests"
gap from the last audit as a byproduct of work you're doing anyway, instead of a separate future
effort.

**A4. Git commit format — YAML frontmatter**
```markdown
---
title: "Page Title"
slug: "page-slug"
---

Body content starts here...
```
Title changes become visible in git history, which they aren't today.

**A5. Remove the five title workarounds, add sync test coverage here**
`favorite.routes.ts`, `search.service.ts`, `export.service.ts`, `mcp.routes.ts`'s `create_page`,
`sync.routes.ts` all switch from `extractTitle()`/slug-mangling to reading `pages.title` directly.
**Since this step already touches `sync.routes.ts`'s title handling, add the sync integration test
that was the other flagged gap in this same step** — a real push between two in-process app instances
asserting the target page's title matches the source, not a placeholder. Same logic as A3: don't defer
test debt to "someday," close it when you're already in the file for an unrelated reason.

### Track B — Frontend: Tailwind + shadcn + interactive tree

**B1. Tailwind v4 + shadcn/ui setup, verified against your actual theme (not assumed)**
Add Tailwind v4 with the Vite plugin, wire it to consume `theme.css`'s existing CSS variables via
`@theme`, initialize shadcn (`cn()` utility, path aliases), install `react-arborist` and `sonner`. No
user-facing change yet — but **explicitly test all three existing theme modes (light/dark/contrast)
render correctly through Tailwind before moving on**, since that's the part of the original plan that
was asserted rather than verified.

**B2. Bundle code-splitting — moved here from "later," done alongside the rebuild**
Add `React.lazy()` boundaries around the editor, settings, and admin panels while you're already
touching those route components for the Tailwind migration. Doing this now costs almost nothing since
you're editing these files anyway; doing it as a separate future pass means opening the same files
twice. Verify the 959KB single chunk actually splits with `npm run build:client`.

**B3. Icon system**
lucide-react wired through shadcn's icon conventions for all chrome. Page-icon picker: a constrained
text input (native OS emoji picker) with a small lucide fallback set, stored as a page `attribute` —
no backend change needed, the attributes system already exists.

**B4. Theming: system-preference auto-detect + accent color**
Add "Auto" as a fourth theme option (`prefers-color-scheme` media query, re-evaluated live), and a
small fixed palette of accent colors selectable per-user, stored in `user_settings`. Keep this
scoped — a few CSS variable swaps, not a theme editor.

**B5. Editor: separate title input, H1 preserved in body**
`PageTitleInput` above the editor — large, bound to its own state, saved via the now-split
`savePageOCC({ title, content })`. The Tiptap H1 extension stays registered; body content can start
with anything, including an H1, with no special first-block meaning.

**B6. Tree rebuild — react-arborist + dual-trigger context menu**
Replace `Tree.tsx`. Drag-and-drop reordering (calls the existing `/api/branches/:branchId/move`, no
API change), keyboard arrow navigation, active-page highlighting, clone badge. **Context menu opens
from both right-click and a hover-revealed "⋯" button** — New page, Rename, Move, Clone, Delete,
Share, Copy link, all via shadcn's `ContextMenu`/`DropdownMenu` sharing one action handler so the two
triggers can't drift out of sync with each other.

**B7. Page creation flow**
Title-first dialog (required), slug auto-generated from title (kebab-case, deduplicated per space),
editable if the user wants to override it. Matches Docmost.

**B8. Breadcrumbs + page header**
shadcn `Breadcrumb`: Space → Parent → … → Current, each segment clickable. Page header combines the
title input (B5), page icon (B3), breadcrumb trail, and a last-edited timestamp.

**B9. Empty states**
"Create your first page" CTA for an empty space, "No results for '{query}'" for search, "You're all
caught up" for notifications — lucide icon + short text + action button, consistent pattern across all
three rather than three one-off designs.

**B10. Editor chrome polish**
Bubble menu, slash-command popup (grouped: Headings / Lists / Media / etc., keyboard-navigable),
toolbar (icon-only on narrow widths, tooltips, grouped actions), drag handle — all restyled with
shadcn patterns and hover states.

**B11. Tabs — separated out as its own milestone, not folded into the estimate above**
Multi-page-open tab bar, click to switch, middle-click/X to close, drag to reorder, state persisted in
`user_settings`. This is genuinely new interaction state (unsaved-changes-on-close, order surviving
reload), not a styling pass — it gets its own design pass and its own test coverage, not a slot in the
same week as breadcrumbs.

---

## 4. What this plan does not cover (unchanged from the original, still correctly deferred)

- Vite 5 → 8 upgrade (separate, still deferred)
- MCP tool surface expansion (`update_page`, `delete_page`, attribute tools) — separate concern
- Public-instance deployment mechanics
- OAuth SSO live credentials — operational, not code
- Unifying the MCP server's separate `search_pages` implementation with the FTS-based search — noted
  in the last audit as a good pairing with MCP tool expansion, still out of scope here

---

## 5. Testing approach

- All current tests (184 as of the last verified run — not 208; see note below) stay green throughout.
- New tests land **in the step that creates the need for them**, per A3 and A5 above, rather than as a
  deferred backlog — this is the main structural change from the original plan.
- UI steps (B5–B11) get Playwright coverage as the DOM changes; the current 11 E2E tests will need
  updating, which is expected, not a regression.
- Migration script (A2) tested against a copy of real data before running for real.

**One correction to flag**: the plan you were handed cites "208 currently passing tests" and an
"audit" that had already closed the MCP/sync/collab test gaps. Neither is accurate as of the actual
last verified run — 184 tests, and those three gaps were still open going into this plan. Steps A3 and
A5 close two of them (collab-title and sync) as a side effect of work this plan already does; MCP
testing and the deeper two-session Yjs convergence test remain genuinely out of scope here, same as
the original plan said, just for a true starting number.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tailwind v4's CSS-variable model doesn't fully preserve contrast mode | Verify all three themes explicitly in B1, before any component migration — don't assume from v4's docs |
| react-arborist doesn't cleanly express clone/permission state | Budget the wrapper component as real work in B6, not a thin adapter; fall back to `@dnd-kit` directly if needed (same underlying primitives) |
| Migration script (A2) corrupts existing content | Run against a backup first, idempotent, logs every change, H1 preserved in body means the migration is additive (adds a title column) rather than destructive (no longer deletes content) |
| Editor title-input change breaks collab | Title is removed from the Yjs document entirely — a reduction in collab surface area, tested directly in A3 |
| Context menu drifts between right-click and "⋯" trigger | Both triggers share one action handler/menu definition in B6, not two separate implementations |
| Bundle grows from shadcn + react-arborist + sonner | Tailwind v4 tree-shakes aggressively, shadcn components are copy-in not bundled; B2's code-splitting happens in the same track, not after, so the net effect gets measured immediately rather than assumed |
| Tabs (B11) scope creep into the rest of Track B's timeline | Explicitly separated as its own milestone with its own estimate, not counted in the B1–B10 estimate |

---

## 7. Estimated scope

- **Track A (A1–A5):** ~1 day, unchanged from the original estimate — still small and self-contained.
- **Track B, B1–B10 (setup through editor chrome):** ~3–4 days.
- **B11 (tabs), separated:** ~1–2 days on its own, after B1–B10 land and are stable.

Total: still roughly a week for Track A + B1–B10, with tabs as a distinct follow-on rather than baked
into the same estimate — which was the part of the original schedule most likely to slip.

---

**Document end.** Ready to start on A1 (title column) whenever you want to kick this off — that's
still the right entry point, since it's small, self-contained, and B5–B8 depend on it existing.
