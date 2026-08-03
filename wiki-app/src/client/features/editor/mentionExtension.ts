import Mention from "@tiptap/extension-mention";
import { PluginKey } from "prosemirror-state";

interface MentionUser {
  id: string;
  name: string;
  email: string;
}

/**
 * @mention extension. Triggers on `@`, searches users via /api/users/search,
 * and inserts a `mention` NODE with `{ id, label, mentionSuggestionChar }`
 * attrs (the `@tiptap/extension-mention` default command).
 *
 * On save, `processMentions()` in the server reads these nodes (and the older
 * mention-mark shape) and fires notification rows for every mentioned user.
 */
export const MentionExtension = Mention.configure({
  HTMLAttributes: { class: "wiki-mention" },
  renderHTML({ options, node }) {
    return [
      "span",
      { class: "wiki-mention", "data-mention-id": node.attrs.id },
      `@${node.attrs.label ?? node.attrs.id}`,
    ];
  },
  suggestion: {
    char: "@",
    pluginKey: new PluginKey("mention"),
    allowSpaces: false,
    items: ({ query }: { query: string }) => {
      // Returning an empty array triggers the async render path
      return [];
    },
    render: () => createMentionRenderer(),
  },
});

function createMentionRenderer() {
  let popupEl: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let selectedIndex = 0;
  let users: MentionUser[] = [];
  let latestProps: any = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (users.length === 0) {
      listEl.innerHTML = '<div class="suggestion-empty">No users found</div>';
      return;
    }
    users.forEach((u, i) => {
      const btn = document.createElement("button");
      btn.className = `suggestion-item${i === selectedIndex ? " selected" : ""}`;
      btn.innerHTML = `<span class="suggestion-title">@${escapeHtml(u.name)}</span><span class="suggestion-slug">${escapeHtml(u.email)}</span>`;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        latestProps?.command({ id: u.id, label: u.name });
      });
      listEl!.appendChild(btn);
    });
  }

  function doSearch(query: string) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, { credentials: "include" });
        const data = await res.json();
        users = data.users ?? [];
      } catch {
        users = [];
      }
      renderList();
    }, 100);
  }

  return {
    onStart: (props: any) => {
      latestProps = props;
      users = [];
      selectedIndex = 0;

      popupEl = document.createElement("div");
      popupEl.className = "suggestion-list";
      popupEl.style.position = "absolute";
      popupEl.style.zIndex = "999";
      popupEl.style.background = "var(--color-surface)";
      popupEl.style.border = "1px solid var(--color-border)";
      popupEl.style.borderRadius = "6px";
      popupEl.style.padding = "4px";
      popupEl.style.minWidth = "200px";
      popupEl.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";

      listEl = document.createElement("div");
      popupEl.appendChild(listEl);

      const rect = props.clientRect?.();
      if (rect) {
        popupEl.style.left = `${window.scrollX + rect.left}px`;
        popupEl.style.top = `${window.scrollY + rect.bottom + 4}px`;
      }

      document.body.appendChild(popupEl);

      doSearch(props.query ?? "");
    },

    onUpdate: (props: any) => {
      latestProps = props;
      selectedIndex = 0;
      doSearch(props.query ?? "");
    },

    onKeyDown: (props: any) => {
      if (props.event.key === "ArrowDown") {
        selectedIndex = Math.min(selectedIndex + 1, users.length - 1);
        renderList();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        renderList();
        return true;
      }
      if (props.event.key === "Enter") {
        const user = users[selectedIndex];
        if (user) {
          // @tiptap/suggestion v3 does NOT pass `command` into onKeyDown —
          // only { view, event, range }. Use the command bound to the CURRENT
          // range from the latest props.
          latestProps?.command({ id: user.id, label: user.name });
          return true;
        }
      }
      if (props.event.key === "Escape") {
        return true;
      }
      return false;
    },

    onExit: () => {
      latestProps = null;
      if (searchTimer) clearTimeout(searchTimer);
      if (popupEl) { popupEl.remove(); popupEl = null; }
      listEl = null;
      users = [];
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
