import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build tool: Vite (kept from the old app — fast HMR, clean prod builds).
// The TanStack Router Vite plugin generates routeTree.gen.ts from src/routes/
// so the router tree is type-checked at compile time — the whole point of
// switching off hand-assembled React Router.
export default defineConfig({
  plugins: [TanStackRouterVite({ target: "react" }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: {
      // API + WebSocket proxied to the Fastify server (built in slice 2).
      // `ws: true` so the collab socket upgrade at `/api/collaboration`
      // (§8 step 11) reaches Fastify through the same proxy as the REST API.
      "/api": { target: "http://localhost:3000", changeOrigin: true, ws: true },
      "/ws": { target: "ws://localhost:3000", ws: true },
      // Plugin client bundles are served by Fastify from data/plugins (slice-12).
      // The loader's dynamic import() of `/plugins/<id>/client/index.js` must
      // reach the API server in dev — Vite has no file there.
      "/plugins": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
