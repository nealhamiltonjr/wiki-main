import { useEffect, useState, type FormEvent } from "react";
import { MessageSquare, Send, CheckCircle2, RotateCcw, Loader2 } from "lucide-react";
import { api, type CommentThread } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * Comment sidebar panel (slice 9). Lists threads for the current branch, lets
 * an editor create a new note (anchored to the whole page for the simple UI),
 * reply to a thread, and toggle resolution. Viewers can read only.
 */
export function CommentsPanel({ branchId, canEdit }: { branchId: string; canEdit: boolean }) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setThreads(await api.listComments(branchId));
    } catch {
      setThreads([]);
    } finally {
      setLoading(false);
    }
  };

  // Refresh when the panel is first opened (mounted) and every 15s.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <CommentsPanelBody
    branchId={branchId}
    canEdit={canEdit}
    threads={threads}
    loading={loading}
    draft={draft}
    setDraft={setDraft}
    replies={replies}
    setReplies={setReplies}
    busy={busy}
    setBusy={setBusy}
    refresh={refresh}
  />;
}

function CommentsPanelBody({
  branchId, canEdit, threads, loading, draft, setDraft, replies, setReplies, busy, setBusy, refresh,
}: {
  branchId: string;
  canEdit: boolean;
  threads: CommentThread[] | null;
  loading: boolean;
  draft: string;
  setDraft: (s: string) => void;
  replies: Record<string, string>;
  setReplies: (r: Record<string, string>) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const submitThread = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      // Simple UI anchor: whole-page thread (range 0..0). The comment marks in
      // the editor body are what the richer selection UI would produce; the
      // panel still records and displays the note.
      await api.createCommentThread(branchId, { rangeFrom: 0, rangeTo: 0, body: draft.trim() });
      setDraft("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const submitReply = async (threadId: string, e: FormEvent) => {
    e.preventDefault();
    const body = replies[threadId]?.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.replyToThread(branchId, threadId, body);
      setReplies({ ...replies, [threadId]: "" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleResolve = async (threadId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.resolveThread(threadId);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface/50"
      data-testid="comments-panel" aria-label="Comments">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <MessageSquare className="h-4 w-4 text-text-secondary" />
        <h3 className="text-xs font-medium">Comments</h3>
      </div>

      {canEdit && (
        <form onSubmit={(e) => void submitThread(e)} className="border-b border-border p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note…"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-surface px-2.5 py-2 text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            data-testid="comment-draft"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
              data-testid="comment-submit"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Add note
            </button>
          </div>
        </form>
      )}

      <div className="divide-y divide-border">
        {loading && <p className="p-4 text-center text-xs text-text-muted">Loading…</p>}
        {!loading && threads?.length === 0 && (
          <p className="p-4 text-center text-xs text-text-muted">No comments yet</p>
        )}
        {threads?.map((t) => (
          <div key={t.id} className="p-3" data-testid="comment-thread">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                {t.authorName ?? "Unknown"}
                {t.selection ? <span className="ml-1 font-normal text-text-muted">· “{t.selection}”</span> : null}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void toggleResolve(t.id)}
                  disabled={busy}
                  aria-label={t.resolvedAt ? "Unresolve thread" : "Resolve thread"}
                  data-testid="thread-resolve"
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded transition-colors",
                    t.resolvedAt ? "text-emerald-500 hover:bg-emerald-500/10" : "text-text-muted hover:bg-surface-hover"
                  )}
                >
                  {t.resolvedAt ? <RotateCcw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
            {t.resolvedAt ? (
              <p className="mt-1 text-[11px] text-emerald-600" data-testid="thread-resolved-label">Resolved</p>
            ) : null}
            {t.comments.map((c) => (
              <div key={c.id} className="mt-2 rounded-md border border-border bg-surface px-2.5 py-2"
                data-testid="comment-item">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-text-secondary">{c.authorName ?? "Unknown"}</span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed">{c.body}</p>
              </div>
            ))}
            {canEdit && !t.resolvedAt && (
              <form onSubmit={(e) => void submitReply(t.id, e)} className="mt-2 flex gap-2">
                <input
                  value={replies[t.id] ?? ""}
                  onChange={(e) => setReplies({ ...replies, [t.id]: e.target.value })}
                  placeholder="Reply…"
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
                  data-testid="comment-reply-input"
                />
                <button
                  type="submit"
                  disabled={busy || !(replies[t.id] ?? "").trim()}
                  className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                  data-testid="comment-reply-submit"
                >
                  Reply
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
