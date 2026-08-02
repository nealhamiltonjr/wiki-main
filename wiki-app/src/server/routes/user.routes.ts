import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { like, or, ne } from "drizzle-orm";
import type { UserContext } from "../../shared/types.js";

export async function userRoutes(app: FastifyInstance) {
  // Search users for @mention autocomplete. Returns id + name for all users
  // except the caller. Requires authentication.
  app.get(
    "/api/users/search",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const { q } = request.query as { q?: string };
      const query = (q ?? "").trim().toLowerCase();

      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
          query
            ? or(like(users.name, `%${query}%`), like(users.email, `%${query}%`))
            : undefined
        )
        .limit(20);

      return reply.send({
        users: rows.filter((u) => u.id !== user.id),
      });
    }
  );
}
