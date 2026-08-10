import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Same alias as the app's vite.config.ts, so client code that imports
      // through "@/..." can be unit-tested in isolation.
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    // Integration tests hit a real SQLite file, so they must not run in
    // parallel against each other (they'd collide on the same data directory).
    fileParallelism: false,
    testTimeout: 15_000,
    exclude: ["e2e/**", "node_modules/**"],
  },
});
