/**
 * Server-side hook registry — brief §13.5.
 *
 * Admin-installed plugins can subscribe to in-process events
 * (pageLoad, pageSave, attributeChange) through the `hooks`
 * capability. The hook dispatch path is intentionally cheap
 * and synchronous-friendly: handlers may be sync or return a
 * Promise; one throwing handler must NEVER break the host
 * request path or other handlers.
 *
 * Memory model: the registry lives for the process lifetime
 * and is wiped on restart (and when a plugin is uninstalled
 * or disabled — see `unregisterPluginHooks`). No persistence.
 *
 * Threading: Node.js is single-threaded so we don't need a
 * mutex; we do need a copy of the handler list at dispatch
 * time so a handler that calls `unregister` doesn't corrupt
 * the iteration.
 */
import type { HookEvent, HookHandler, HookEventName } from "./hookTypes.js";

// One (pluginId, handler) pair per subscription.
interface Subscription {
  pluginId: string;
  event: HookEventName;
  handler: HookHandler;
}

// Per-event subscription lists. Kept as arrays so iteration
// order matches registration order — useful when debugging
// plugin interactions.
const _subscriptions: Record<HookEventName, Subscription[]> = {
  pageLoad: [],
  pageSave: [],
  attributeChange: [],
};

/**
 * Register a handler for a named event. Returns an unregister
 * function the caller can call to remove this subscription
 * (also idempotent if called twice).
 */
export function registerHook(
  pluginId: string,
  event: HookEventName,
  handler: HookHandler,
): () => void {
  const list = _subscriptions[event];
  const sub: Subscription = { pluginId, event, handler };
  list.push(sub);
  return () => {
    const idx = list.indexOf(sub);
    if (idx >= 0) list.splice(idx, 1);
  };
}

/**
 * Remove every subscription registered by a given plugin id.
 * Called when a plugin is uninstalled or disabled so a disabled
 * plugin never receives an event again even if its module
 * hasn't been torn down for some reason.
 */
export function unregisterPluginHooks(pluginId: string): void {
  for (const event of Object.keys(_subscriptions) as HookEventName[]) {
    const list = _subscriptions[event];
    for (let i = list.length - 1; i >= 0; i--) {
      const sub = list[i];
      if (sub && sub.pluginId === pluginId) list.splice(i, 1);
    }
  }
}

/**
 * Fire an event. Snapshots the subscription list first so
 * handlers that call `unregister` mid-dispatch don't corrupt
 * the iteration. Each handler is invoked independently with
 * its own try/catch — a throwing handler is logged but does
 * not prevent the next one from running, and does not
 * propagate back to the caller.
 *
 * Returns the number of handlers invoked (handy for tests).
 */
export async function dispatchHook(event: HookEvent): Promise<number> {
  const list = _subscriptions[event.event].slice();
  if (list.length === 0) return 0;
  let invoked = 0;
  for (const sub of list) {
    invoked++;
    try {
      await sub.handler(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[hooks] plugin "${sub.pluginId}" handler for ${sub.event} threw:`, err);
    }
  }
  return invoked;
}

/**
 * Reset the entire registry. Test-only helper — never call
 * from production code paths.
 */
export function __resetHookRegistry(): void {
  for (const event of Object.keys(_subscriptions) as HookEventName[]) {
    _subscriptions[event] = [];
  }
}

/** Diagnostic accessor — total subscription count across all events. */
export function totalHookSubscriptionCount(): number {
  let n = 0;
  for (const event of Object.keys(_subscriptions) as HookEventName[]) {
    n += _subscriptions[event].length;
  }
  return n;
}