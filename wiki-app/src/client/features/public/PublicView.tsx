import { useEffect, useState } from "react";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";
import { useTheme } from "../theme/ThemeContext.js";

interface PublicConfig {
  publicMode: boolean;
  siteName: string;
}

interface PublicSpace {
  id: string;
  name: string;
}

interface PublicPage {
  branchId: string;
  pageId: string;
  slug: string;
  updatedAt: string;
}

interface PublicPageContent {
  pageId: string;
  slug: string;
  content: unknown;
}

export function PublicView() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const { theme, toggleLightDark } = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/public/config")
      .then((r) => r.json())
      .then(setConfig);
  }, []);

  if (!config) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!config.publicMode) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <h2>Public mode is not enabled</h2>
        <p>This wiki instance does not serve public content.</p>
      </div>
    );
  }

  return (
    <div className="public-shell">
      <header className="public-header">
        <span className="public-brand" style={{ cursor: "pointer", fontSize: 18 }} onClick={() => navigate("/")}>
          {config.siteName}
        </span>
        <nav className="public-nav">
          <button className="wiki-icon-btn" onClick={() => navigate("/login")}>Sign in</button>
          <button className="wiki-icon-btn" onClick={toggleLightDark}>
            {theme === "dark" ? "☀ Light" : "🌙 Dark"}
          </button>
        </nav>
      </header>

      <div style={{ flex: 1, overflow: "auto" }}>
        <Routes>
          <Route path="/" element={<PublicHome />} />
          <Route path="/space/:spaceId" element={<PublicSpaceView />} />
          <Route path="/page/:branchId" element={<PublicPageView />} />
        </Routes>
      </div>

      <footer style={{
        padding: 12, textAlign: "center", fontSize: 12,
        color: "var(--color-text-muted)", borderTop: "1px solid var(--color-border)",
      }}>
        Powered by Wiki App
      </footer>
    </div>
  );
}

function PublicHome() {
  const [spaces, setSpaces] = useState<PublicSpace[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/public/spaces")
      .then((r) => r.json())
      .then(setSpaces)
      .catch(() => setSpaces([]));
  }, []);

  return (
    <div style={{ padding: 40, maxWidth: 800, margin: "0 auto" }}>
      <h2>Public Spaces</h2>
      {spaces.length === 0 && (
        <p style={{ color: "var(--color-text-muted)" }}>No public spaces available.</p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {spaces.map((s) => (
          <div
            key={s.id}
            onClick={() => navigate(`/space/${s.id}`)}
            style={{
              padding: "12px 16px",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              cursor: "pointer",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <strong>{s.name}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function PublicSpaceView() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const [pages, setPages] = useState<PublicPage[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!spaceId) return;
    fetch(`/api/public/spaces/${spaceId}/pages`)
      .then((r) => r.json())
      .then(setPages)
      .catch(() => setPages([]));
  }, [spaceId]);

  return (
    <div style={{ padding: 40, maxWidth: 800, margin: "0 auto" }}>
      <button onClick={() => navigate("/")} style={{ marginBottom: 16, fontSize: 12 }}>
        ← Back to spaces
      </button>
      <h2>Pages</h2>
      {pages.length === 0 && (
        <p style={{ color: "var(--color-text-muted)" }}>No public pages in this space.</p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {pages.map((p) => (
          <div
            key={p.branchId}
            onClick={() => navigate(`/page/${p.branchId}`)}
            style={{
              padding: "12px 16px",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            <strong>/{p.slug}</strong>
            <span style={{ color: "var(--color-text-muted)", marginLeft: 12, fontSize: 12 }}>
              {new Date(p.updatedAt).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PublicPageView() {
  const { branchId } = useParams<{ branchId: string }>();
  const [page, setPage] = useState<PublicPageContent | null>(null);

  useEffect(() => {
    if (!branchId) return;
    fetch(`/api/public/pages/${branchId}`)
      .then((r) => r.json())
      .then(setPage)
      .catch(() => setPage(null));
  }, [branchId]);

  if (!page) return <div style={{ padding: 40, maxWidth: 800, margin: "0 auto" }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>/{page.slug}</h1>
      <div style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "16px 20px", minHeight: 200 }}>
        <ContentRenderer content={page.content} />
      </div>
    </div>
  );
}

function ContentRenderer({ content }: { content: unknown }) {
  const html = tiptapToHtml(content);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function tiptapToHtml(content: unknown): string {
  try {
    const c = content as any;
    if (!c?.content) return "";
    return c.content.map((node: any) => nodeToHtml(node)).join("");
  } catch {
    return "";
  }
}

function nodeToHtml(node: any): string {
  const text = node.content
    ? node.content.map((n: any) => {
        if (n.type === "text") {
          let t = escapeHtml(n.text ?? "");
          if (n.marks) {
            for (const m of n.marks) {
              if (m.type === "bold") t = `<strong>${t}</strong>`;
              if (m.type === "italic") t = `<em>${t}</em>`;
              if (m.type === "underline") t = `<u>${t}</u>`;
              if (m.type === "link") t = `<a href="${escapeHtml(m.attrs?.href ?? "#")}">${t}</a>`;
              if (m.type === "code") t = `<code>${t}</code>`;
            }
          }
          return t;
        }
        return nodeToHtml(n);
      }).join("")
    : "";

  switch (node.type) {
    case "doc": return text;
    case "paragraph": return `<p>${text}</p>`;
    case "heading": {
      const level = node.attrs?.level ?? 1;
      return `<h${level}>${text}</h${level}>`;
    }
    case "bulletList": return `<ul>${text}</ul>`;
    case "orderedList": return `<ol>${text}</ol>`;
    case "listItem": return `<li>${text}</li>`;
    case "codeBlock": return `<pre><code>${text}</code></pre>`;
    case "blockquote": return `<blockquote>${text}</blockquote>`;
    case "horizontalRule": return "<hr>";
    case "image": {
      const src = escapeHtml(node.attrs?.src ?? "");
      const alt = escapeHtml(node.attrs?.alt ?? "");
      return `<img src="${src}" alt="${alt}" style="max-width:100%">`;
    }
    default: return text;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
