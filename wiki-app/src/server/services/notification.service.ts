import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { eq, and, desc, isNull } from "drizzle-orm";

interface NotificationPayload {
  pageId?: string;
  branchId?: string;
  slug?: string;
  toldBy?: string;
  body?: string;
  resourceUrl?: string;
}

/**
 * Creates a notification and returns its id.
 */
export async function createNotification(userId: string, kind: "mention" | "system" | "share_warning", payload: NotificationPayload) {
  const [row] = await db
    .insert(notifications)
    .values({ userId, kind, payload } as any)
    .returning({ id: notifications.id });
  return row!.id;
}

/**
 * Returns unread notifications for a user, newest first.
 */
export async function getNotifications(userId: string, limit = 50) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/**
 * Counts unread notifications for a user.
 */
export async function unreadCount(userId: string): Promise<number> {
  const rows = await db
    .select({ count: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows.length;
}

/**
 * Marks a notification as read.
 */
export async function markRead(notificationId: string, userId: string) {
  const now = new Date();
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
}

/**
 * Marks all notifications as read for a user.
 */
export async function markAllRead(userId: string) {
  const now = new Date();
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
