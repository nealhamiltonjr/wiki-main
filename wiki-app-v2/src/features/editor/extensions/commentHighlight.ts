import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Inline-comment highlight decoration (slice 33 follow-on, brief §3.4).
 *
 * Renders one background-highlight decoration per unresolved comment thread
 * scoped to the current block, so the user can see exactly what text each note
 * refers to. Clicking the highlight dispatches a `comment-highlight-click`
 * custom event on the editor view; the host (PageView) opens the comments
 * panel and scrolls the matching thread into view.
 *
 * The plugin keeps a closure reference to the latest `getThreads()` so a
 * freshly-added thread shows the highlight on the next transaction (including
 * the no-op bumps the host dispatches when the threads array reference
 * changes).
 */
export interface CommentThreadLite {
  id: string;
  blockId: string | null;
  rangeFrom: number;
  rangeTo: number;
  selection: string | null;
  resolvedAt: string | null;
}

export interface CommentHighlightOptions {
  getThreads: () => readonly CommentThreadLite[];
}

interface PluginMeta {
  threads: readonly CommentThreadLite[];
}

function buildDecorations(
  doc: import("@tiptap/pm/model").Node,
  threads: readonly CommentThreadLite[],
): DecorationSet {
  if (threads.length === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (const t of threads) {
    if (t.resolvedAt) continue;
    if (!t.blockId) continue;
    const blockRange = findBlockRange(doc, t.blockId);
    if (!blockRange) continue;
    // Clamp to the block itself; an over-large rangeFrom/To (legacy/handwritten
    // anchor) must never bleed into the next paragraph.
    const from = Math.min(
      Math.max(blockRange.from + t.rangeFrom, blockRange.from),
      blockRange.to,
    );
    const to = Math.min(
      Math.max(blockRange.from + t.rangeTo, from),
      blockRange.to,
    );
    if (from >= to) continue;
    const selection = t.selection ?? "";
    const preview = selection.length > 120 ? `${selection.slice(0, 120)}…` : selection;
    decos.push(
      Decoration.inline(from, to, {
        class: "comment-highlight",
        "data-thread-id": t.id,
        title: preview ? `Comment: "${preview}"` : "Comment",
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

/**
 * Walk the live PM doc to find the [from, to) range of the block whose
 * `attrs.id` matches `blockId`. Mirrors `blockRangeForId` in `shared/blockIds`
 * for the JSON tree, but operates on the live ProseMirror node.
 */
function findBlockRange(
  doc: import("@tiptap/pm/model").Node,
  blockId: string,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isBlock && (node.attrs as { id?: string } | null)?.id === blockId) {
      found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  return found;
}

export const CommentHighlight = Extension.create<CommentHighlightOptions>({
  name: "commentHighlight",

  addOptions() {
    return { getThreads: () => [] as readonly CommentThreadLite[] };
  },

  addProseMirrorPlugins() {
    // The closure inside `configure({ getThreads })` is captured ONCE here.
    // Tiptap has no built-in re-render hook for extension options, so the
    // host (PageEditor) explicitly dispatches an empty "threads-bumped"
    // transaction after the threads array reference changes; that transaction
    // carries a fresh `getThreadsMeta` so this plugin's `apply` rebuilds the
    // decorations.
    const pluginKey = new PluginKey<DecorationSet>("commentHighlight");
    const initialThreads = this.options.getThreads();
    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init(_config, state: EditorState) {
            return buildDecorations(state.doc, initialThreads);
          },
          apply(tr: Transaction, old: DecorationSet, _oldState, newState) {
            const meta = tr.getMeta(pluginKey) as PluginMeta | undefined;
            if (!tr.docChanged && !meta) return old;
            return buildDecorations(newState.doc, meta?.threads ?? initialThreads);
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state) ?? DecorationSet.empty;
          },
          handleClick(view: EditorView, _pos, event) {
            const target = event.target as HTMLElement | null;
            if (!(target instanceof HTMLElement)) return false;
            const mark = target.closest("[data-thread-id]");
            if (!(mark instanceof HTMLElement)) return false;
            const id = mark.getAttribute("data-thread-id");
            if (!id) return false;
            view.dom.dispatchEvent(
              new CustomEvent("comment-highlight-click", {
                bubbles: true,
                detail: { threadId: id },
              }),
            );
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});

export default CommentHighlight;

/**
 * Dispatch on the Tiptap view to nudge the CommentHighlight plugin's
 * `apply` so the latest threads list (typically the same array reference
 * after a shallow state update) is reflected in decorations without an
 * editor remount.
 */
export function bumpCommentHighlights(view: EditorView, threads: readonly CommentThreadLite[]): void {
  const tr = view.state.tr;
  const pk = new PluginKey("commentHighlight");
  tr.setMeta(pk, { threads } satisfies PluginMeta);
  view.dispatch(tr);
}

