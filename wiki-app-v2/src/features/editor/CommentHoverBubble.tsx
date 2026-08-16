import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { CommentThread } from "@/api/client";

/**
 * Comment hover bubble (Phase 4.1).
 *
 * When the user hovers over text highlighted by the CommentHighlight
 * extension, this component shows a rich popup with the first comment's
 * body, the author, and a timestamp. Clicking the popup opens the full
 * comments panel (via the same `comment-highlight-click` event the
 * highlight itself dispatches on click).
 *
 * The popup is a portal to document.body so it floats above the editor
 * without being clipped by the editor canvas's overflow rules.
 *
 * Positioned at the hovered element's bounding rect, offset below it.
 * Closes on mouseleave (with a small grace period so the user can move
 * from the highlight to the popup without it closing).
 */

interface Props {
  editor: Editor;
  threads: CommentThread[];
}

export function CommentHoverBubble({ editor, threads }: Props) {
  const [hoverThread, setHoverThread] = useState<{ thread: CommentThread; rect: DOMRect } | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => setHoverThread(null), 200);
  }, [clearHideTimer]);

  useEffect(() => {
    const root = editor.view.dom;
    if (!root) return;

    const handleMouseOver = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!(target instanceof HTMLElement)) return;
      const mark = target.closest("[data-thread-id]");
      if (!(mark instanceof HTMLElement)) return;
      const id = mark.getAttribute("data-thread-id");
      if (!id) return;
      const thread = threads.find((t) => t.id === id);
      if (!thread) return;
      clearHideTimer();
      const rect = mark.getBoundingClientRect();
      setHoverThread({ thread, rect });
    };

    const handleMouseOut = (e: Event) => {
      const target = e.target as HTMLElement;
      const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
      if (related && popupRef.current?.contains(related)) return;
      if (target.closest("[data-thread-id]")) scheduleHide();
    };

    root.addEventListener("mouseover", handleMouseOver);
    root.addEventListener("mouseout", handleMouseOut);
    return () => {
      root.removeEventListener("mouseover", handleMouseOver);
      root.removeEventListener("mouseout", handleMouseOut);
    };
  }, [editor, threads, clearHideTimer, scheduleHide]);

  // Click the popup → dispatch the same event as clicking the highlight
  const openPanel = useCallback((threadId: string) => {
    editor.view.dom.dispatchEvent(new CustomEvent("comment-highlight-click", { bubbles: true, detail: { threadId } }));
    setHoverThread(null);
  }, [editor]);

  if (!hoverThread) return null;

  const { thread, rect } = hoverThread;
  const firstComment = thread.comments[0];
  const commentCount = thread.comments.length;
  const popupTop = rect.bottom + 6;
  const popupLeft = Math.min(rect.left, window.innerWidth - 320);

  return createPortal(
    <div
      ref={popupRef}
      className="comment-hover-bubble"
      style={{ position: "fixed", top: `${popupTop}px`, left: `${popupLeft}px` }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
      onClick={() => openPanel(thread.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPanel(thread.id); } }}
    >
      <div className="comment-hover-header">
        <span className="comment-hover-author">{firstComment?.authorName ?? thread.authorName ?? "Unknown"}</span>
        {commentCount > 1 && <span className="comment-hover-count">{commentCount} replies</span>}
        {thread.resolvedAt && <span className="comment-hover-resolved">resolved</span>}
      </div>
      {firstComment && (
        <div className="comment-hover-body">{firstComment.body}</div>
      )}
      <div className="comment-hover-footer">Click to open thread</div>
    </div>,
    document.body,
  );
}
