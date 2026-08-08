import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests hit a real SQLite file, so they must not run in
    // parallel against each other (they'd collide on the same data directory).
    fileParallelism: false,
    testTimeout: 15_000,
    exclude: ["e2e/**", "node_modules/**"],
  },
});
