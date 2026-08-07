import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/client"),
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Keep the framework + the two heaviest UI libraries out of the main
        // index chunk (which is loaded by the login shell too). Editor/Tiptap
        // already sits in its own lazy chunk. Splitting react/router into its
        // own cacheable vendor chunk is safe (nothing below it imports across),
        // and react-arborist is only used by the authenticated Tree.
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "arborist": ["react-arborist"],
          "ui-vendor": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-context-menu",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-label",
            "@radix-ui/react-slot",
            "cmdk",
            "sonner",
            "lucide-react",
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
