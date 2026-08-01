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

  if (!threadId) return null;

  return (
    <div style={{
      width: 320,
      borderLeft: "1px solid #e0e0e0",
      background: "#fafafa",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 14px",
        borderBottom: "1px solid #e0e0e0",
        background: "#fff",
      }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Comments</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={handleResolve} title="Resolve thread" style={{ fontSize: 12, padding: "2px 8px", cursor: "pointer" }}>
            {thread?.resolvedAt ? "Reopen" : "Resolve"}
          </button>
          <button onClick={onClose} style={{ fontSize: 14, padding: "2px 6px", cursor: "pointer", border: "none", background: "none" }}>✕</button>
        </div>
      </div>

      {/* Thread body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
        {loading && <div style={{ fontSize: 12, color: "#999" }}>Loading…</div>}
        {thread?.resolvedAt && (
          <div style={{ fontSize: 11, color: "#666", marginBottom: 8, padding: "4px 8px", background: "#e8f5e9", borderRadius: 4 }}>
            ✓ Resolved
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
              style={{ width: "100%", padding: 6, fontSize: 12, border: "1px solid #ddd", borderRadius: 4, resize: "vertical", boxSizing: "border-box" }}
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
    <div style={{ marginBottom: 8, padding: "6px 10px", background: "#fff", borderRadius: 6, border: "1px solid #eee", fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ color: "#999", fontSize: 10 }}>{date}</span>
        <button onClick={onDelete} title="Delete" style={{ fontSize: 10, padding: 0, border: "none", background: "none", cursor: "pointer", color: "#999" }}>
          🗑
        </button>
      </div>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{comment.body}</div>
    </div>
  );
}
