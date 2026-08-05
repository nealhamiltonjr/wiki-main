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
let _loaded = false;

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
  if (!(_loaded && meta.id in _state)) {
    _state = { ..._state, [meta.id]: defaultEnabled };
  }
}

export function getPlugins(): PluginMeta[] {
  return Array.from(registry.values());
}

export async function loadPluginState() {
  if (_loaded) return;
  try {
    const s = await api.getUserSettings();
    const next: Record<string, boolean> = {};
    for (const [id] of registry) {
      const key = `plugin.${id}.enabled`;
      next[id] = typeof s[key] === "boolean" ? s[key] : (_state[id] ?? true);
    }
    _state = next;
  } catch {
    // Keep defaults
  }
  _loaded = true;
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
