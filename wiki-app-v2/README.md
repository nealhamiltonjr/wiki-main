# Knowledge Base (wiki-app-v2)

Redesigned knowledge-base app built per `../WIKI-REDESIGN-BRIEF-V2.md`. The old
app in `../wiki-app/` is the reference implementation — this directory is the
rebuild, slice by slice.

## Stack (brief §3)

- React 19 + TypeScript (strict)
- TanStack Router (standalone/library mode, file-based routing via the Vite plugin)
- Vite 8
- Tailwind v4 + shadcn/ui — **one token file** (`src/styles/tokens.css`) controls
  every color/radius/font/spacing value; see the header comment there.
- Fastify + Drizzle + SQLite + better-auth (slices 2+)

## Commands

```sh
npm install
npm run dev          # Vite dev server on :5173
npm run dev:server   # API server (tsx watch) on :3000
npm run build        # typecheck + production build
npm run typecheck    # tsc --noEmit
npm run test         # vitest (server unit + integration)
npm run e2e          # Playwright
npm run db:generate  # drizzle-kit generate (new migration from schema)
npm start            # production server (NODE_ENV=production)
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | API server listen address (Docker host-network aware) |
| `DB_PATH` | `data/wiki.db` | SQLite file (relative to repo root) |
| `BETTER_AUTH_SECRET` | dev placeholder | Must be set in production |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Explicit base URL (not header-derived) |
| `BETTER_EXTRA_TRUSTED_ORIGINS` | — | Comma-separated extra trusted origins |
| `BETTER_AUTH_RATE_LIMIT_WINDOW` / `MAX` | `60` / `20` | Auth rate limit (explicitly enabled, §3.2) |

## Status

- Slice 1 (skeleton): done. Vite + React 19 + TanStack Router shell, token
  architecture, shadcn base, authenticated/public layout split, health route.
  Gate: `npm run e2e` passes with zero console errors.
- Slice 2 (server foundation): done. Fastify skeleton, single Drizzle/SQLite
  connection module (`src/server/db/index.ts`), better-auth wired with explicit
  `rateLimit` + `trustedOrigins` (incl. `192.168.*:*`), security headers from
  §3.2 registered globally from day one (CSP, nosniff, frame-options,
  referrer-policy), and the every-route-declares-`config.access` boot refusal.
  Committed migrations in `drizzle/`, applied automatically at boot.
  Gate: `npm run test` — integration test boots the real app via `.inject()`,
  signs up, logs in, and retrieves the session (9 tests pass).
- Slice 3 (schema + permission algorithm): done. Ported `resolveAccess` and the
  full pages/branches/spaces/groups schema verbatim from the old app
  (`src/shared/permissions/algorithm.ts`, `src/shared/types.ts`,
  `src/server/db/schema.ts`) plus the schema's 22 wiki tables as committed
  migration `drizzle/0001_long_prima.sql`. Shared types now under
  `src/shared/` — the single source of truth between DB, API, and frontend.
  The `RouteAccess` union in `middleware/access.ts` now types its
  `minRole` from `AccessResult`/`SpaceRole`. Full preHandler enforcement lands
  in slice 4 with the tree services.
  Gate: the ported permission test suite passes unchanged (11 tests,
  assertions identical to the old app's `algorithm.test.ts`); 20 tests total,
  typecheck clean, e2e gate green.
- Slice 4 (client integration): done. Auth client (`src/api/authClient.ts`,
  better-auth React) + typed API client (`src/api/client.ts`), Login component
  with sign-in/sign-up, react-arborist tree sidebar wired to the real
  `/api/spaces/:id/tree` endpoint, and a session-gated authenticated layout
  (`src/routes/_authenticated.tsx`, public `/login`). Server side:
  `auth.service.ts`, `group.service.ts`, `branch.service.ts`, `token.service.ts`
  under `src/server/services/`, permission middleware (`middleware/access.ts`)
  enforced with a declarative route config, and `space.routes.ts` /
  `tree.routes.ts` registered in `app.ts`.
  E2E: `scripts/seed-e2e.ts` seeds a real better-auth credential user + demo
  space tree; Playwright boots BOTH servers (Vite :5173 + API :3000) and
  verifies login → space → tree render (`npm run e2e`, 8 specs / 19 browser cases). Integration
  tests cover 401 unauthenticated, space create/list, tree pruning of deleted
  pages, and 403 for non-members (24 tests total).

## Slice index

| Slice | Topic | Commit |
|---|---|---|
| 1 | Skeleton + tokens + layout split | — |
| 2 | Fastify + Drizzle + better-auth + security headers | — |
| 3 | Schema + permission algorithm | — |
| 4 | Client integration (auth, tree, layout) | — |
| 5 | Markdown editor + block ids (§7.12d-1) | — |
| 6 | Mentions + slash menu + tree mutation | — |
| 7 | Page history + restore from git | — |
| 8 | Comment system (§7.6) | — |
| 9 | Search + FTS5 + snippets | — |
| 10 | Comment threads (round 1) | — |
| 12 | Plugin engine + extract-on-install | — |
| 13 | First-party plugins (web-clipper, drawio) | — |
| 14 | Settings surface (§7.1) | — |
| 16 | Push lifecycle + reload on conflict | — |
| 17 | Share links + password rate-limit | — |
| 18 | First-user admin bootstrap | — |
| 19 | In-page TOC + tree-collapse invariants | — |
| 20 | Per-space trash + purge | — |
| 22 | ReDoS defense for lens `titleRegex` (in AGENTS as slice-42) | — |
| 23 | Admin-demote lockout race (in AGENTS as slice-43) | — |
| 24 | Admin-tunable caps (in AGENTS as slice-44) | — |
| 25 | Markdown XSS hardening (in AGENTS as slice-45) | — |
| 26 | Plugin command-engine injection audit (in AGENTS as slice-46) | — |
| 27 | First-boot landing + recovery (in AGENTS as slice-47) | — |
| 28 | Comment threads tx-integrity + per-page cap (in AGENTS as slice-48) | — |
| 29 | Live collaboration blocked on encrypted pages (§13.7) | `508f749` (in AGENTS as slice-49) |
| 30 | Plugin install race + lost-on-rollback hardening | `6ab7713` (in AGENTS as slice-50) |
| 31 | Comment per-thread reply cap + tx-wrapped count | `621d5cb` (in AGENTS as slice-51) |
| 32 | Tighten plugins e2e Settings selector (exact-match) | `754d24d` (in AGENTS as slice-52) |
| 33 | `purgePage` removes orphaned on-disk files | `847e5f1` (in AGENTS as slice-53) |
| 34 | Page slug uniqueness within a space (create + rename) | `ca4369c` (in AGENTS as slice-54) |
| 35 | Cross-space mention-spam filter (processMentions recipient guard) | `4352b1a` (in AGENTS as slice-55) |
| 36 | Share-link passwords hashed with scrypt (was SHA-256) | `d0f6286` (in AGENTS as slice-56) |
| 37 | Mass-assignment hardening — zod `.strict()` on every write schema | `7532716` (in AGENTS as slice-57) |
| 38 | Web-clipper SSRF redirect bypass hardening | `2fba132` (in AGENTS as slice-58) |
| 39 | Cookie/CSRF posture verified (better-auth defaults) | `579a51c` (in AGENTS as slice-59) |

The per-slice sections in `AGENTS.md` are the authoritative narrative for
each change. Build a slice index on top of the latest `git log --oneline`:
`git --no-pager log --oneline | head` is enough for a quick scan.

## Headline invariants (one-line summary)

- Single SQLite connection (`src/server/db/index.ts`) — never open a second.
- Security headers (`src/server/security.ts`) are global from day one.
- Plugin zip install extracts to a `tmp-<uuid>`, then renames into place;
  the destDir is stashed as a fallback so a cross-device rename + cp
  failure can't silently delete the prior install.
- §13.7 per-page encryption: passphrase never reaches the server, content
  is stored as a CryptoEnvelope, and live collaboration is blocked on
  encrypted pages (the collab write-back would clobber the envelope).
- §13.6 code pages: raw source in `pages.content` as a JSON-stringified
  text, routed to git as `<slug>.<ext>` so a code page is a real file on
  disk + git history.
- Admin-tunable caps in `system_settings`: `fileUploadMaxBytes`
  (default 25 MB), `pluginUploadMaxBytes` (default 50 MB),
  `commentBodyMaxBytes` (default 32 KB), `commentThreadsPerPageMax`
  (default 1000), `commentRepliesPerThreadMax` (default 1000). Clamp
  ranges documented inline at the read sites.
- First-boot admin: the first user to sign up is auto-promoted to admin
  by `src/server/auth/config.ts`'s `databaseHooks.user.create`; the same
  hook also seeds the §11.6 Welcome space.

