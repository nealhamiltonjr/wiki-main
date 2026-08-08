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
- **Deps**: better-sqlite3 pinned to ^12.10 (v13 broke better-auth peer dep).
  `npm audit` shows 5 moderate esbuild advisories — dev-tooling only
  (drizzle-kit's CLI chain), not runtime-reachable.

## Slice status

1. Skeleton — done (commit e6155bf)
2. Server foundation — done (commit 2dc699a): Fastify skeleton, single DB
   module, better-auth (explicit rateLimit/trustedOrigins), security headers,
   access-declaration boot refusal, in-memory limiter helper. Gate test:
   signup → login → session via `.inject()`.
3. Next — schema + permission algorithm port (pages/branches/spaces/groups,
   `resolveAccess`, port the existing test suite unmodified).
