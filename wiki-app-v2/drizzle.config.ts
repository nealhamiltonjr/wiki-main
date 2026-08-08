import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // schema.ts (wiki tables) is added in slice 3.
  schema: ["./src/server/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DB_PATH ?? "./data/wiki.db" },
});
