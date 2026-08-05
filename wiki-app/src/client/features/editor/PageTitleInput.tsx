import { cn } from "../../lib/utils.js";

/**
 * UI overhaul B5: the page's display title, shown above the editor. Wired to
 * its own save path (savePageOCC splits title from body), so editing the title
 * never 409s against a concurrent body save and vice versa.
 */
export function PageTitleInput({
  value,
  onChange,
  editable,
  onCommit,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Title is editable for editors/admins; viewers get a plain heading. */
  editable: boolean;
  /** Fired on blur / Enter so the caller can flush a pending debounce. */
  onCommit: () => void;
}) {
  return (
    <input
      type="text"
      className={cn("wiki-page-title-input", !editable && "readonly")}
      value={value}
      placeholder="Untitled"
      readOnly={!editable}
      spellCheck={false}
      aria-label="Page title"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
