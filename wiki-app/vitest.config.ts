import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests hit a real SQLite file and the local Git repo, so they
    // must not run in parallel against each other (they'd collide on the same
    // data directory). Unit tests (algorithm, markdown) have no shared state
    // and are unaffected by this.
    fileParallelism: false,
    testTimeout: 15000,
    exclude: ["e2e/**", "node_modules/**"],
  },
});
