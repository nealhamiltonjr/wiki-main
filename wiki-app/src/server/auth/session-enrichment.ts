import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { resolveUserCapabilities, resolveUserGroupIds } from "../services/capabilities.service.js";

/**
 * better-auth never includes the app's computed fields (group memberships +
 * capability union) in the session user. That left the client blind to
 * group-granted admin powers: `Settings.tsx` gates the admin UI on
 * `session.user.capabilities`, which simply never arrived, so a non-admin group
 * member with `admin.*` capabilities saw no admin UI while the API happily
 * granted them access (200s vs UI 403s).
 *
 * This plugin injects `capabilities` + `groupIds` into the user object on every
 * session-producing response (get-session + sign-in/sign-up), so the client
 * gates match what the server actually enforces.
 */
const SESSION_PATHS = new Set([
  "/get-session",
  "/sign-in/email",
  "/sign-in/username",
  "/sign-in/social",
  "/sign-up/email",
]);

interface SessionUser {
  id?: string;
}

export const sessionEnrichmentPlugin: BetterAuthPlugin = {
  id: "session-capabilities",
  hooks: {
    after: [
      {
        matcher: (context) => !!context.path && SESSION_PATHS.has(context.path),
        handler: createAuthMiddleware(async (ctx) => {
          const returned = ctx.context.returned as { user?: SessionUser } | undefined;
          const user = returned?.user ?? (ctx.context as { newSession?: { user?: SessionUser } }).newSession?.user;
          if (!user?.id) return;

          const [capabilities, groupIds] = await Promise.all([
            resolveUserCapabilities(user.id),
            resolveUserGroupIds(user.id),
          ]);
          (user as SessionUser & { capabilities?: string[]; groupIds?: string[] }).capabilities = capabilities;
          (user as SessionUser & { capabilities?: string[]; groupIds?: string[] }).groupIds = groupIds;

          // Echo the (mutated) body back so the after-hook keeps the enriched
          // response instead of the pre-hook one.
          if (returned) return ctx.json(returned as Record<string, unknown>);
        }),
      },
    ],
  },
};
