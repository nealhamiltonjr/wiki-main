import { useEffect, useRef, useState } from "react";
import { api, type CommentThread } from "../../api/client.js";

/**
 * Siyuan-style hover preview: placing the cursor over a highlighted comment
 * span pops up the comment (author, body, reply count) right there, without
 * opening the side panel. Clicking the highlight still opens the full thread
 * in the right-hand CommentPanel.
 *
 * Implemented with document-level mouseover/mouseout (not React onMouseEnter)
 * because the comment marks live inside ProseMirror's DOM, which React doesn't
 * own. A short hover delay avoids popup flicker while the mouse sweeps across
 * many highlights.
 */
export function CommentHoverPopup({ branchId, onOpen }: { branchId: string; onOpen: (threadId: string) => void }) {
  const [state, setState] = useState<{ threadId: string; x: number; y: number } | null>(null);
  const [thread, setThread] = useState<CommentThread | null>(null);
  const [loading, setLoading] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const threadCache = useRef<Map<string, CommentThread[]>>(new Map());

  // Track whether the pointer is inside the popup so moving from the highlight
  // into the popup doesn't dismiss it prematurely.
  const popupHovered = useRef(false);
  // The thread currently shown in the popup (ref, not state, so the document
  // listeners registered below don't need to re-subscribe when it changes).
  const activeThreadId = useRef<string | null>(null);
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  useEffect(() => {
    async function loadThread(threadId: string) {
      setLoading(true);
      try {
        const cached = threadCache.current.get(branchId);
        const threads = cached ?? (await api.getComments(branchId));
        if (!cached) threadCache.current.set(branchId, threads);
        if (unmounted.current) return;
        setThread(threads.find((t) => t.id === threadId) ?? null);
      } catch {
        if (!unmounted.current) setThread(null);
      } finally {
        // Clear loading even if this load was superseded, otherwise the popup
        // stays on "…" forever (the effect must not cancel the fetch below).
        if (!unmounted.current) setLoading(false);
      }
    }

    function findCommentSpan(target: EventTarget | null): HTMLElement | null {
      return target instanceof Element ? target.closest("span[data-comment-id]") : null;
    }

    function onMouseOver(e: MouseEvent) {
      const span = findCommentSpan(e.target);
      if (!span) return;
      const threadId = span.getAttribute("data-comment-id")!;
      if (activeThreadId.current === threadId) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      showTimer.current = setTimeout(() => {
        activeThreadId.current = threadId;
        const rect = span.getBoundingClientRect();
        setState({ threadId, x: rect.left + rect.width / 2, y: rect.top });
        setThread(null);
        loadThread(threadId);
      }, 220);
    }

    function onMouseOut(e: MouseEvent) {
      const span = findCommentSpan(e.target);
      if (!span) return;
      const next = e.relatedTarget;
      // Leaving the highlight but heading into the popup keeps it open.
      if (next instanceof Element && next.closest(".comment-hover-popup")) return;
      if (showTimer.current) clearTimeout(showTimer.current);
      hideTimer.current = setTimeout(() => {
        if (!popupHovered.current) {
          activeThreadId.current = null;
          setState(null);
        }
      }, 180);
    }

    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [branchId]);

  useEffect(() => {
    // If the panel opens from the popup, close the popup.
    popupHovered.current = false;
  }, []);

  if (!state) return null;

  const firstComment = thread?.comments?.[0];
  const replyCount = (thread?.comments?.length ?? 1) - 1;

  return (
    <div
      className="comment-hover-popup"
      style={{ left: state.x, top: state.y }}
      onMouseEnter={() => { popupHovered.current = true; if (hideTimer.current) clearTimeout(hideTimer.current); }}
      onMouseLeave={() => { popupHovered.current = false; activeThreadId.current = null; setState(null); }}
      onClick={() => { onOpen(state.threadId); activeThreadId.current = null; setState(null); }}
      role="button"
      tabIndex={0}
    >
      {loading && <div className="chp-loading">…</div>}
      {!loading && !firstComment && <div className="chp-empty">No comment body</div>}
      {!loading && firstComment && (
        <>
          <div className="chp-header">
            <span className="chp-author">{firstComment.authorName ?? "Unknown"}</span>
            <span className="chp-date">{new Date(firstComment.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="chp-body">{firstComment.body}</div>
          <div className="chp-footer">
            {replyCount > 0 ? `${replyCount} reply${replyCount === 1 ? "" : "s"}` : "No replies"}
            <span className="chp-open">Click to open thread →</span>
          </div>
        </>
      )}
    </div>
  );
}
