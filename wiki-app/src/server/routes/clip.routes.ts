import type { FastifyInstance } from "fastify";
import { z } from "zod";
import TurndownService from "turndown";
import { markdownToTiptap } from "../services/markdown.service.js";
import { createPage } from "../services/page.service.js";
import { resolveSpaceRole } from "../services/branch.service.js";
import type { UserContext } from "../../shared/types.js";

const clipBody = z.object({
  html: z.string().min(1),
  sourceUrl: z.string().url(),
  title: z.string().min(1),
  spaceId: z.string().min(1),
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "clip";
}

export async function clipRoutes(app: FastifyInstance) {
  app.post(
    "/api/clip",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const body = clipBody.parse(request.body);
      const user = (request as any).userContext as UserContext;

      // Verify editor access on the target space
      if (!user.isAdmin) {
        const role = await resolveSpaceRole(user.id, body.spaceId, user.groupIds);
        if (!role || (role !== "editor" && role !== "admin")) {
          return reply.code(403).send({ error: "Insufficient space permissions" });
        }
      }

      // HTML → Markdown → Tiptap JSON
      const markdown = turndown.turndown(body.html);
      const snippet = markdown.slice(0, 2000); // reasonable truncation for one clip
      const attribution = `> Clipped from [${body.sourceUrl}](${body.sourceUrl})\n\n`;
      const content = markdownToTiptap(attribution + snippet);

      const result = await createPage({
        slug: slugify(body.title),
        ownerId: user.id,
        spaceId: body.spaceId,
        parentBranchId: null,
        initialContent: content,
      });

      return reply.code(201).send(result);
    }
  );
}
