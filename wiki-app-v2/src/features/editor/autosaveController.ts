import { ApiError } from "../../api/client.js";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "offline" | "conflict";

export interface PendingSave {
  content: unknown;
  title?: string;
  titleProvided: boolean;
  expectedUpdatedAt: Date;
}

export type SavePageFn = (branchId: string, pending: PendingSave) => Promise<{ updatedAt?: string }>;

export interface AutosaveCallbacks {
  onSaved: (updatedAt: Date) => void;
  onConflict: () => void;
  onStateChange: (state: SaveState) => void;
}

const DEBOUNCE_MS = 1200;
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * OCC-aware autosave state machine (§11.5). Extracted from the useAutosave
 * hook so the sequencing rules can be unit-tested without a DOM.
 *
 * - Every edit replaces the queued payload; a debounce flushes a save.
 * - The save carries `expectedUpdatedAt`; a 409 means someone else saved first
 *   and is surfaced as a hard conflict (never retried blindly).
 * - A network failure does NOT drop the edit: the payload stays queued and is
 *   retried with backoff while the UI shows "offline". This is the explicit
 *   guarantee from §11.5 — an edit is never silently lost to a dropped LAN.
 */
export class AutosaveController {
  private pending: PendingSave | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_INITIAL_MS;
  private flushing = false;
  private needsReflush = false;

  constructor(
    private readonly branchId: string,
    private readonly savePage: SavePageFn,
    private readonly callbacks: AutosaveCallbacks,
  ) {}

  /** Debounced save. Call on every edit; the queued payload is replaced. */
  scheduleSave(next: PendingSave): void {
    this.pending = next;
    this.callbacks.onStateChange("dirty");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** Immediate save (manual "Save now"). */
  saveNow(next: PendingSave): void {
    this.pending = next;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.flush();
  }

  /**
   * The payload queued but not yet durably saved. The hook flushes this on
   * unmount so navigation never drops the last keystrokes.
   */
  get queued(): PendingSave | null {
    return this.pending;
  }

  /** Clears timers. Does NOT drop queued work — the caller decides. */
  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.flushing) return;
    this.flushing = true;
    this.callbacks.onStateChange("saving");
    try {
      const res = await this.savePage(this.branchId, pending);
      // Only drop the payload we just saved. An edit that arrived while this
      // save was in flight (scheduleSave/saveNow) must survive, or it is
      // silently lost and the UI flips to "Saved" without ever persisting it.
      if (this.pending === pending) {
        this.pending = null;
      } else {
        this.needsReflush = true;
      }
      this.retryDelay = RETRY_INITIAL_MS;
      const next = res.updatedAt ? new Date(res.updatedAt) : pending.expectedUpdatedAt;
      this.callbacks.onSaved(next);
      this.callbacks.onStateChange(this.pending ? "dirty" : "saved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Hard conflict — someone else saved first. Never retried blindly.
        this.callbacks.onStateChange("conflict");
        this.callbacks.onConflict();
      } else {
        // Network failure / 5xx — keep the payload queued, retry with backoff.
        this.callbacks.onStateChange("offline");
        this.retryTimer = setTimeout(() => void this.flush(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
      }
    } finally {
      this.flushing = false;
      // A payload replaced while we were in flight must still be saved. If a
      // debounce/retry timer is already pending (scheduleSave, network retry)
      // it will do the work; otherwise saveNow's replacement has nothing
      // scheduled and would otherwise sit unsaved forever.
      if (this.needsReflush) {
        this.needsReflush = false;
        if (this.pending && this.retryTimer === null) void this.flush();
      }
    }
  }
}
