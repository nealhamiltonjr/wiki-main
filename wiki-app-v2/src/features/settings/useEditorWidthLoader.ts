import { useEffect } from "react";
import { api } from "@/api/client";

/**
 * Phase 4.2 — Load the saved editor width preference at app startup.
 *
 * Previously, the `--editor-width` CSS variable was only set when the
 * Appearance settings page was mounted. Opening a page directly (e.g.
 * navigating to /w/<branchId> from a bookmark) never applied the saved
 * width. This hook fetches the preference once at the _authenticated
 * layout level and sets the CSS variable globally.
 *
 * Also sets a default of "72ch" if no preference is saved, and falls back
 * gracefully if the API is unreachable.
 */
export function useEditorWidthLoader(): void {
  useEffect(() => {
    let cancelled = false;
    void api.getUserSettings().then((rows) => {
      if (cancelled) return;
      const row = rows.find((r) => r.key === "editor.width");
      const width = typeof row?.value === "string" ? row.value : "72ch";
      document.documentElement.style.setProperty("--editor-width", width);
    }).catch(() => {
      // Best-effort — if the API is unreachable, the default from tokens.css
      // (72ch) stays in effect.
    });
    return () => { cancelled = true; };
  }, []);
}
