import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import { baseEditorExtensions } from "../editor/baseExtensions.js";

interface ShareContent {
  slug: string;
  content: unknown;
  permission: string;
}

export function ShareView() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ShareContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError((body as any)?.error ?? "Link not found");
          return null;
        }
        return res.json() as Promise<ShareContent>;
      })
      .then((d) => { if (d) setData(d); });
  }, [token]);

  // Uses the same base extension set as the live editor (image/link/underline
  // + comment marks) so shared pages that contain those nodes/marks render
  // instead of failing to parse and showing a blank document.
  const editor = useEditor({
    extensions: baseEditorExtensions({ editable: false }),
    content: undefined,
    editable: false,
  });

  useEffect(() => {
    if (data && editor) {
      editor.commands.setContent(data.content as any);
    }
  }, [data, editor]);

  function submitPassword() {
    if (!token) return;
    fetch(`/api/share/${encodeURIComponent(token)}?password=${encodeURIComponent(password)}`)
      .then(async (res) => {
        if (!res.ok) {
          setError("Incorrect password");
          return;
        }
        const d = await res.json() as ShareContent;
        setData(d);
        setError(null);
      });
  }

  if (error) {
    return (
      <div style={{ padding: 40, fontFamily: "var(--font-sans)" }}>
        <h2>Shared Page</h2>
        {error === "Password required" ? (
          <div>
            <p>This link is password-protected.</p>
            <input
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitPassword()}
              style={{ padding: 8, marginRight: 8, minWidth: 200 }}
            />
            <button onClick={submitPassword} style={{ padding: "8px 16px" }}>View</button>
          </div>
        ) : (
          <p style={{ color: "var(--color-danger)" }}>{error}</p>
        )}
      </div>
    );
  }

  if (!data) {
    return <div style={{ padding: 40, fontFamily: "var(--font-sans)" }}>Loading…</div>;
  }

  return (
    <div className="share-page">
      <div className="share-header">
        <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Shared page · read-only
        </span>
        <span className="share-title">{data.slug}</span>
      </div>
      <EditorContent
        editor={editor}
        className="wiki-editor-content"
        style={{
          minHeight: 200,
        }}
      />
    </div>
  );
}
