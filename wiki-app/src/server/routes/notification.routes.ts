import type { FastifyInstance } from "fastify";
import { getNotifications, unreadCount, markRead, markAllRead } from "../services/notification.service.js";
import type { UserContext } from "../../shared/types.js";

export async function notificationRoutes(app: FastifyInstance) {
  // List current user's notifications, newest first.
  app.get(
    "/api/notifications",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const list = await getNotifications(user.id);
      const count = list.filter((n) => !n.readAt).length;
      return reply.send({ items: list, unread: count });
    }
  );

  // Unread count (for polling / badge).
  app.get(
    "/api/notifications/unread-count",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const count = await unreadCount(user.id);
      return reply.send({ unread: count });
    }
  );

  // Mark a single notification as read.
  app.put(
    "/api/notifications/:id/read",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const { id } = request.params as { id: string };
      await markRead(id, user.id);
      return reply.send({ ok: true });
    }
  );

  // Mark all as read.
  app.put(
    "/api/notifications/read-all",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      await markAllRead(user.id);
      return reply.send({ ok: true });
    }
  );
}
