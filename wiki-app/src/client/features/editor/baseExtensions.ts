import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import { UniqueID } from "@tiptap/extension-unique-id";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { CommentExtension } from "@sereneinserenade/tiptap-comment-extension";
import { defaultGenerateId } from "../../../shared/blockIds.js";

/**
 * ProseMirror's stock codeBlock forbids ALL marks (`marks: ""`), so a comment
 * mark applied to a selection inside a code block is silently dropped by
 * `Transform.addMark` (it checks `parent.type.allowsMarkType`). The thread
 * still got created in the DB and showed in the panel, but the text was never
 * highlighted - which is exactly the reported "no visible comment" bug for the
 * Linux page (a shell script in a code block).
 *
 * This override allows ONLY the `comment` mark inside code blocks (bold/italic
 * /underline etc. remain forbidden), so annotated code stays highlighted and
 * clickable while everything else about the block is unchanged.
 */
const CommentableCodeBlock = CodeBlock.extend({
  marks: "comment",
});

/**
 * The canonical set of Tiptap extensions the editor is built on. Shared by the
 * live Editor and the read-only ShareView so that content saved with any mark
 * or node this app produces (comment marks, images, links, underline) always
 * renders in both places. If one view only loaded a subset (e.g. StarterKit
 * alone), a page containing a comment mark would fail to parse in that view
 * and render as a blank document.
 */
export function baseEditorExtensions({
  editable = true,
  onCommentActivated,
}: {
  editable?: boolean;
  onCommentActivated?: (commentId: string) => void;
} = {}) {
  return [
    // StarterKit (v3) already bundles Link, Underline, and CodeBlock; disable
    // them there and register the explicit configured extensions below so each
    // is defined once (duplicates emit a Tiptap warning and "last one wins"
    // order is fragile).
    StarterKit.configure({ link: false, underline: false, codeBlock: false }),
    CommentableCodeBlock,
    Image,
    LinkExtension.configure({ openOnClick: false, autolink: true }),
    Underline,
    CommentExtension.configure({
      HTMLAttributes: { class: "wiki-comment" },
      ...(onCommentActivated ? { onCommentActivated } : {}),
    }),
    // Phase 1 (§7.12): every block node carries a stable unique id - the anchor
    // for comments, block refs, and backlinks. ids on ALL block types (the
    // extension resolves "all" to every node type except doc/text). Remote
    // collab transactions are filtered out so a remote edit never regenerates
    // ids on content another user authored.
    UniqueID.configure({
      types: "all",
      generateID: () => defaultGenerateId(),
      filterTransaction: (transaction) => !isChangeOrigin(transaction),
    }),
    // Phase 2 (§7.13) content-model extensions: task lists, highlighted text,
    // block alignment, and smart-typography substitutions. All serialize into
    // the Tiptap JSON (and Markdown export via markdown.service.ts where
    // representable); the schema-level ones (taskList/taskItem) also need the
    // server's collab seed schema, which is why they live here rather than in
    // the editing-only set.
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Typography,
  ];
}
