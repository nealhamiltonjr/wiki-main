import { useEffect, useRef, useState } from "react";
import { Doc } from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

interface UseCollabOptions {
  pageId: string;
  userName: string;
  userColor: string;
  enabled: boolean;
}

/**
 * Provides a Tiptap Collaboration extension wired to a Hocuspocus WebSocket.
 * Lazily connects only when `enabled` is true.
 * Returns null when disabled — the Editor falls back to the regular content.
 */
export function useCollab({ pageId, userName, userColor, enabled }: UseCollabOptions) {
  const [extension, setExtension] = useState<any>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);

  useEffect(() => {
    if (!enabled || !pageId) return;

    const doc = new Doc();
    const provider = new HocuspocusProvider({
      url: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/collaboration`,
      name: pageId,
      document: doc,
      token: pageId,
    });
    providerRef.current = provider;

    const collabExt = Collaboration.configure({ document: doc });
    const cursorExt = CollaborationCursor.configure({
      provider,
      user: { name: userName, color: userColor },
    });

    setExtension([collabExt, cursorExt]);

    return () => {
      provider.disconnect();
      provider.destroy();
      doc.destroy();
    };
  }, [pageId, userName, userColor, enabled]);

  return extension;
}
