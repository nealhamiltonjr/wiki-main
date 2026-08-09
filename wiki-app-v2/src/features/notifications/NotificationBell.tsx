import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { api, type NotificationEntry } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * Notification bell (slice 9). Polls the unread count every 30s and on mount,
 * opens a dropdown with the newest notifications, and offers mark-all-read.
 * Rendered in the topbar chrome so it is visible from every authenticated page.
 */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const res = await api.listNotifications();
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      // bell is non-critical chrome; keep last known state
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const openDropdown = async () => {
    setOpen((o) => !o);
    if (!open) await refresh();
  };

  const markAll = async () => {
    setLoading(true);
    try {
      await api.markAllNotificationsRead();
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative" ref={ref} data-testid="notification-bell">
      <button
        type="button"
        onClick={() => void openDropdown()}
        className="relative flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-surface-hover transition-colors"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        data-testid="notification-bell-button"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white"
            data-testid="notification-unread-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-surface shadow-lg"
          data-testid="notification-dropdown">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium">Notifications</span>
            <button
              type="button"
              onClick={() => void markAll()}
              disabled={loading || unread === 0}
              className="flex items-center gap-1 text-xs text-text-secondary hover:text-primary disabled:opacity-50 transition-colors"
              data-testid="notifications-mark-all"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3 w-3" />}
              Mark all read
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-muted">No notifications yet</p>
            ) : (
              items.map((n) => <NotificationRow key={n.id} n={n} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({ n }: { n: NotificationEntry }) {
  const payload = n.payload as { slug?: string; body?: string; toldBy?: string };
  const title = payload.slug ? `@mentioned in ${payload.slug}` : n.kind;
  const detail = payload.body ?? (n.kind === "mention" ? "Someone mentioned you" : "System notification");
  const read = !!n.readAt;

  return (
    <div
      className={cn("border-b border-border px-3 py-2 last:border-b-0", !read && "bg-accent/40")}
      data-testid="notification-row"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{title}</span>
        {!read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{detail}</p>
    </div>
  );
}
