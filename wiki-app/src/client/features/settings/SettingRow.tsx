import { useState } from "react";
import type { AdminSettingView } from "../../api/client.js";

interface Props {
  setting: AdminSettingView;
  onSave: (key: string, value: unknown) => Promise<void>;
  onDelete?: (key: string) => Promise<void>;
}

const MASK = "••••••••";

/** Renders one setting def as a typed control. Secrets keep the stored value masked. */
export function SettingRow({ setting, onSave, onDelete }: Props) {
  const [value, setValue] = useState<string>(() => {
    if (setting.type === "boolean") return setting.value === true ? "true" : "false";
    if (setting.value === undefined || setting.value === null) return "";
    return String(setting.value);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isSecret = setting.type === "secret";

  async function save() {
    setError(null);
    setSaving(true);
    try {
      let parsed: unknown = value;
      if (setting.type === "boolean") parsed = value === "true";
      else if (setting.type === "number") parsed = value === "" ? null : Number(value);
      else if (isSecret && value === MASK) parsed = MASK; // unchanged → server keeps stored value
      await onSave(setting.key, parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function resetDefault() {
    setValue(setting.default === undefined || setting.default === null ? "" : String(setting.default));
  }

  return (
    <div className="settings-row-wrap">
      <div className="settings-row">
        <span className="label" title={setting.help}>{setting.label}</span>
        {setting.type === "boolean" ? (
          <select className="settings-select" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        ) : setting.type === "select" ? (
          <select className="settings-select" value={value} onChange={(e) => setValue(e.target.value)}>
            {(setting.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : setting.type === "textarea" ? (
          <textarea className="settings-textarea" value={value} onChange={(e) => setValue(e.target.value)} rows={3} />
        ) : (
          <input
            className="settings-text"
            type={isSecret ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isSecret && value === MASK ? "••••••••" : ""}
          />
        )}
        <div className="settings-row-actions">
          <button className="settings-btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save"}
          </button>
          {!setting.isDefault && (
            <button className="settings-btn" onClick={resetDefault} title="Reset to default">Default</button>
          )}
          {onDelete && (
            <button className="settings-btn danger" onClick={() => onDelete(setting.key)}>Delete</button>
          )}
        </div>
      </div>
      {setting.help && <span className="hint">{setting.help}</span>}
      {error && <span className="settings-error">{error}</span>}
    </div>
  );
}
