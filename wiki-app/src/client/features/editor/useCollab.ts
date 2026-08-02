import { useEffect, useMemo, useRef } from "react";
import { Doc } from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";

interface UseCollabOptions {
  pageId: string;
  userName: string;
  userColor: string;
  enabled: boolean;
}

/**
 * Provides a Tiptap Collaboration extension wired to a Hocuspocus WebSocket.
 * Lazily connects only when `enabled` is true.
 *
 * The extensions are produced synchronously (useMemo) so that the Editor can
 * pass them into `useEditor` as a dependency and re-create its instance on the
 * SAME render the collab mode is toggled - Tiptap cannot add extensions to an
 * already-created editor, so the instance must be rebuilt with them present.
 */
export function useCollab({ pageId, userName, userColor, enabled }: UseCollabOptions) {
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const docRef = useRef<Doc | null>(null);

  const extension = useMemo(() => {
    // Tear down any previous collab session (page switch, disable, unmount).
    if (providerRef.current) {
      providerRef.current.disconnect();
      providerRef.current.destroy();
      providerRef.current = null;
    }
    if (docRef.current) {
      docRef.current.destroy();
      docRef.current = null;
    }
    if (!enabled || !pageId) return null;

    const doc = new Doc();
    docRef.current = doc;
    const provider = new HocuspocusProvider({
      url: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/collaboration`,
      name: pageId,
      document: doc,
      token: pageId,
    });
    providerRef.current = provider;

    return [
      Collaboration.configure({ document: doc }),
      CollaborationCaret.configure({
        provider,
        user: { name: userName, color: userColor },
      }),
    ];
  }, [pageId, userName, userColor, enabled]);

  useEffect(() => {
    return () => {
      if (providerRef.current) {
        providerRef.current.disconnect();
        providerRef.current.destroy();
        providerRef.current = null;
      }
      if (docRef.current) {
        docRef.current.destroy();
        docRef.current = null;
      }
    };
  }, []);

  return extension;
}
