#!/bin/bash
# scripts/fresh-start.sh — wipe the per-instance runtime state and re-boot from
# a clean DB. Use this whenever you want to start over (e.g. demo reset,
# re-derive the first-user-admin, or run a clean reproducible session).
#
# What this wipes (everything is .gitignored except `test-fixtures/`):
#   data/wiki.db  + wiki.db-shm + wiki.db-wal
#       - SQLite DB. Holds users, sessions, spaces, pages, comments,
#         notifications, the schema and __drizzle_migrations table.
#       - The seedWelcomeSpace flow runs on first sign-up after wipe.
#   data/repo/   (simple-git content repo for the git flush pipeline)
#       - Per-space markdown exports and their .git history. Removing it
#         loses all page history (the in-DB content survives if you keep
#         the DB).
#   data/files/  (uploaded file blobs)
#       - data/files/<pageId>/<uuid>-<filename> per upload.
#   data/plugins/  (installed plugin bundles)
#       - data/plugins/<pluginId>/. Initial install recreates from a fresh
#         zip via the admin UI; first-party plugins are not auto-installed
#         here (the e2e seed script does that).
#
# What this KEEPS:
#   - Everything in test-fixtures/ (hello-world-plugin.zip, web-clipper-plugin.zip, drawio-embed-plugin.zip, ...).
#   - .git/, node_modules/, dist/, all source code, scripts/, drizzle/.
#
# Logs: /tmp/wiki-api.log, /tmp/wiki-vite.log (kept across runs unless
# you `rm` them manually — they're outside data/ and not auto-cleaned).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Stop the running dev servers (Fastify on :3000, Vite on :5173) by name. pkill
# -f matches the literal command line so we don't kill unrelated processes.
pkill -f "tsx watch src/server/index.ts" 2>/dev/null || true
pkill -f "vite --host 0.0.0.0"          2>/dev/null || true
sleep 1
# Belt-and-braces: any leftover process bound to 3000 or 5173.
for port in 3000 5173; do
  pid="$(ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p { match($6, /pid=([0-9]+)/, a); print a[1]; exit }')"
  if [ -n "${pid:-}" ]; then
    echo "freeing :$port (pid=$pid)"
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 1

echo "removing $REPO_ROOT/data/"
# `data/` is in .gitignore — rm -rf is safe. We add `data` itself to the
# delete list so the directory is recreated cleanly on next boot. Keeping
# `data/` empty (vs leaving a half-baked state) is what makes the next
# first-user bootstrap a clean run.
rm -rf "$REPO_ROOT/data"
mkdir -p "$REPO_ROOT/data"

echo "starting Fastify API on :3000 (bg) …"
nohup npm run dev:server > /tmp/wiki-api.log 2>&1 &
echo "  api pid $!"

sleep 4   # let the API init the DB + git repo + worker loop

echo "starting Vite dev server on :5173 (bg) …"
nohup npm run dev > /tmp/wiki-vite.log 2>&1 &
echo "  vite pid $!"

sleep 4
echo
echo "ready:"
echo "  vite  → http://localhost:5173/"
echo "  api   → http://localhost:3000/"
echo
echo "logs: tail -f /tmp/wiki-api.log /tmp/wiki-vite.log"
echo "stop: pkill -f 'tsx watch src/server/index.ts'; pkill -f 'vite --host 0.0.0.0'"
