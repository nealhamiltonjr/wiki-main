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
 *
 * §11.3 plugin failure isolation: every handler invocation is
 * independently try/catched. A throw triggers the registered
 * `PluginFailureHandler` (set once by plugin.service.ts at
 * boot) which increments the per-plugin consecutive-failure
 * counter and auto-disables the plugin past the configured
 * threshold. The handler always returns the new counter and
 * whether the plugin was auto-disabled so dispatch can decide
 * whether to unregister that plugin's other subscriptions.
 * A single successful invocation calls the handler with
 * `kind: "success"` to reset the counter.
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
 * §11.3 — wired by plugin.service.ts at boot. Single handler
 * (the registry is process-global and the persistence layer
 * is also process-global). The handler returns the new
 * failure count and whether the plugin was just auto-disabled.
 */
export type PluginFailureHandler = (info: {
  kind: "success" | "failure";
  pluginId: string;
  event: HookEventName;
  message: string;
  error: unknown;
}) => Promise<{ failureCount: number; autoDisabled: boolean } | null>;

let _failureHandler: PluginFailureHandler | null = null;

export function setPluginFailureHandler(handler: PluginFailureHandler | null): void {
  _failureHandler = handler;
}

/**
 * In-process set of plugin ids that are currently in a failure
 * streak (their most recent handler invocation threw). The success
 * path only clears the persisted counter when this plugin id is
 * present — otherwise an unrelated plugin's successful handler
 * would reset a sibling plugin's counter and break the consecutive
 * semantics the threshold depends on.
 */
const _failingPluginIds = new Set<string>();

export function _isPluginInFailureStreak(pluginId: string): boolean {
  return _failingPluginIds.has(pluginId);
}

export function _markPluginFailure(pluginId: string): void {
  _failingPluginIds.add(pluginId);
}

export function _clearPluginFailureStreak(pluginId: string): void {
  _failingPluginIds.delete(pluginId);
}

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
 * §11.3: a throw asks the registered failure handler to
 * increment the per-plugin counter and, if it crosses the
 * threshold, auto-disable the plugin (the handler returns
 * `autoDisabled: true` and we drop every other subscription
 * owned by that plugin id). A successful invocation calls
 * the same handler with `kind: "success"` so the counter
 * resets.
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
      // Success: only ask the failure handler to reset the counter
      // if THIS plugin was previously in a failure streak. Without
      // this guard a healthy plugin's successful handler would
      // wipe a sibling broken plugin's accumulating count and
      // defeat the consecutive-failure threshold.
      if (_failureHandler && _failingPluginIds.has(sub.pluginId)) {
        _failingPluginIds.delete(sub.pluginId);
        try {
          await _failureHandler({
            kind: "success",
            pluginId: sub.pluginId,
            event: sub.event,
            message: "ok",
            error: null,
          });
        } catch {
          // failure handler errors never crash dispatch
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[hooks] plugin "${sub.pluginId}" handler for ${sub.event} threw:`, err);
      _failingPluginIds.add(sub.pluginId);
      let autoDisabled = false;
      if (_failureHandler) {
        try {
          const result = await _failureHandler({
            kind: "failure",
            pluginId: sub.pluginId,
            event: sub.event,
            message: err instanceof Error ? err.message : String(err),
            error: err,
          });
          autoDisabled = result?.autoDisabled ?? false;
        } catch {
          // failure handler errors never crash dispatch
        }
      }
      if (autoDisabled) {
        unregisterPluginHooks(sub.pluginId);
        _failingPluginIds.delete(sub.pluginId);
      }
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
  _failureHandler = null;
  _failingPluginIds.clear();
}

/** Diagnostic accessor — total subscription count across all events. */
export function totalHookSubscriptionCount(): number {
  let n = 0;
  for (const event of Object.keys(_subscriptions) as HookEventName[]) {
    n += _subscriptions[event].length;
  }
  return n;
}