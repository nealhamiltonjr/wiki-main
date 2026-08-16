import { useRef, useMemo } from "react";
import Mention from "@tiptap/extension-mention";
import { request } from "@/api/client";

interface MentionableUser { id: string; name: string; email: string; }

export function useMentionExtension() {
  const cachedUsersRef = useRef<MentionableUser[] | null>(null);
  return useMemo(() => {
    return Mention.configure({
      HTMLAttributes: { class: "mention", "data-mention": "user" },
      suggestion: {
        char: "@",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: async ({ query }: { query: string }): Promise<MentionableUser[]> => {
          if (!cachedUsersRef.current) { try { cachedUsersRef.current = await request<MentionableUser[]>("/api/users/mentionable"); } catch { cachedUsersRef.current = []; } }
          const q = query.toLowerCase();
          return cachedUsersRef.current.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)).slice(0, 8);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        render: () => {
          const state: { selectedIndex: number; items: MentionableUser[]; command: ((item: { id: string; label: string }) => void) | null } = { selectedIndex: 0, items: [], command: null };
          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onStart: (props: any) => { state.command = props.command; void props.items?.then((items: MentionableUser[]) => { state.items = items; state.selectedIndex = 0; showMentionPopup(props.clientRect, items, 0, (item) => { state.command?.(item); hideMentionPopup(); }); }); },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onUpdate: (props: any) => { state.command = props.command; void props.items?.then((items: MentionableUser[]) => { state.items = items; state.selectedIndex = 0; showMentionPopup(props.clientRect, items, 0, (item) => { state.command?.(item); hideMentionPopup(); }); }); },
            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === "Escape") { hideMentionPopup(); return true; }
              if (props.event.key === "ArrowDown" && state.items.length > 0) { state.selectedIndex = Math.min(state.selectedIndex + 1, state.items.length - 1); showMentionPopup(null, state.items, state.selectedIndex, (item) => { state.command?.(item); hideMentionPopup(); }); return true; }
              if (props.event.key === "ArrowUp" && state.items.length > 0) { state.selectedIndex = Math.max(state.selectedIndex - 1, 0); showMentionPopup(null, state.items, state.selectedIndex, (item) => { state.command?.(item); hideMentionPopup(); }); return true; }
              if (props.event.key === "Enter" && state.items[state.selectedIndex]) { state.command?.({ id: state.items[state.selectedIndex]!.id, label: state.items[state.selectedIndex]!.name }); hideMentionPopup(); return true; }
              return false;
            },
            onExit: () => { hideMentionPopup(); state.items = []; state.command = null; },
          };
        },
      },
    });
  }, []);
}

let popupEl: HTMLDivElement | null = null;
function ensurePopupEl(): HTMLDivElement {
  if (!popupEl) { popupEl = document.createElement("div"); popupEl.className = "mention-popup-container"; popupEl.style.display = "none"; document.body.appendChild(popupEl); }
  return popupEl;
}
function showMentionPopup(clientRect: (() => DOMRect | null) | null, items: MentionableUser[], selectedIndex: number, onSelect: (item: { id: string; label: string }) => void) {
  const el = ensurePopupEl();
  el.style.display = "block";
  if (clientRect) { const rect = clientRect(); if (rect) { el.style.position = "fixed"; el.style.top = `${rect.bottom + 4}px`; el.style.left = `${rect.left}px`; el.style.display = "block"; } }
  el.innerHTML = "";
  if (items.length === 0) { const empty = document.createElement("div"); empty.className = "mention-popup-empty"; empty.textContent = "No users found"; el.appendChild(empty); return; }
  items.forEach((item, i) => {
    const btn = document.createElement("button"); btn.type = "button"; btn.className = `mention-popup-item${i === selectedIndex ? " selected" : ""}`;
    btn.innerHTML = `<div class="mention-popup-name">${escapeHtml(item.name)}</div><div class="mention-popup-email">${escapeHtml(item.email)}</div>`;
    btn.onclick = () => onSelect({ id: item.id, label: item.name }); el.appendChild(btn);
  });
}
function hideMentionPopup() { if (popupEl) popupEl.style.display = "none"; }

/** Remove the popup element from the DOM entirely. Call on editor unmount. */
export function destroyMentionPopup() { if (popupEl) { popupEl.remove(); popupEl = null; } }
function escapeHtml(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
