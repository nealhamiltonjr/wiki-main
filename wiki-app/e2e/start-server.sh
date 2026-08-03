#!/usr/bin/env bash
set -e

# cd to the repo root (where drizzle.config.ts and package.json live)
cd "$(dirname "$0")/.."

export DB_PATH=./data/e2e-test.db
export GIT_REPO_ROOT=./data/e2e-repo
export FILES_ROOT=./data/e2e-files
export BETTER_AUTH_SECRET=e2e-test-secret-key-32chars!
export SETTINGS_ENCRYPTION_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
export BETTER_AUTH_URL=http://localhost:3000
export PORT=3000
export NODE_ENV=production

# The E2E DB is regenerated test data. Removing it (plus WAL/SHM sidecars) before
# the push keeps every run reproducible: `drizzle-kit push --force` cannot replay
# the FTS virtual tables from a previous run, so a stale DB aborts startup.
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
npx drizzle-kit push --force
npm run build:client
exec npx tsx src/server/index.ts
