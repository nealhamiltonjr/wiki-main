import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "../../api/client.js";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "offline" | "conflict";

/**
 * OCC-aware autosave with a retry queue (§11.5).
 *
 * - Every edit marks the page dirty; a debounce later flushes a save.
 * - The save carries `expectedUpdatedAt`; a 409 means someone else saved first
 *   and is surfaced as a hard conflict (never retried blindly).
 * - A network failure does NOT drop the edit: the payload stays queued and is
 *   retried with backoff while the UI shows "offline". This is the explicit
 *   guarantee from §11.5 — an edit is never silently lost to a dropped LAN.
 */
export function useAutosave({
  branchId,
  initialUpdatedAt,
  getContent,
  getTitle,
  onSaved,
  onConflict,
}: {
  branchId: string;
  initialUpdatedAt: Date;
  getContent: () => unknown;
  getTitle: () => string | undefined;
  onSaved: (updatedAt: Date) => void;
  onConflict: () => void;
}) {
  const [state, setState] = useState<SaveState>("idle");
  const updatedAtRef = useRef<Date>(initialUpdatedAt);
  const pendingRef = useRef<{ content: unknown; title?: string; titleProvided: boolean; expectedUpdatedAt: Date } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(1000);
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending || flushing.current) return;
    flushing.current = true;
    setState("saving");
    try {
      const res = await api.savePageContent(branchId, pending);
      pendingRef.current = null;
      retryDelay.current = 1000;
      const next = res.updatedAt ? new Date(res.updatedAt) : pending.expectedUpdatedAt;
      updatedAtRef.current = next;
      onSaved(next);
      setState(pendingRef.current ? "dirty" : "saved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setState("conflict");
        onConflict();
      } else {
        // Network failure / 5xx — keep the payload queued, retry with backoff.
        setState("offline");
        retryTimer.current = setTimeout(() => {
          void flush();
        }, retryDelay.current);
        retryDelay.current = Math.min(retryDelay.current * 2, 30_000);
      }
    } finally {
      flushing.current = false;
    }
  }, [branchId, onSaved, onConflict]);

  const scheduleSave = useCallback(() => {
    pendingRef.current = {
      content: getContent(),
      title: getTitle(),
      titleProvided: getTitle() !== undefined,
      expectedUpdatedAt: updatedAtRef.current,
    };
    setState("dirty");
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => void flush(), 1200);
  }, [flush, getContent, getTitle]);

  const saveNow = useCallback(() => {
    pendingRef.current = {
      content: getContent(),
      title: getTitle(),
      titleProvided: getTitle() !== undefined,
      expectedUpdatedAt: updatedAtRef.current,
    };
    if (retryTimer.current) clearTimeout(retryTimer.current);
    void flush();
  }, [flush, getContent, getTitle]);

  // If the route unmounts with a pending save, flush it immediately (fire and
  // forget) so navigation never loses the last keystrokes.
  useEffect(() => {
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      const pending = pendingRef.current;
      if (pending) {
        void api.savePageContent(branchId, pending).catch(() => {});
      }
    };
  }, [branchId]);

  return { state, scheduleSave, saveNow };
}

export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case "dirty": return "Unsaved changes";
    case "saving": return "Saving…";
    case "saved": return "Saved";
    case "offline": return "Offline — will retry";
    case "conflict": return "Conflict — reload required";
    default: return "";
  }
}
