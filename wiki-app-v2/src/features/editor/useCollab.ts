import { useEffect, useRef, useState } from "react";
import { Doc } from "yjs";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";

export type CollabStatus = "connecting" | "connected" | "disconnected";

export interface CollabSession {
  doc: Doc;
  provider: HocuspocusProvider;
  isSynced: boolean;
  status: CollabStatus;
}

export interface CollabUser {
  name: string;
  color: string;
}

/**
 * Picks a deterministic caret color from a user id so a given person keeps
 * the same cursor color across sessions.
 */
export function userColor(userId: string): string {
  const palette = [
    "#f43f5e", "#f59e0b", "#10b981", "#06b6d4", "#6366f1",
    "#a855f7", "#ec4899", "#84cc16", "#f97316", "#0ea5e9",
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}

/**
 * Live collaboration session for one page (§8 step 11). Creates a
 * HocuspocusProvider keyed by the branch id — the same document name the
 * server resolves in onAuthenticate — and keeps it for the lifetime of the
 * editor that mounted it (the page route remounts the editor per branch, so
 * the document name never changes mid-session).
 *
 * Destroying the provider flushes pending updates, so the server's
 * onStoreDocument write-back always sees the final session state.
 */
function createSession(documentName: string) {
  const doc = new Doc();
  const provider = new HocuspocusProvider({
    name: documentName,
    document: doc,
    url: "/api/collaboration",
  });
  return { name: documentName, doc, provider };
}

export function useCollab(documentName: string): CollabSession {
  const [isSynced, setIsSynced] = useState(false);
  const [status, setStatus] = useState<CollabStatus>("connecting");

  const sessionRef = useRef<{ name: string; doc: Doc; provider: HocuspocusProvider } | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createSession(documentName);
  } else if (sessionRef.current.name !== documentName) {
    // Defensive: the route remounts per branch, but if the name ever changes
    // while mounted, tear the old session down and start a fresh one.
    sessionRef.current.provider.destroy();
    sessionRef.current = createSession(documentName);
  }

  useEffect(() => {
    const { provider } = sessionRef.current!;
    const onSynced = ({ state }: { state: boolean }) => setIsSynced(state);
    const onStatus = ({ status: next }: { status: WebSocketStatus }) =>
      setStatus(
        next === WebSocketStatus.Connected
          ? "connected"
          : next === WebSocketStatus.Connecting
            ? "connecting"
            : "disconnected",
      );
    provider.on("synced", onSynced);
    provider.on("status", onStatus);
    return () => {
      provider.off("synced", onSynced);
      provider.off("status", onStatus);
    };
  }, []);

  // React StrictMode runs the mount → cleanup → mount cycle once in dev, so a
  // naive cleanup here would destroy the just-created provider and leave the
  // second mount subscribed to a dead session. Deferring the destroy keeps the
  // session alive across that simulated unmount while still tearing it down on
  // a genuine unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current) sessionRef.current?.provider.destroy();
      }, 0);
    };
  }, []);

  const { doc, provider } = sessionRef.current;
  return { doc, provider, isSynced, status };
}
