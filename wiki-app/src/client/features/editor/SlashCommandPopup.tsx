import type { SlashCommand } from "./pluginEngine.js";

interface Props {
  items: SlashCommand[];
  command: (item: SlashCommand) => void;
  selectedIndex: number;
}

export function SlashCommandPopup({ items, command, selectedIndex }: Props) {
  if (items.length === 0) return null;

  // Group items by group name for section headers
  const groups: { name: string; items: SlashCommand[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) {
      last.items.push(item);
    } else {
      groups.push({ name: item.group, items: [item] });
    }
  }

  let globalIdx = 0;

  return (
    <div
      className="wiki-popup"
      style={{ minWidth: 240, maxHeight: 320 }}
    >
      {groups.map((group, gi) => (
        <div key={group.name}>
          {gi > 0 && <div className="popup-sep" />}
          <div className="popup-group-title">
            {group.name}
          </div>
          {group.items.map((item) => {
            const idx = globalIdx++;
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={item.name}
                type="button"
                onClick={() => command(item)}
                className={`popup-item${isSelected ? " selected" : ""}`}
              >
                {item.icon && <span className="popup-icon">{item.icon}</span>}
                <div>
                  <div className="popup-label">{item.label}</div>
                  {item.description && <div className="popup-desc">{item.description}</div>}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
