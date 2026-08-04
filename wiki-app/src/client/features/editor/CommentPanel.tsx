import { useState, useEffect, useCallback } from "react";
import { api, type CommentThread, type Comment } from "../../api/client.js";

interface Props {
  threadId: string | null;
  branchId: string;
  onClose: () => void;
}

export function CommentPanel({ threadId, branchId, onClose }: Props) {
  const [thread, setThread] = useState<CommentThread | null>(null);
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchThread = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    try {
      const threads = await api.getComments(branchId);
      const t = threads.find((t) => t.id === threadId);
      setThread(t ?? null);
    } catch {
      setThread(null);
    } finally {
      setLoading(false);
    }
  }, [threadId, branchId]);

  useEffect(() => { fetchThread(); }, [fetchThread]);

  async function handleReply() {
    if (!threadId || !reply.trim()) return;
    await api.addCommentReply(branchId, threadId, reply.trim());
    setReply("");
    await fetchThread();
  }

  async function handleResolve() {
    if (!threadId) return;
    const r = await api.resolveCommentThread(threadId);
    if (r.resolved) onClose();
    await fetchThread();
  }

  async function handleDelete(commentId: string) {
    if (!window.confirm("Delete this comment?")) return;
    await api.deleteComment(commentId);
    await fetchThread();
  }

  // Docmost's "jump to comment selection": clicking the quoted text in the
  // sidebar scrolls the editor to the highlighted span and flashes it, so the
  // annotation is visible even when the panel and the document aren't on screen
  // together.
  function handleJumpToSelection() {
    const el = document.querySelector(
      `span[data-comment-id="${threadId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("wiki-comment-flash");
    setTimeout(() => el.classList.remove("wiki-comment-flash"), 2400);
  }

  if (!threadId) return null;

  return (
    <div className="comment-panel">
      {/* Header */}
      <div className="panel-header">
        <span className="panel-title">Comments</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={handleResolve} title="Resolve thread" className="wiki-icon-btn" style={{ padding: "2px 8px" }}>
            {thread?.resolvedAt ? "Reopen" : "Resolve"}
          </button>
          <button onClick={onClose} title="Close comments" className="wiki-icon-btn" style={{ padding: "2px 6px", border: "none", background: "none", fontSize: 14 }}>✕</button>
        </div>
      </div>

      {/* Thread body */}
      <div className="panel-body">
        {loading && <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Loading…</div>}
        {thread?.resolvedAt && (
          <div className="comment-thread-resolved">
            ✓ Resolved
          </div>
        )}
        {thread?.selection && (
          <div
            onClick={handleJumpToSelection}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleJumpToSelection(); } }}
            title="Jump to comment selection"
            className="comment-quote"
          >
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: 3 }}>
              On selection
            </div>
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
              “{thread.selection}”
            </div>
          </div>
        )}
        {(thread?.comments ?? []).map((c: Comment) => (
          <CommentBubble key={c.id} comment={c} onDelete={() => handleDelete(c.id)} />
        ))}
        {thread && !thread.resolvedAt && (
          <div style={{ marginTop: 10 }}>
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Reply…"
              rows={2}
              style={{ width: "100%", padding: 6, fontSize: 12, border: "1px solid var(--color-border)", borderRadius: 4, resize: "vertical", boxSizing: "border-box", background: "var(--color-surface)", color: "var(--color-text)" }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); } }}
            />
            <button
              onClick={handleReply}
              disabled={!reply.trim()}
              style={{ marginTop: 4, fontSize: 11, padding: "3px 10px", cursor: reply.trim() ? "pointer" : "default" }}
            >
              Reply
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentBubble({ comment, onDelete }: { comment: Comment; onDelete: () => void }) {
  const date = new Date(comment.createdAt).toLocaleString();
  return (
    <div style={{ marginBottom: 8, padding: "6px 10px", background: "var(--color-surface)", borderRadius: 6, border: "1px solid var(--color-border-light)", fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2, gap: 8 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-muted)", fontSize: 10 }}>
          <strong style={{ color: "var(--color-text-secondary)", fontWeight: 600 }}>{comment.authorName ?? "Unknown"}</strong>
          {" · "}{date}
        </span>
        <button onClick={onDelete} title="Delete" style={{ fontSize: 10, padding: 0, border: "none", background: "none", cursor: "pointer", color: "var(--color-text-muted)" }}>
          🗑
        </button>
      </div>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4, color: "var(--color-text)" }}>{comment.body}</div>
    </div>
  );
}
