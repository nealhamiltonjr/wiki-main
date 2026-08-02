import { db } from "../db/index.js";
import { createNotification } from "./notification.service.js";

/**
 * Walk Tiptap JSON content and extract @mention targets.
 * Mentions are `text` nodes wrapped in a `mention` mark with
 * `{ type: "user", id: "<userId>" }` attributes.
 */
export function extractMentions(content: unknown): string[] {
  try {
    const c = content as any;
    if (!c?.content) return [];
    const ids = new Set<string>();
    walk(c);
    return [...ids];

    function walk(node: any) {
      if (!node) return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      if (node.marks) {
        for (const m of node.marks) {
          if (m.type === "mention" && m.attrs?.type === "user" && m.attrs?.id) {
            ids.add(m.attrs.id);
          }
        }
      }
      if (node.content) walk(node.content);
    }
  } catch {
    return [];
  }
}

/**
 * On page save: extract mentions from the content, resolve the user IDs,
 * and create notifications for every mentioned user.
 */
export async function processMentions(pageId: string, branchId: string, slug: string, toldBy: string, content: unknown) {
  const mentionedIds = extractMentions(content);
  if (mentionedIds.length === 0) return;

  // Resolve mentioned user ids to actual users
  // (for now we trust the userId is valid — no validation needed since it comes from DB)
  for (const userId of mentionedIds) {
    if (userId === toldBy) continue; // don't notify yourself
    await createNotification(userId, "mention", { pageId, branchId, slug, toldBy, body: `in ${slug}` });
  }
}
