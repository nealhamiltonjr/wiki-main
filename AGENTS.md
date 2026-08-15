# AGENTS.md

Cross-session memory for the wiki-main monorepo. Read REBUILD.md before touching anything.

## Repo layout

- Monorepo root is this directory. Two app subdirs:
  - `wiki-app/` — the legacy V14 codebase (do not touch; out of scope).
  - `wiki-app-v2/` — the V2 rebuild. Everything in scope is here.
- Docs at the root: `REBUILD.md` (the single narrative doc, must be maintained), `WIKI-REDESIGN-BRIEF-V2.md` (the brief — read first if you have a "why is this like this?" question).
- Reference materials in `reference/`.

## Branch / push

- Branch: `rebuild-v2`. Push target: `github.com/nealhamiltonjr/wiki-main`, branch `rebuild-v2`.
- Never touch `main` or the snapshot branches.

## Live app

- The dev stack runs on `192.168.1.13:5173` from outside Docker (FE on Vite, API on :3000).
- Start it: `cd wiki-app-v2 && (npm run dev:server &) && (npm run dev &)` — both must be backgrounded in the same shell or the second one will hang on stdin.
- Vite uses `--host 0.0.0.0` so the LAN IP works. The Fastify server listens on 0.0.0.0:3000.
- API health: `curl http://localhost:3000/api/spaces` returns **401** (correct — auth required). FE: **200**.

## Test layers

- `npm run typecheck` — `tsc --noEmit`, strict.
- `npx vitest run` — **83 files / 629 tests** (after the tree leaf-click + slash-menu slice added `blocksSlashCommands.test.ts`). Configure fileParallelism=false for the integration suite (`data/` + SQLite singleton per worker).
- `npm run build` — typecheck + `vite build`.
- `npx playwright test` — 28 specs across 11 files. Local runs use a focused subset (`tree.spec.ts`, `firstparty.spec.ts`, `happy-path.spec.ts`, `tree-context-menu.spec.ts`, `editor.spec.ts`, `plugins.spec.ts`, `codepage.spec.ts`); the wider suite is exercised in CI. Login in e2e requires the seeded `data/e2e.db` — the locally-running dev server (which uses `data/wiki.db`) won't accept `e2e@test.local`, so e2e must spawn its own stack via `CI=1 npx playwright test ...` (this forces fresh servers + a fresh `data/e2e.db`).
- Integration tests must set `process.env.DB_PATH` **before any import of `getDb` or services** or the singleton locks onto the default path.

## Server route shape (for the next slice)

When you need to wire a UI to an existing server route:
1. Look at `src/server/routes/*.routes.ts` first — the handler shape is the contract.
2. Add the wrapper to `src/api/client.ts` to match (the four wrappers in commit `dd47843` are the cleanest recent examples: `clonePage`, `moveBranch`, `renamePage`, `removeBranch`).
3. **Cross-reference against this list** — these are the page/branch lifecycle routes that exist server-side:
   - `POST /api/branches/:id/clone` — `clonePage`
   - `PUT  /api/branches/:id/move` — `moveBranch`
   - `PUT  /api/pages/:pageId/branches/:branchId/slug` — `renamePage`
   - `DELETE /api/branches/:id` — `removeBranch`
   - `PUT  /api/branches/:id/restore` — restore from trash (still has no client wrapper; add when UI lands).
4. The access witness for delete-style operations is `?branchId=<id>` on the page-level endpoint (not the branch-level one). Don't reuse `deletePage` — it was removed in `dd47843` for exactly this reason; a wrapper pointing at the wrong endpoint invites misuse.

## Tree context menu (the slice just shipped)

`src/features/tree/Tree.tsx` is now the home of:
- `WikiTreeNode` — captures `onContextMenu({ branchId, pageId, slug, hasChildren, x, y })` on right-click.
- `ContextMenu` — portal-rendered `<div role="menu" aria-label="Page actions">`. Items: Rename, Duplicate, Move to..., Delete (disabled when `hasChildren`).
- `ActionDialog` — portal-rendered `<div role="dialog">`. Forms: text input (rename), parent picker (move), confirmation (delete). Escape and click-outside close both.
- After every successful commit the parent calls `getSpaceTree(spaceId)` to refresh.

If you're extending this surface, the e2e in `e2e/tree-context-menu.spec.ts` shows the test pattern: each test seeds its own throw-away page via `page.request.post` so destructive tests don't leak state into non-destructive ones.

## Tree leaf-click + first-party slash menu (the slice just shipped)

`src/features/tree/Tree.tsx` — `WikiTreeNode`'s `onClick` now does `node.select(); node.activate();` (previously it only called `node.toggle()` for internal nodes, leaving every leaf inert). The chevron's own click handler stops propagation, so internal expand/collapse still works; every other row click selects AND fires `onActivate` (which navigates).

`src/features/editor/extensions/blocksSlashCommands.ts` — new file registering the §13.6 first-party block commands: `heading-1`..`heading-4`, `bullet-list`, `numbered-list`, `quote`, `code`, `divider`. Each is a Tiptap chain (`editor.chain().focus().toggleHeading({ level: N })`, etc.). Registration is idempotent (a duplicate call is a no-op, so React's dev double-mount can't double-register). Wired into `src/plugins/coreCommands.ts` next to `registerMermaidSlashCommand`.

`src/features/editor/__tests__/blocksSlashCommands.test.ts` — three unit tests: expected names registered, every `run()` is callable, idempotency.

The registry + `<SlashMenu />` already supported dynamic commands, so no UI changes were needed. The slash menu now lists 10 items.

## Remaining gap items (in priority order)

After the leaf-click + slash-menu slice, the only remaining "Verified gaps" from REBUILD.md §7.12 are:

1. **Search UI depth** — the `/api/search` endpoint is wired through the client but the in-app search surface is shallow relative to what the brief expected.
2. **Playwright spec depth in general** — most files still have 1–2 tests (smoke level). The `tree-context-menu.spec.ts` file is the right shape to copy from (6 tests in one file).

The other items in REBUILD.md §9.6 ("Multi-placement collab", "Bundle-size polish", etc.) are not in any current prioritized slice.

## Commit convention

- Subject line: conventional commits (`feat`, `fix`, `chore`, `docs`).
- Body: the **why**, the brief section, the slice number if applicable. Don't restate the diff.
- Co-authored-by is added automatically by `openhands`.
- Author: `openhands <openhands@all-hands.dev>` (already configured in this repo's git).

## Don't-do list (carried from REBUILD.md §9.5)

1. Don't migrate V14 content ad-hoc — use §11.1 procedure.
2. Don't add a new abstraction layer "for the next slice" — no abstraction without a second consumer.
3. Don't make plugin capabilities implicit — schema + type + key array + gated API method, all together.
4. Don't end-run the access middleware — every route declares `config.access`; Fastify refuses to boot otherwise.
