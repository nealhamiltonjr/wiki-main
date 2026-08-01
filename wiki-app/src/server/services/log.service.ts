import { db } from "../db/index.js";
import { systemLogs } from "../db/schema.js";

/** System/debug log only - NOT the security audit log (brief §3.16 keeps these separate). */
export function log(level: "debug" | "info" | "warn" | "error", source: string, message: string, meta?: unknown) {
  if (meta) console.log(`[${level.toUpperCase()}] ${source}: ${message}`, meta);
  else console.log(`[${level.toUpperCase()}] ${source}: ${message}`);

  db.insert(systemLogs)
    .values({ id: crypto.randomUUID(), level, source, message, meta: (meta as any) ?? null })
    .catch((err) => console.error("log write failed", err));
}
