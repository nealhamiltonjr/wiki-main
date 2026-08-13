import { useState } from "react";
import { Trash2, RotateCcw, Loader2, Inbox } from "lucide-react";
import { toast } from "sonner";
import { api, type TrashEntry } from "@/api/client";
import { useQuery } from "@/lib/useQuery";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

// Brief §12.1 — Per-space Trash view. Soft-deleted pages (every placement
// was deleted; the page row has deletedAt set) are listed here for a
// retention window. Restore clears deletedAt everywhere the page is
// placed so it returns to every space that had it. Purge is permanent
// (and the brief notes git history remains the long-term record; this
// just stops surfacing the page in the trash list).
//
// The server side (`listTrash`, `restorePage`, `purgePage` +
// /api/spaces/:spaceId/trash{,/restore,/purge}) was already in place
// when this slice landed — the only missing piece was the UI.

type TrashEntryView = TrashEntry;

function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  return `${month}mo ago`;
}

export function TrashPanel({ spaceId }: { spaceId: string }) {
  const { data, loading, error, reload } = useQuery<TrashEntryView[]>(
    () => api.listTrash(spaceId),
    [spaceId]
  );
  const [busyPageId, setBusyPageId] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<TrashEntryView | null>(null);

  const restore = async (pageId: string) => {
    setBusyPageId(pageId);
    try {
      await api.restorePage(spaceId, pageId);
      toast.success("Page restored");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusyPageId(null);
    }
  };

  const purge = async (page: TrashEntryView) => {
    setBusyPageId(page.pageId);
    try {
      await api.purgePage(spaceId, page.pageId);
      toast.success(`"${page.title}" permanently deleted`);
      setConfirmPurge(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Purge failed");
    } finally {
      setBusyPageId(null);
    }
  };

  if (loading && !data) {
    return (
      <section data-testid="trash-panel" className="p-6">
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading trash…
        </div>
      </section>
    );
  }
  if (error) {
    return (
      <section data-testid="trash-panel" className="p-6 text-sm text-danger">
        Failed to load trash: {error.message}
        <Button variant="link" onClick={reload}>Retry</Button>
      </section>
    );
  }

  const entries = data ?? [];

  return (
    <section data-testid="trash-panel" className="p-6">
      <header className="mb-4">
        <h2 className="text-lg font-semibold">Trash</h2>
        <p className="text-sm text-text-muted">
          Pages deleted from this space. Restoring returns the page to every space it was placed in;
          purging deletes it permanently (git history still has older snapshots).
        </p>
      </header>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-12 text-center text-sm text-text-muted">
          <Inbox className="h-8 w-8 opacity-60" />
          <p>The trash is empty.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {entries.map((e) => {
            const isBusy = busyPageId === e.pageId;
            return (
              <li
                key={e.pageId}
                className="flex items-center gap-4 px-4 py-3"
                data-testid="trash-row"
              >
                <Trash2 className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{e.title || e.slug}</div>
                  <div className="truncate text-xs text-text-muted">
                    <code className="font-mono">{e.slug}</code>
                    <span className="mx-1">·</span>
                    <span>deleted {relativeTime(e.deletedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => restore(e.pageId)}
                    disabled={isBusy}
                    data-testid="trash-restore"
                    aria-label={`Restore ${e.title}`}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Restore
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmPurge(e)}
                    disabled={isBusy}
                    data-testid="trash-purge"
                    aria-label={`Permanently delete ${e.title}`}
                  >
                    Delete forever
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmPurge !== null}
        destructive
        pending={busyPageId !== null}
        title="Permanently delete this page?"
        description={
          confirmPurge ? (
            <>
              <strong>{confirmPurge.title || confirmPurge.slug}</strong> will be removed from the
              trash. Older git snapshots remain in history, but the page row and every branch
              placement are erased.
            </>
          ) : null
        }
        confirmLabel="Delete forever"
        onConfirm={() => confirmPurge && void purge(confirmPurge)}
        onCancel={() => setConfirmPurge(null)}
      />
    </section>
  );
}

// Pure helper exposed for unit tests (the relative-time formatter is
// pure and depends only on its inputs — pull it out so tests don't have
// to drive real timers).
export { relativeTime };
