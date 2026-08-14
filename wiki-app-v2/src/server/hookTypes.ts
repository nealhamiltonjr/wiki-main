/**
 * Hook event types — brief §13.5.
 *
 * Discriminated union over the three server-side events the
 * plugin engine currently exposes. The brief explicitly names
 * pageLoad / pageSave / attributeChange; new events should
 * extend the union here and the dispatcher's switch table
 * (only used internally — `dispatchHook` takes the event
 * object directly).
 *
 * Handler signatures:
 *   (event: HookEvent) => void | Promise<void>
 *
 * Errors are caught at dispatch — a throwing handler does NOT
 * break the host request. The host request path calls
 * `dispatchHook` *after* responding to the client (so the hook
 * never adds user-facing latency, even for slow plugins).
 */

export const HOOK_EVENT_NAMES = [
  "pageLoad",
  "pageSave",
  "attributeChange",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export type HookHandler = (event: HookEvent) => void | Promise<void>;

/** Base fields present on every event. */
interface HookEventBase {
  /** ISO timestamp of when the event was dispatched. */
  at: string;
  /** The user whose action caused the event (the actor). */
  actorUserId: string;
}

export interface PageLoadEvent extends HookEventBase {
  event: "pageLoad";
  pageId: string;
  branchId: string;
}

export interface PageSaveEvent extends HookEventBase {
  event: "pageSave";
  pageId: string;
  branchId: string;
}

export interface AttributeChangeEvent extends HookEventBase {
  event: "attributeChange";
  pageId: string;
  /** The attribute that changed. `name` is always present; `value` and
   *  `valuePageId` are present on `set` and absent on `delete`. */
  attribute: {
    name: string;
    value?: string;
    valuePageId?: string;
  };
  action: "set" | "delete";
}

export type HookEvent = PageLoadEvent | PageSaveEvent | AttributeChangeEvent;