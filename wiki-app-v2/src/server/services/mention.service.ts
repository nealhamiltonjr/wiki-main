import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, spaceMembers, branches } from "../db/schema.js";
import { createNotification } from "./notification.service.js";

/**
 * Walk Tiptap JSON content and extract @mention targets.
 *
 * Two shapes are recognized so both the original design and the current client
 * work:
 * - `text` nodes wrapped in a `mention` MARK with `{ type: "user", id }` attrs
 *   (the Phase D design).
 * - `mention` NODES with `{ id, label, mentionSuggestionChar }` attrs — what
 *   `@tiptap/extension-mention` (the client's mentionExtension) inserts.
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
      // mention NODE (current client output)
      if (node.type === "mention" && node.attrs?.id) {
        ids.add(node.attrs.id);
      }
      // mention MARK on a text node (original design)
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
 * Filter a list of user IDs to the subset that:
 *   (a) actually exist in the `users` table, and
 *   (b) are members of at least one space the page is placed in.
 *
 * Slice-55: without this filter, ANY registered user could paste a
 * `mention` node with id=<victim> into a page they own, and the victim
 * would receive a "X mentioned you in /y" notification linking to a
 * page they have no access to — a cross-instance notification spam
 * vector. The skip-self rule further down already handles "X mentions
 * themselves", but the cross-space case wasn't covered.
 */
async function mentionableRecipients(pageId: string, toldBy: string, candidateIds: string[]): Promise<string[]> {
  const { db } = getDb();
  if (candidateIds.length === 0) return [];

  // (a) the candidate users must exist.
  const existingRows = db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, candidateIds))
    .all();
  const validIds = new Set(existingRows.map((u) => u.id));

  // (b) the page's spaces.
  const pageSpaceIds = db
    .select({ spaceId: branches.spaceId })
    .from(branches)
    .where(eq(branches.pageId, pageId))
    .all();
  const spaceIds = [...new Set(pageSpaceIds.map((b) => b.spaceId))];
  if (spaceIds.length === 0) return [];

  // The recipient must be a member of at least one space this page lives in.
  // The branch's access middleware is the deeper gate for branch-scoped
  // checks (comments, etc.); for plain page mentions we use "member of a
  // space the page is in" which is the same gate the comment-thread UI uses
  // for the @-mention suggestion list.
  const memberRows = db
    .select({ userId: spaceMembers.userId, spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(inArray(spaceMembers.spaceId, spaceIds))
    .all();
  const memberSpaceIdsByUser = new Map<string, Set<string>>();
  for (const m of memberRows) {
    let s = memberSpaceIdsByUser.get(m.userId);
    if (!s) { s = new Set(); memberSpaceIdsByUser.set(m.userId, s); }
    s.add(m.spaceId);
  }

  void toldBy; // self-notification is filtered by the caller.
  const out: string[] = [];
  for (const id of candidateIds) {
    if (!validIds.has(id)) continue;
    const userSpaces = memberSpaceIdsByUser.get(id);
    if (!userSpaces) continue;
    if ([...userSpaces].some((sid) => spaceIds.includes(sid))) {
      out.push(id);
    }
  }
  return out;
}

/**
 * On page save: extract mentions from the content, resolve the user IDs,
 * and create notifications for every mentioned user.
 */
export async function processMentions(pageId: string, branchId: string, slug: string, toldBy: string, content: unknown) {
  const mentionedIds = extractMentions(content);
  if (mentionedIds.length === 0) return;

  // Filter to recipient candidates that exist AND share a space with the
  // page. Self-notification is dropped here too so the same user can't
  // spam themselves by pointing a mention at their own id from an
  // already-unlocked session.
  const recipients = await mentionableRecipients(pageId, toldBy, mentionedIds);
  for (const userId of recipients) {
    if (userId === toldBy) continue; // don't notify yourself
    await createNotification(userId, "mention", { pageId, branchId, slug, toldBy, body: `in ${slug}` });
  }
}
