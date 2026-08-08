import { eq, and } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { groups, userGroups, users } from "../db/schema.js";

export async function listGroups() {
  const { db } = getDb();
  return db.select().from(groups);
}

export async function createGroup(name: string, capabilities: string[] = []) {
  const { db } = getDb();
  const id = crypto.randomUUID();
  await db.insert(groups).values({ id, name, capabilities });
  return { id, name, capabilities };
}

export async function updateGroupCapabilities(groupId: string, capabilities: string[]) {
  const { db } = getDb();
  await db.update(groups).set({ capabilities }).where(eq(groups.id, groupId));
}

export async function deleteGroup(id: string) {
  const { db } = getDb();
  await db.delete(groups).where(eq(groups.id, id));
}

export async function listGroupMembers(groupId: string) {
  const { db } = getDb();
  return db
    .select({ userId: users.id, email: users.email, name: users.name })
    .from(userGroups)
    .innerJoin(users, eq(users.id, userGroups.userId))
    .where(eq(userGroups.groupId, groupId));
}

export async function addGroupMember(groupId: string, userId: string) {
  const { db } = getDb();
  const existing = await db
    .select()
    .from(userGroups)
    .where(and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId)));
  if (existing.length > 0) return;
  await db.insert(userGroups).values({ groupId, userId });
}

export async function removeGroupMember(groupId: string, userId: string) {
  const { db } = getDb();
  await db.delete(userGroups).where(and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId)));
}
