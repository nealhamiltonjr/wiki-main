import { useEffect, useState, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { api, ApiError, type PageContent, type HistoryEntry } from "../../api/client.js";
import { Toolbar } from "./Toolbar.js";
import { getEditorExtensions } from "./pluginEngine.js";
import "./editorPlugins.js"; // populates the registry with core commands

export function Editor({ branchId }: { branchId: string }) {
  const [page, setPage] = useState<PageContent | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Full-width by default (per feedback that our editor looked cramped next
  // to other wiki tools), with a per-user, persisted toggle for the narrower
  // reading width some people prefer for code-heavy pages. First real use of
  // the user_settings table, which existed unused since the original schema.
  const [editorWidth, setEditorWidth] = useState<"full" | "narrow">("full");
  useEffect(() => {
    api.getUserSettings().then((s) => {
      if (s["editor.width"] === "narrow" || s["editor.width"] === "full") {
        setEditorWidth(s["editor.width"]);
      }
    });
  }, []);
  function toggleWidth() {
    const next = editorWidth === "full" ? "narrow" : "full";
    setEditorWidth(next);
    api.setUserSetting("editor.width", next);
  }

  // Read-by-default, click-to-edit (SiYuan-style) - previously the editor was
  // always live-editable for anyone with edit permission, which meant a stray
  // keystroke could silently trigger an autosave. Defaults to view mode;
  // explicit toggle required to start typing.
  const [isEditing, setIsEditing] = useState(false);

  const engineExtensions = getEditorExtensions();

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image,
      LinkExtension.configure({ openOnClick: false, autolink: true }),
      Underline,
      ...engineExtensions,
    ],
    content: undefined,
    editable: isEditing && (page?.access === "editor" || page?.access === "admin"),
    onUpdate: ({ editor }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(editor.getJSON()), 800); // debounced autosave
    },
  });

  useEffect(() => {
    setPage(null);
    setStatus("idle");
    setHistory(null);
    setIsEditing(false); // opening a different page always starts in view mode
    api.getPage(branchId).then((p) => {
      setPage(p);
      editor?.commands.setContent(p.content as any);
      editor?.setEditable(false);
    });
  }, [branchId]);

  useEffect(() => {
    if (!page) return;
    editor?.setEditable(isEditing && (page.access === "editor" || page.access === "admin"));
  }, [isEditing]);

  const save = useCallback(
    async (content: unknown) => {
      if (!page) return;
      setStatus("saving");
      try {
        await api.savePage(page.pageId, page.branchId, content, page.updatedAt);
        const fresh = await api.getPage(branchId); // pick up the new updatedAt for the next save's OCC check
        setPage(fresh);
        setStatus("saved");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setStatus("conflict");
        } else {
          setStatus("error");
        }
      }
    },
    [page, branchId]
  );

  async function reloadAfterConflict() {
    const fresh = await api.getPage(branchId);
    setPage(fresh);
    editor?.commands.setContent(fresh.content as any);
    setStatus("idle");
  }

  async function takeSnapshot() {
    if (!page) return;
    const message = window.prompt("Snapshot message:");
    if (!message) return;
    await api.snapshot(page.pageId, page.branchId, message);
  }

  async function toggleHistory() {
    if (!page) return;
    if (history) {
      setHistory(null);
      return;
    }
    setHistory(await api.getHistory(page.pageId, page.branchId));
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (!page) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await api.uploadFile(page.branchId, file);
    const url = `/api/branches/${page.branchId}/files/${result.id}`;
    // Images render as actual img nodes; everything else inserts a link.
    if (file.type.startsWith("image/")) {
      editor?.chain().focus().setImage({ src: url, alt: result.filename }).run();
    } else {
      editor?.chain().focus().insertContent(`[${result.filename}](${url})`).run();
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function createShareLink() {
    if (!page) return;
    const hours = window.prompt("Link expires in how many hours? (blank = try no-expiration, requires permission)");
    const expiresAt = hours ? new Date(Date.now() + Number(hours) * 3600_000).toISOString() : null;
    try {
      const result = await api.createShareLink(page.branchId, { permission: "view", expiresAt });
      const url = `${window.location.origin}/share/${result.token}`;
      window.prompt("Share link created - copy it:", url);
    } catch (err) {
      if (err instanceof ApiError) {
        window.alert((err.body as any)?.error ?? "Could not create share link");
      }
    }
  }

  if (!page) return <div style={{ padding: 24 }}>Loading…</div>;
  const canEdit = page.access === "editor" || page.access === "admin";

  const triggerUpload = () => fileInputRef.current?.click();

  return (
    <div style={{ padding: 24, maxWidth: editorWidth === "full" ? "none" : 760, margin: editorWidth === "full" ? 0 : "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 13, color: "#666" }}>
        <span>/{page.slug}</span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <StatusLabel status={status} />
          <button onClick={toggleWidth} style={{ fontSize: 12 }} title="Toggle full-width / narrow reading width">
            {editorWidth === "full" ? "Narrow view" : "Full width"}
          </button>
          <button onClick={createShareLink} style={{ fontSize: 12 }}>Share</button>
          {canEdit && (
            <>
              <button onClick={() => setIsEditing((v) => !v)} style={{ fontSize: 12, fontWeight: isEditing ? "bold" : "normal" }}>
                {isEditing ? "Done editing" : "Edit"}
              </button>
              <button onClick={triggerUpload} style={{ fontSize: 12 }}>Upload file</button>
              <input ref={fileInputRef} type="file" onChange={uploadFile} style={{ display: "none" }} />
              <button onClick={takeSnapshot} style={{ fontSize: 12 }}>Snapshot</button>
            </>
          )}
          <button onClick={toggleHistory} style={{ fontSize: 12 }}>{history ? "Hide history" : "History"}</button>
        </div>
      </div>

      {status === "conflict" && (
        <div style={{ background: "#fee", padding: 8, marginBottom: 12, fontSize: 13 }}>
          Someone else saved this page first.{" "}
          <button onClick={reloadAfterConflict}>Reload their version</button>
        </div>
      )}

      {history && (
        <div style={{ background: "#f7f7f7", padding: 8, marginBottom: 12, fontSize: 12 }}>
          {history.length === 0 && <div>No history yet</div>}
          {history.map((h) => (
            <div key={h.hash} style={{ padding: "2px 0", display: "flex", alignItems: "center", gap: 8 }}>
              <code>{h.hash.slice(0, 7)}</code> — {h.message} <span style={{ color: "#999" }}>({h.date})</span>
              {canEdit && (
                <button
                  type="button"
                  style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
                  onClick={async () => {
                    if (!window.confirm(`Restore page content from "${h.message}"? Current content will be replaced.`)) return;
                    const ed = editor;
                    if (!ed) return;
                    ed.setEditable(false);
                    try {
                      await api.restoreHistory(page.pageId, page.branchId, h.hash);
                      const fresh = await api.getPage(page.branchId);
                      setPage(fresh);
                      ed.commands.setContent(fresh.content as any);
                    } catch (err) {
                      console.error("Restore failed", err);
                    } finally {
                      ed.setEditable(true);
                    }
                  }}
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && isEditing && <Toolbar editor={editor} onUploadImage={triggerUpload} />}

      {editor && canEdit && isEditing && (
        <BubbleMenu editor={editor}>
          <div style={{ display: "flex", gap: 2, padding: 4, background: "#fff", border: "1px solid #ddd", borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}>
            <BubbleBtn active={editor.isActive("bold")} label="B" title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} />
            <BubbleBtn active={editor.isActive("italic")} label="I" title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} />
            <BubbleBtn active={editor.isActive("underline")} label="U" title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} />
            <BubbleBtn active={editor.isActive("link")} label="🔗" title="Link" onClick={() => {
              const prev = editor.getAttributes("link").href ?? "";
              const href = window.prompt("URL:", prev);
              if (href === null) return;
              if (href === "") editor.chain().focus().unsetLink().run();
              else editor.chain().focus().setLink({ href }).run();
            }} />
          </div>
        </BubbleMenu>
      )}

      <EditorContent
        editor={editor}
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          minHeight: 300,
          padding: "12px 16px",
          background: isEditing ? "#fff" : "#fafafa", // subtle visual cue for which mode you're in
        }}
      />
    </div>
  );
}

function BubbleBtn({ active, label, title, onClick }: { active: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        padding: "4px 8px",
        fontSize: 13,
        border: "none",
        borderRadius: 4,
        background: active ? "#333" : "transparent",
        color: active ? "#fff" : "#333",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function StatusLabel({ status }: { status: string }) {
  const label = { idle: "", saving: "Saving…", saved: "Saved", conflict: "Conflict", error: "Error saving" }[status] ?? "";
  return <span>{label}</span>;
}
