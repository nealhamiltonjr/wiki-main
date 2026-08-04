#!/usr/bin/env bash
cd "$(dirname "$0")/.."
export SETTINGS_ENCRYPTION_KEY="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2"
export BETTER_AUTH_SECRET="super-secret-key-for-dev-at-least-32-chars-long"
export BETTER_AUTH_URL="http://192.168.1.13:3000"
export BETTER_EXTRA_TRUSTED_ORIGINS="http://192.168.1.13:5173,http://192.168.1.13:3000,http://127.0.0.1:5173,http://127.0.0.1:3000,http://localhost:5173,http://localhost:3000"
export NODE_ENV=development
nohup npx tsx src/server/index.ts < /dev/null > /tmp/wiki-server.log 2>&1 &
echo "dev server pid $!"
