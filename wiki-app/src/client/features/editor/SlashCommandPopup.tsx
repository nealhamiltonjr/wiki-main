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
      style={{
        background: "#fff",
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        overflow: "hidden",
        minWidth: 240,
        maxHeight: 320,
        overflowY: "auto",
        fontSize: 13,
      }}
    >
      {groups.map((group, gi) => (
        <div key={group.name}>
          {gi > 0 && <div style={{ height: 1, background: "#f0f0f0", margin: "0 8px" }} />}
          <div style={{ padding: "4px 12px 2px", fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.5px" }}>
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
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 12px",
                  border: "none",
                  background: isSelected ? "#f0f0f0" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 13,
                }}
              >
                {item.icon && <span style={{ fontSize: 16, width: 20, textAlign: "center" }}>{item.icon}</span>}
                <div>
                  <div style={{ fontWeight: 500 }}>{item.label}</div>
                  {item.description && <div style={{ fontSize: 11, color: "#999" }}>{item.description}</div>}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
