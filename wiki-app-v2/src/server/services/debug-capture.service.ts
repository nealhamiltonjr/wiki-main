import { strToU8, zipSync } from "fflate";

/**
 * Slice 35 — in-memory debug capture. A bounded ring buffer records HTTP
 * requests, DB calls, and errors while enabled (default OFF). The admin can
 * download everything as a zip from /api/debug/export.zip.
 *
 * Privacy: every captured event is stored as-is; the admin can flip a
 * `redactUserData` toggle (default ON) which strips cookie/authorization
 * headers and any event field named `email`, `password`, `token`, or `cookie`
 * before writing. The zip also includes WARNING.txt documenting that the dump
 * may contain user content.
 */

export interface DebugEvent {
  ts: number;
  kind: "http" | "db" | "error" | "system";
  source: string;
  message: string;
  meta?: Record<string, unknown>;
  durationMs?: number;
}

const MAX_EVENTS = 2000;
const ring: DebugEvent[] = [];
let enabled = false;
let redact = true;

export function isDebugCaptureEnabled(): boolean {
  return enabled;
}

export function setDebugCaptureEnabled(value: boolean): void {
  enabled = value;
  record({
    kind: "system",
    source: "debug-capture",
    message: value ? "debug_capture_enabled" : "debug_capture_disabled",
  });
}

export function setDebugRedact(value: boolean): void {
  redact = value;
}

export function record(ev: Omit<DebugEvent, "ts">): void {
  if (!enabled) return;
  const clean = redact ? redactEvent(ev) : ev;
  ring.push({ ...clean, ts: Date.now() });
  if (ring.length > MAX_EVENTS) ring.shift();
}

function redactEvent(ev: Omit<DebugEvent, "ts">): Omit<DebugEvent, "ts"> {
  const scrub = (obj: Record<string, unknown> | undefined) => {
    if (!obj) return obj;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/email|password|token|cookie|authorization|secret/i.test(k)) {
        out[k] = "[redacted]";
      } else if (typeof v === "object" && v !== null) {
        out[k] = scrub(v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return {
    ...ev,
    message: /password|token|secret/i.test(ev.message) ? "[redacted message]" : ev.message,
    meta: scrub(ev.meta),
  };
}

export function getDebugEvents(): DebugEvent[] {
  return [...ring];
}

export function getDebugConfig(): { enabled: boolean; redactUserData: boolean; eventCount: number; maxEvents: number } {
  return { enabled, redactUserData: redact, eventCount: ring.length, maxEvents: MAX_EVENTS };
}

/** Build a zip of everything captured. Returns a Uint8Array (zip bytes). */
export function buildDebugZip(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "events.json": strToU8(JSON.stringify(getDebugEvents(), null, 2)),
    "config.json": strToU8(JSON.stringify(getDebugConfig(), null, 2)),
    "WARNING.txt": strToU8(
      "This debug capture may contain user-generated content (page text, comments,\n" +
      "filenames) and server diagnostics. Redact was " +
      (redact ? "ON" : "OFF") +
      " at export time.\nTreat this archive as sensitive.\n",
    ),
  };
  return zipSync(files, { level: 6 });
}

/** Record a DB call (called from the prepared-statement wrapper in db/index.ts). */
export function recordDbCall(sql: string, durationMs: number, error?: unknown): void {
  if (!enabled) return;
  record({
    kind: "db",
    source: "sqlite",
    message: sql.slice(0, 500),
    durationMs,
    meta: error ? { error: String(error) } : undefined,
  });
}
