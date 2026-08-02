import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import { useSession, signOut } from "../api/authClient.js";
import { Login } from "./auth/Login.js";
import { Tree } from "./tree/Tree.js";
import { Editor } from "./editor/Editor.js";
import { Settings } from "./settings/Settings.js";
import { useTheme } from "./theme/ThemeContext.js";
import { PublicView } from "./public/PublicView.js";
import { useState, useEffect } from "react";

function Sidebar() {
  const navigate = useNavigate();
  const { branchId } = useParams();
  const location = useLocation();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const isSettings = location.pathname.startsWith("/settings");

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      width: "var(--sidebar-width)", minWidth: "var(--sidebar-width)",
      borderRight: "1px solid var(--color-border)",
      background: "var(--color-bg-secondary)",
    }}>
      <Tree selectedBranchId={branchId ?? null} onSelectBranch={(id) => navigate(`/pages/${id}`)} />
      <div className="wiki-sidebar-footer">
        <div className="user-chip">
          <span className="avatar">{(session?.user.name ?? "?").slice(0, 1)}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session?.user.name}{session?.user.isAdmin ? " (admin)" : ""}
          </span>
        </div>
        <div className="footer-actions">
          <button className="wiki-icon-btn" style={{ flex: 1, padding: "4px 10px" }} onClick={() => navigate(isSettings ? "/" : "/settings")}>
            {isSettings ? "← Pages" : "Settings"}
          </button>
          <button className="wiki-icon-btn" style={{ flex: 1, padding: "4px 10px" }} onClick={() => signOut()}>Sign out</button>
        </div>
        <div className="wiki-theme-switcher">
          <span className="theme-label">Theme:</span>
          {(["light", "dark", "contrast"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              title={`${t} theme`}
              className="wiki-icon-btn"
              style={{
                flex: 1,
                textTransform: "capitalize",
                background: theme === t ? "var(--color-primary)" : "var(--color-surface)",
                color: theme === t ? "var(--color-primary-text)" : "var(--color-text)",
                borderColor: theme === t ? "var(--color-primary)" : "var(--color-border)",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EditorRoute() {
  const { branchId } = useParams<{ branchId: string }>();
  return <Editor branchId={branchId!} />;
}

export default function App() {
  const { data: session, isPending, refetch } = useSession();
  const [publicMode, setPublicMode] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/public/config")
      .then((r) => r.json())
      .then((c) => setPublicMode(c.publicMode))
      .catch(() => setPublicMode(false));
  }, []);

  if (isPending || publicMode === null) return null;

  // Public mode: unauthenticated visitors see the public-facing site
  if (!session) {
    if (publicMode) {
      return (
        <Routes>
          <Route path="/login" element={<Login onAuthed={() => refetch()} />} />
          <Route path="*" element={<PublicView />} />
        </Routes>
      );
    }
    return <Login onAuthed={() => refetch()} />;
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: "auto" }}>
        <Routes>
          <Route path="/pages/:branchId" element={<EditorRoute />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/" element={
            <div style={{ padding: "var(--space-6)", color: "var(--color-text-muted)" }}>
              Select or create a page
            </div>
          } />
        </Routes>
      </div>
    </div>
  );
}
