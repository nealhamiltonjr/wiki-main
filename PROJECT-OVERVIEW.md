# PROJECT-OVERVIEW

USER_CONTEXT: Continue building wiki-app-v2 following WIKI-REDESIGN-BRIEF-V2.md vertical slices. Ship complete app, fix bugs in each phase.

## Task tracking

- **slice-10 (Git flush pipeline):** completed.
- **slice-11 (Collab via Hocuspocus):** completed — root-cause bug fixed, all gate tests green, full manual lifecycle verified.
- **slice-12 (Plugin engine):** completed — code + E2E gate green (10/10 e2e parallel, 176/176 unit/integration).
- **slice-13+ (First-party plugins, settings, theming, users/groups, regression):** not started.

## Slice-12 — plugin engine

### Gate status

- `npx vitest run` → 20 files, **176/176 passed** (was 174; +2 new plugin install integration tests).
- `npx playwright test` → **10/10 passed in parallel**, stable across consecutive runs.

### What was fixed to pass the gate

1. **Real bug: every plugin upload returned 500.** `installPluginFromZip` in
   `src/server/services/plugin.service.ts` called `rm(tmpDir, { force: true })` without
   `recursive: true` on the temp extraction directory → `EISDIR` before the rename.
   Removed the erroneous line. Missed by tests because the plugin integration suite
   never actually uploaded a zip (only 401/415/validation cases).
2. **Manifest content-model bug.** The fixture's `plugin.json` declared
   `contentModel.nodes: []` while registering a `helloWorld` node — the server's
   `validateContent` would have rejected the saved content on the reload-persistence
   step. Manifest now declares `"nodes": ["helloWorld"]`; zip regenerated.
3. **Missing integration coverage added** (`plugin.integration.test.ts`):
   - real multipart upload → 201 + files on disk + `nodeTypes` from manifest
   - duplicate install → 409
   - test user promoted to global admin directly in the DB (signup can never set
     `isAdmin`; plugin upload routes are admin-only).
4. **E2E spec hardening** (`e2e/plugins.spec.ts`):
   - upload test no longer depends on the transient "Installed! Reloading…" status
     (the reload races past it); waits for the fresh table row instead.
   - slash test types `/` at doc start (`Control+Home`) — clicking the editor center
     lands mid-text once earlier specs have typed into the page.
   - slash test uses the seeded **"notes"** page, NOT "welcome": `editor.spec` and
     `slice9.spec` edit welcome in parallel workers, and their collab round-trips
     re-render its editor mid-interaction (eating the slash-menu Enter).
5. **Better-auth rate limiter exhausted mid-suite (429 → login stuck).** The
   webServer disabled `/sign-in/*` and `/sign-up/*` only; the global bucket (20/60s)
   on `/get-session` etc. was burned by every page load across 10 tests. The
   playwright webServer now also sets `BETTER_AUTH_RATE_LIMIT_WINDOW=3600
   BETTER_AUTH_RATE_LIMIT_MAX=10000`.

### Slice-12 architecture (as built)

- Server: `src/server/services/plugin.service.ts` (upload/install/enable/disable/
  uninstall, path-traversal guard, DB persistence in a `plugins` table),
  `src/server/routes/plugin.routes.ts` (admin-gated `/api/plugins` CRUD +
  `/plugins/:id/.../client.js` bundle serving).
- Client: `src/plugins/registry.ts` + `src/plugins/loader.ts` (dynamic-import plugin
  bundles from `/plugins/<id>/client/index.js`), hooks (`useTiptapExtensions`,
  `useSlashCommands`, `useToolbarItems`, `useSettingsPanels`), `SlashMenu` (rewritten
  state machine: keyboard nav, Enter/Escape), admin UI under `/settings/plugins`.
- Wiring: `vite.config.ts` proxies `/plugins` → Fastify; `_authenticated.tsx` calls
  `loadPlugins()` and gates rendering on plugins loaded; `seed-e2e.ts` marks the e2e
  user `isAdmin=true` and the webServer wipes `data/plugins` before each run.
- Fixture: `test-fixtures/hello-world-plugin/` (dir + zip) — manifest with
  `contentModel.nodes:["helloWorld"]`, a Tiptap node registered via the PluginAPI,
  a slash command, a settings panel registration, and a server route module.

## slice-11 — what was actually wrong and what was verified

### Root-cause bug fixed (StrictMode double-mount)

`src/features/editor/useCollab.ts` created the `HocuspocusProvider` during render and
destroyed it in a `useEffect` cleanup. React StrictMode (dev) runs mount → cleanup →
mount, so the just-created provider was destroyed immediately and the second mount
reconnected endlessly (7 WS upgrades, "reconnecting…" in the status pill).

Fix: create the provider once into a `sessionRef` (kept across the StrictMode cycle),
and defer the destroy with a `mountedRef` guard + `setTimeout(0)`. Cleanup sets
`mountedRef.current = false`; the re-mount effect sets it back to `true` before the
timeout runs, so a simulated unmount is a no-op and only a genuine unmount destroys
the session. Manual test after fix: exactly 2 WS upgrades (two tabs), stable "synced"
status.

### Verified lifecycle (manual, two tabs + DB inspection)

- Seed: `loadOrCreateDoc` with no stored `collab_documents` row seeds the live Yjs doc
  from `pages.content` via `prosemirrorJSONToYDoc` (content lands in the **XmlFragment
  named `default`**, NOT a `Y.Text`). Verified: seeded "Quick brown fox…" renders in the
  collab editor after entering live edit.
- Sync: two tabs on the same branch sync live (typing appears instantly; awareness
  active).
- Persistence on stop: stopping live edit unmounts the collab editor → provider destroy
  → WS close → Hocuspocus `onStoreDocument` (debounced) → `storeDocument` writes the
  Yjs update to `collab_documents` and converts back to ProseMirror JSON into
  `pages.content` (plus FTS re-index + git flush enqueue). Verified by typing a marker,
  stopping, and reading the DB: `collab_documents` row exists and `pages.content`
  contains the marker.
- No-edit stop: no document updates → no store → content untouched (verified).
- `pages.content` after store includes block `attrs.id` (generated by `ensureBlockIds`).

### Debugging invariant (learned the hard way)

The collab doc's `default` fragment is an **`Y.XmlFragment`** (y-prosemirror layout).
Do NOT inspect it with `doc.getText("default")` — that either returns an empty `Y.Text`
(created on demand) or throws "Type with the name default has already been defined…".
Read it with `doc.getXmlFragment("default")`. Any future instrumentation on
`onLoadDocument`/`onStoreDocument` must use the XmlFragment API.

### Gate tests (all passing, 8/8)

`src/server/__tests__/collab.integration.test.ts`:
1. resolves a session principal and allows an editor on a single-placement page
2. rejects a multi-placement (cloned) page for live collab
3. rejects a viewer (editor access required)
4. rejects an unauthenticated connection
5. accepts an account-scoped passwordless token and rejects a password-protected one
6. seeds a fresh collab doc from persisted page content
7. writes collab content back to pages.content and enqueues a git commit
8. does not churn the page or enqueue jobs when the collab doc is unchanged

Command run: `npx vitest run src/server/__tests__/collab.integration.test.ts` → 1 file,
8 tests passed. `npm run typecheck` clean.

### Slice-11 architecture (as built)

- Server: `src/server/services/collab.service.ts` (untracked, new) exports a
  `Hocuspocus` instance sharing the single `getDb()` connection. `onAuthenticate`
  resolves the principal (session cookie or account-scoped share token) and enforces
  the single-placement rule via `checkCollabEligibility`; `onLoadDocument` seeds from
  `pages.content`; `onStoreDocument` writes back.
- Server wiring: `src/server/index.ts` mounts a `ws` WebSocketServer on the Fastify HTTP
  server at `/api/collaboration`, forwarding `message`/`close`/`error` to the
  `hocuspocus.handleConnection(...)` client connection (Hocuspocus v4 does not wire
  these up itself with a bare `ws` server).
- Client: `src/features/editor/useCollab.ts` (new) → `CollabEditor` in `Editor.tsx`
  using `@tiptap/extension-collaboration` + `@tiptap/extension-collaboration-caret`
  over `baseExtensions()`; `content={undefined}` so local content never fights the Yjs
  doc. Route `$branchId.tsx` toggles `collabOn`, disables autosave while live, and
  waits `COLLAB_FLUSH_WAIT_MS = 2600` after stop before refetching so the Hocuspocus
  write-back (debounce ≤ 10s) lands first.
- DB: `collab_documents` table (migration `drizzle/0002_small_valkyrie.sql`).
- Deps added: `@hocuspocus/server`, `@hocuspocus/provider`, `yjs`, `y-prosemirror`,
  `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`, `ws`.

## Current environment state

- No dev servers left running (stale servers were killed to keep Playwright's
  webServer from reusing a pre-seed instance — `reuseExistingServer` skips the wipe +
  reseed when a server is already up).
- E2E boots its own stack per run against `data/e2e.db`, reseeding the admin user and
  wiping `data/plugins` first. Seed user: `e2e@test.local` / `E2ePass-1234` (space
  "Demo Space", welcome tree, `isAdmin=true`).

## Next up (slices 13+)

13. **First-party plugins** — web clipper and Draw.io embed, built as plugins (§4.6).
14. **Settings consolidation** — full `/settings` IA (§7). The plugin engine already
    exposes `useSettingsPanels`; the `/settings/plugins` page does not render plugin
    panels yet — natural first task.
15. **Theming polish pass** — full token set, light/dark, §5.3 acceptance test.
16. **Users/groups/admin UX polish.**
17. **Full regression pass** — Vitest + Playwright + §9.4 manual checklist.

## Repo hygiene

- Branch `rebuild-v2`; slice-11/12 code is committed up to `c699e33`
  (feat: slice-12 plugin engine). The slice-12 gate-pass work below is **uncommitted**:
  `src/server/services/plugin.service.ts` (EISDIR fix),
  `src/server/__tests__/plugin.integration.test.ts` (+2 install tests),
  `test-fixtures/hello-world-plugin/` + `.zip` (manifest fix), `e2e/plugins.spec.ts`
  (gate spec + hardening), `playwright.config.ts` (rate-limit window),
  `scripts/seed-e2e.ts`, `vite.config.ts`, `src/features/editor/SlashMenu.tsx`,
  `src/routes/_authenticated.tsx`.
- `tsconfig.tsbuildinfo` and `data/` are untracked build/local artifacts (data/ is
  gitignored at workspace level).
