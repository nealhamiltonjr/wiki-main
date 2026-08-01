import type { Editor as TiptapEditor } from "@tiptap/core";

export function Toolbar({ editor, onUploadImage }: { editor: TiptapEditor | null; onUploadImage: () => void }) {
  const btn = (active: boolean): React.CSSProperties => ({
    padding: "4px 8px",
    marginRight: 4,
    fontSize: 13,
    border: "1px solid #ccc",
    borderRadius: 4,
    background: active ? "#333" : "#fff",
    color: active ? "#fff" : "#333",
    cursor: "pointer",
  });

  if (!editor) return null;
  const ed = editor; // non-null after guard (TS doesn't narrow through closures)

  function setLink() {
    const prev = ed.getAttributes("link").href ?? "";
    const href = window.prompt("URL:", prev);
    if (href === null) return;
    if (href === "") ed.chain().focus().unsetLink().run();
    else ed.chain().focus().setLink({ href }).run();
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, padding: "6px 0", marginBottom: 8, borderBottom: "1px solid #eee" }}>
      <button
        type="button"
        style={btn(ed.isActive("bold"))}
        onClick={() => ed.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
      >
        B
      </button>
      <button
        type="button"
        style={btn(ed.isActive("italic"))}
        onClick={() => ed.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
      >
        I
      </button>
      <button
        type="button"
        style={btn(ed.isActive("underline"))}
        onClick={() => ed.chain().focus().toggleUnderline().run()}
        title="Underline (Ctrl+U)"
      >
        U
      </button>
      <button
        type="button"
        style={btn(ed.isActive("code"))}
        onClick={() => ed.chain().focus().toggleCode().run()}
        title="Inline code"
      >
        {"</>"}
      </button>
      <button
        type="button"
        style={btn(ed.isActive("link"))}
        onClick={setLink}
        title="Insert link"
      >
        🔗
      </button>
      <span style={{ width: 1, background: "#ddd", margin: "0 4px" }} />
      <button
        type="button"
        style={btn(ed.isActive("heading", { level: 1 }))}
        onClick={() => ed.chain().focus().toggleHeading({ level: 1 }).run()}
        title="Heading 1"
      >
        H1
      </button>
      <button
        type="button"
        style={btn(ed.isActive("heading", { level: 2 }))}
        onClick={() => ed.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading 2"
      >
        H2
      </button>
      <button
        type="button"
        style={btn(ed.isActive("heading", { level: 3 }))}
        onClick={() => ed.chain().focus().toggleHeading({ level: 3 }).run()}
        title="Heading 3"
      >
        H3
      </button>
      <span style={{ width: 1, background: "#ddd", margin: "0 4px" }} />
      <button
        type="button"
        style={btn(ed.isActive("bulletList"))}
        onClick={() => ed.chain().focus().toggleBulletList().run()}
        title="Bullet list"
      >
        • List
      </button>
      <button
        type="button"
        style={btn(ed.isActive("orderedList"))}
        onClick={() => ed.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      >
        1. List
      </button>
      <button
        type="button"
        style={btn(ed.isActive("blockquote"))}
        onClick={() => ed.chain().focus().toggleBlockquote().run()}
        title="Quote"
      >
        " Quote
      </button>
      <button
        type="button"
        style={btn(ed.isActive("codeBlock"))}
        onClick={() => ed.chain().focus().toggleCodeBlock().run()}
        title="Code block"
      >
        {"{ }"} Code
      </button>
      <span style={{ width: 1, background: "#ddd", margin: "0 4px" }} />
      <button type="button" style={btn(false)} onClick={onUploadImage} title="Insert image">
        🖼
      </button>
      <button type="button" style={btn(false)} onClick={() => ed.chain().focus().undo().run()} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button type="button" style={btn(false)} onClick={() => ed.chain().focus().redo().run()} title="Redo (Ctrl+Shift+Z)">
        ↷
      </button>
    </div>
  );
}
