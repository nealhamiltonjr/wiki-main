import { defineConfig, devices } from "@playwright/test";

// Slice-4 gate: the full stack. The API webServer first wipes the e2e DB for a
// reproducible run, seeds it (scripts/seed-e2e.ts — user + demo space + tree),
// then boots the Fastify server on :3000. The Vite dev server on :5173 proxies
// /api to it. Tests run against :5173 exactly like the LAN setup does.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command:
        'rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm && ' +
        // Fresh plugin state too — the slice-12 gate uploads hello-world through
        // the real UI, and a stale data/plugins dir would linger across runs.
        'rm -rf data/plugins && ' +
        'DB_PATH=data/e2e.db BETTER_AUTH_SECRET=e2e-secret-0123456789abcdef0123456789abcdef npx tsx scripts/seed-e2e.ts && ' +
        'DB_PATH=data/e2e.db BETTER_AUTH_SECRET=e2e-secret-0123456789abcdef0123456789abcdef BETTER_AUTH_URL=http://localhost:3000 PORT=3000 ' +
        // Parallel e2e workers sign in repeatedly AND every page load fires a
        // session check; better-auth's global bucket (20/60s by default) also
        // applies to /get-session, /sign-out, etc. — not just /sign-in. Disable
        // the two hot paths AND give the global bucket a huge window so the
        // limiter never rejects a worker mid-suite.
        'BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES=\'{"/sign-in/*":false,"/sign-up/*":false}\' ' +
        'BETTER_AUTH_RATE_LIMIT_WINDOW=3600 BETTER_AUTH_RATE_LIMIT_MAX=10000 npx tsx src/server/index.ts',
      url: "http://localhost:3000/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
