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
