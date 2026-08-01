import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

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

  const editor = useEditor({
    extensions: [StarterKit],
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
      <div style={{ padding: 40, fontFamily: "system-ui" }}>
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
          <p style={{ color: "#c00" }}>{error}</p>
        )}
      </div>
    );
  }

  if (!data) {
    return <div style={{ padding: 40, fontFamily: "system-ui" }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 16, fontSize: 24 }}>{data.slug}</h1>
      <EditorContent
        editor={editor}
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          minHeight: 200,
          padding: "12px 16px",
          background: "#fafafa",
        }}
      />
    </div>
  );
}
