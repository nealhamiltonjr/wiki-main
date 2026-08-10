import { useEffect, useState, type FormEvent } from "react";
import { History, RotateCcw, Camera, Loader2, CheckCircle2 } from "lucide-react";
import { api, ApiError, type PageHistoryEntry } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * Git history sidebar panel (slice 10). Lists the page's commits (autosaves +
 * manual snapshots), lets an editor create a named snapshot, and restore any
 * past version. Restore is a forward-moving save through the normal OCC path,
 * so a concurrent edit still conflicts safely.
 */
export function HistoryPanel({
  pageId,
  branchId,
  canEdit,
  onRestored,
}: {
  pageId: string;
  branchId: string;
  canEdit: boolean;
  onRestored: () => void;
}) {
  const [entries, setEntries] = useState<PageHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setEntries(await api.getPageHistory(pageId, branchId));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSnapshot = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setSnapshotMsg(null);
    try {
      await api.createSnapshot(pageId, branchId, message.trim());
      setMessage("");
      setSnapshotMsg("Snapshot queued — it will appear shortly.");
      await refresh();
    } catch {
      setSnapshotMsg("Snapshot failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (hash: string) => {
    if (busy || !confirm("Restore this version? Current content will be replaced.")) return;
    setBusy(true);
    setRestoreMsg(null);
    try {
      await api.restorePageVersion(pageId, branchId, hash);
      setRestoreMsg("Restored — saving as a new version.");
      onRestored();
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone saved between opening history and restoring — the server
        // told us to reload (same contract as the live save route).
        setRestoreMsg("This page was updated elsewhere — reloading.");
        onRestored();
      } else {
        setRestoreMsg("Restore failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const isSnapshot = (message: string) => message.startsWith("Snapshot:");

  // Commit messages are "Snapshot: page:<id>: <user message>" — strip the
  // machine-readable prefix so only the user's label is shown.
  const snapshotLabel = (message: string) => {
    let label = message.replace(/^Snapshot:\s*/, "");
    if (label.startsWith(`page:${pageId}:`)) {
      label = label.slice(`page:${pageId}:`.length).replace(/^\s*/, "");
    }
    return label;
  };

  return (
    <aside className="flex h-full w-80 flex-col border-l border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm font-semibold">
        <History className="h-4 w-4" /> Version history
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
          </div>
        )}

        {!loading && (!entries || entries.length === 0) && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No saved versions yet.
            <br />
            Save the page to create one.
          </div>
        )}

        {!loading &&
          entries?.map((entry, i) => (
            <div
              key={entry.hash}
              className={cn(
                "mb-2 rounded-md border border-border p-2.5",
                i === 0 && "bg-accent/40"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium" title={entry.message}>
                    {isSnapshot(entry.message) ? snapshotLabel(entry.message) : "Autosave"}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(entry.date).toLocaleString()} · {entry.hash.slice(0, 7)}
                  </div>
                </div>
                {canEdit && i > 0 && (
                  <button
                    type="button"
                    onClick={() => handleRestore(entry.hash)}
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-border hover:text-foreground"
                    title="Restore this version"
                  >
                    <RotateCcw className="h-3 w-3" /> Restore
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>

      {canEdit && (
        <form onSubmit={handleSnapshot} className="border-t border-border p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Camera className="h-3.5 w-3.5" /> Save a named snapshot
          </div>
          <div className="flex gap-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. before network rework"
              maxLength={200}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
            />
            <button
              type="submit"
              disabled={busy || !message.trim()}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {snapshotMsg && (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3" /> {snapshotMsg}
            </div>
          )}
          {restoreMsg && (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3" /> {restoreMsg}
            </div>
          )}
        </form>
      )}
    </aside>
  );
}
