import { useSyncExternalStore, useCallback } from "react";
import { api } from "../../api/client.js";

export interface PluginMeta {
  id: string;
  name: string;
  description: string;
  category: "editor" | "page" | "integration";
  builtIn: boolean;
}

type Listener = () => void;

const registry = new Map<string, PluginMeta>();
const listeners = new Set<Listener>();
let _state: Record<string, boolean> = {};
let _loadedForUser: string | null = null;

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): Record<string, boolean> {
  return _state;
}

function notify() {
  for (const l of listeners) l();
}

export function registerPlugin(meta: PluginMeta, defaultEnabled = true) {
  registry.set(meta.id, meta);
  if (!(meta.id in _state)) {
    _state = { ..._state, [meta.id]: defaultEnabled };
  }
}

export function getPlugins(): PluginMeta[] {
  return Array.from(registry.values());
}

/**
 * Loads the caller's plugin prefs from user_settings. Reloads whenever the
 * authenticated user changes (logged out → different user), so a fresh login
 * always sees their own toggles instead of a stale snapshot. Callers may pass
 * the session user id; without one the state is loaded once and cached.
 */
export async function loadPluginState(userId?: string | null): Promise<void> {
  const key = userId ?? "anon";
  if (_loadedForUser !== null && _loadedForUser === key) return;
  try {
    const s = await api.getUserSettings();
    const next: Record<string, boolean> = {};
    for (const [id] of registry) {
      const pref = `plugin.${id}.enabled`;
      next[id] = typeof s[pref] === "boolean" ? s[pref] : (_state[id] ?? true);
    }
    _state = next;
  } catch {
    // Keep defaults (not authenticated or settings unavailable).
  }
  _loadedForUser = key;
  notify();
}

export function usePluginState() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePluginToggle() {
  return useCallback(async (id: string, enabled: boolean) => {
    _state = { ..._state, [id]: enabled };
    notify();
    await api.setUserSetting(`plugin.${id}.enabled`, enabled);
  }, []);
}

export function isPluginEnabled(id: string): boolean {
  return _state[id] ?? true;
}
