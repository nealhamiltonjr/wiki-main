import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/server/db/schema.ts", "./src/server/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DB_PATH ?? "./data/wiki.db" },
});
