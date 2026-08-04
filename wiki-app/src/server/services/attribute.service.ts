import { db } from "../db/index.js";
import { attributes } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

export interface AttributeRow {
  id: string;
  pageId: string;
  name: string;
  value: string;
  isPromoted: boolean;
  position: number;
  createdAt: Date;
}

export async function getAttributeById(id: string): Promise<AttributeRow | null> {
  return (db.select().from(attributes).where(eq(attributes.id, id)).get() as AttributeRow | undefined) ?? null;
}

export async function listAttributes(pageId: string): Promise<AttributeRow[]> {
  return db.select().from(attributes).where(eq(attributes.pageId, pageId)).orderBy(attributes.position).all() as AttributeRow[];
}

export async function createAttribute(pageId: string, name: string, value: string, isPromoted = false): Promise<AttributeRow> {
  const id = crypto.randomUUID();
  const now = new Date();
  const maxPos = db.select({ p: attributes.position }).from(attributes).where(eq(attributes.pageId, pageId)).all();
  const position = maxPos.length > 0 ? Math.max(...maxPos.map(r => r.p)) + 1 : 0;
  db.insert(attributes).values({ id, pageId, name, value, isPromoted, position, createdAt: now }).run();
  return db.select().from(attributes).where(eq(attributes.id, id)).get() as AttributeRow;
}

export async function updateAttribute(id: string, fields: { name?: string; value?: string; isPromoted?: boolean; position?: number }): Promise<AttributeRow | null> {
  const existing = db.select().from(attributes).where(eq(attributes.id, id)).get() as AttributeRow | undefined;
  if (!existing) return null;
  db.update(attributes).set(fields).where(eq(attributes.id, id)).run();
  return db.select().from(attributes).where(eq(attributes.id, id)).get() as AttributeRow;
}

export async function deleteAttribute(id: string): Promise<boolean> {
  const result = db.delete(attributes).where(eq(attributes.id, id)).run();
  return result.changes > 0;
}
