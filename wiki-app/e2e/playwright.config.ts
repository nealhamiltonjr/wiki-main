import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    viewport: { width: 1280, height: 800 },
    video: "off",
  },
  webServer: {
    command: `bash ${path.join(__dirname, "start-server.sh")}`,
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  globalSetup: "./setup.ts",
});
