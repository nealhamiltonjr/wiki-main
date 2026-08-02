// Declarative settings registry (§7.10b). First-party modules register a
// SettingDef once; the framework drives BOTH the admin UI (correct control
// per type) and the server (validation + boot-time consumption). This is the
// same pattern as pluginEngine.ts (§7.5) but for instance configuration.
//
// Shared on purpose: the client renders the typed controls and the server
// validates writes against the exact same defs, so a setting can never be
// saved in a shape the UI couldn't have produced.

export type SettingType = "text" | "number" | "boolean" | "select" | "secret" | "textarea";

export interface SettingDef {
  /** Unique key, e.g. "site.name". Stored in system_settings.key. */
  key: string;
  /** Section label, e.g. "Email". Sections render in registration order. */
  section: string;
  /** Human label shown next to the control. */
  label: string;
  /** Control type. "secret" is a password input that masks at rest and in the list. */
  type: SettingType;
  /** Default value applied when the setting has never been written. */
  default?: unknown;
  /** For "select": the allowed values. */
  options?: { value: string; label: string }[];
  /** Help text shown under the control. */
  help?: string;
  /** Optional validator. Return an error message string, or null for valid. */
  validate?: (value: unknown) => string | null;
}

const defs = new Map<string, SettingDef>();

export function registerSetting(def: SettingDef): void {
  if (defs.has(def.key)) {
    throw new Error(`registerSetting: duplicate key ${def.key}`);
  }
  defs.set(def.key, def);
}

export function getSettingDef(key: string): SettingDef | undefined {
  return defs.get(key);
}

export function getSettingDefs(): SettingDef[] {
  return [...defs.values()];
}

/** Defs grouped by section, preserving registration order within a section. */
export function getSettingSections(): { section: string; defs: SettingDef[] }[] {
  const bySection = new Map<string, SettingDef[]>();
  for (const def of getSettingDefs()) {
    const list = bySection.get(def.section) ?? [];
    list.push(def);
    bySection.set(def.section, list);
  }
  return [...bySection.entries()].map(([section, d]) => ({ section, defs: d }));
}

/** Validate a value against its def (if any). Returns an error string or null. */
export function validateSettingValue(key: string, value: unknown): string | null {
  const def = defs.get(key);
  if (!def) return null; // unknown keys are allowed but unvalidated
  if (def.validate) return def.validate(value);
  switch (def.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return `Expected a number for "${def.label}"`;
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") return `Expected true/false for "${def.label}"`;
      break;
    case "select":
      if (!def.options?.some((o) => o.value === value)) {
        return `"${String(value)}" is not a valid option for "${def.label}"`;
      }
      break;
    case "text":
    case "textarea":
    case "secret":
      if (typeof value !== "string") return `Expected text for "${def.label}"`;
      break;
  }
  return null;
}
