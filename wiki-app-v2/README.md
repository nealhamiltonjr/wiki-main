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
npm run dev        # Vite dev server on :5173
npm run build      # typecheck + production build
npm run typecheck  # tsc --noEmit
npm run e2e        # Playwright
```

## Status

- Slice 1 (skeleton): done. Vite + React 19 + TanStack Router shell, token
  architecture, shadcn base, authenticated/public layout split, health route.
  Gate: `npm run e2e` passes with zero console errors.
