import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api/client.js";
import {
  AutosaveController,
  type PendingSave,
  type SaveState,
  type SavePageFn,
} from "./autosaveController.js";

export type { SaveState, SavePageFn };

/**
 * OCC-aware autosave with a retry queue (§11.5). Thin wrapper over
 * AutosaveController (see that class for the sequencing rules); this hook just
 * bridges controller events to React state and flushes queued work on unmount.
 */
export function useAutosave({
  branchId,
  initialUpdatedAt,
  getContent,
  getTitle,
  onSaved,
  onConflict,
  savePage,
}: {
  branchId: string;
  initialUpdatedAt: Date;
  getContent: () => unknown;
  getTitle: () => string | undefined;
  onSaved: (updatedAt: Date) => void;
  onConflict: () => void;
  /** Override for callers that must transform the payload before it hits the
   *  API (e.g. §13.7 encrypted pages re-seal the body client-side). Defaults to
   *  the plain `api.savePageContent`. */
  savePage?: SavePageFn;
}) {
  const [state, setState] = useState<SaveState>("idle");

  const lastUpdatedAtRef = useRef(initialUpdatedAt);
  // Callbacks are read through refs at event time so the long-lived controller
  // never captures a stale closure across renders.
  const onSavedRef = useRef(onSaved);
  const onConflictRef = useRef(onConflict);
  const savePageRef = useRef(savePage ?? ((id: string, pending: PendingSave) => api.savePageContent(id, pending)));
  onSavedRef.current = onSaved;
  onConflictRef.current = onConflict;
  savePageRef.current = savePage ?? savePageRef.current;

  const controllerRef = useRef<AutosaveController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new AutosaveController(
      branchId,
      (id, pending) => savePageRef.current(id, pending),
      {
        onSaved: (next) => {
          lastUpdatedAtRef.current = next;
          onSavedRef.current(next);
        },
        onConflict: () => onConflictRef.current(),
        onStateChange: setState,
      },
    );
  }
  const controller = controllerRef.current;

  const buildPending = useCallback((): PendingSave => {
    const title = getTitle();
    return {
      content: getContent(),
      title,
      titleProvided: title !== undefined,
      expectedUpdatedAt: lastUpdatedAtRef.current,
    };
  }, [getContent, getTitle]);

  const scheduleSave = useCallback(() => {
    controller.scheduleSave(buildPending());
  }, [controller, buildPending]);

  const saveNow = useCallback(() => {
    controller.saveNow(buildPending());
  }, [controller, buildPending]);

  // A fresh expectedUpdatedAt (e.g. after reload) must be used by the next save.
  useEffect(() => {
    lastUpdatedAtRef.current = initialUpdatedAt;
  }, [initialUpdatedAt]);

  // If the route unmounts with a pending save, flush it immediately (fire and
  // forget) so navigation never loses the last keystrokes.
  useEffect(() => {
    return () => {
      const pending = controller.queued;
      controller.dispose();
      if (pending) {
        void savePageRef.current(branchId, pending).catch(() => {});
      }
    };
  }, [branchId, controller]);

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
