import { useState, useEffect, useCallback } from "react";
import { CheckCheck } from "lucide-react";
import { api } from "../../api/client.js";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "../../components/EmptyState.js";

interface NotificationItem {
  id: string;
  kind: "mention" | "system" | "share_warning";
  payload: { slug?: string; branchId?: string; toldBy?: string; body?: string; resourceUrl?: string };
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    api.getNotifications().then((data) => {
      setItems(data.items as NotificationItem[]);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30_000);
    return () => clearInterval(iv);
  }, [refresh]);

  const unread = items.filter((n) => !n.readAt).length;

  function handleClick(n: NotificationItem) {
    api.markNotificationRead(n.id).catch(() => {});
    setOpen(false);
    if (n.payload.branchId) {
      navigate(`/pages/${n.payload.branchId}`);
    } else if (n.payload.resourceUrl) {
      navigate(n.payload.resourceUrl);
    }
    refresh();
  }

  function markAll() {
    api.markAllNotificationsRead().then(refresh).catch(() => {});
  }

  return (
    <div className="bell-wrap">
      <button className={`wiki-page-action bell-btn${unread > 0 ? " has-unread" : ""}`} onClick={() => { setOpen((v) => !v); if (!open) refresh(); }}>
        🔔{unread > 0 && <span className="bell-badge">{unread}</span>}
      </button>
      {open && (
        <div className="bell-dropdown">
          <div className="bell-header">
            <strong>Notifications</strong>
            {unread > 0 && <button className="wiki-page-action" onClick={markAll}>Mark all read</button>}
          </div>
          <div className="bell-list">
            {items.length === 0 && (
              <EmptyState compact icon={CheckCheck} title="You're all caught up" />
            )}
            {items.map((n) => (
              <button key={n.id} className={`bell-item${n.readAt ? "" : " unread"}`} onClick={() => handleClick(n)}>
                <span className="bell-kind">{n.kind === "mention" ? "💬" : n.kind === "system" ? "⚙" : "⚠"}</span>
                <span className="bell-body">
                  {n.kind === "mention" && <>{n.payload.toldBy} mentioned you in {n.payload.slug ?? "a page"}</>}
                  {n.kind === "system" && <>{n.payload.body ?? "System notification"}</>}
                  {n.kind === "share_warning" && (n.payload.body ?? "Share-link warning")}
                </span>
                <span className="bell-time">{fmtAgo(n.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
