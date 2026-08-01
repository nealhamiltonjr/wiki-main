import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import { useSession, signOut } from "../api/authClient.js";
import { Login } from "./auth/Login.js";
import { Tree } from "./tree/Tree.js";
import { Editor } from "./editor/Editor.js";
import { AdminSettings } from "./settings/AdminSettings.js";
import { useTheme } from "./theme/ThemeContext.js";

function Sidebar() {
  const navigate = useNavigate();
  const { branchId } = useParams();
  const location = useLocation();
  const { data: session } = useSession();
  const { theme, toggleLightDark } = useTheme();
  const isSettings = location.pathname.startsWith("/settings");

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      width: "var(--sidebar-width)", minWidth: "var(--sidebar-width)",
      borderRight: "1px solid var(--color-border)",
      background: "var(--color-bg-secondary)",
    }}>
      <Tree selectedBranchId={branchId ?? null} onSelectBranch={(id) => navigate(`/pages/${id}`)} />
      <div style={{
        padding: "var(--space-3)", fontSize: "var(--font-size-sm)",
        borderTop: "1px solid var(--color-border)",
        color: "var(--color-text-secondary)",
        display: "flex", flexDirection: "column", gap: "var(--space-2)",
      }}>
        <span>{session?.user.name} {session?.user.isAdmin ? "(admin)" : ""}</span>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button onClick={toggleLightDark} style={{ fontSize: "var(--font-size-sm)" }}>
            {theme === "dark" ? "☀" : "🌙"}
          </button>
          {session?.user.isAdmin && (
            <button onClick={() => navigate(isSettings ? "/" : "/settings")} style={{ fontSize: "var(--font-size-sm)" }}>
              {isSettings ? "Back to pages" : "Settings"}
            </button>
          )}
          <button onClick={() => signOut()} style={{ fontSize: "var(--font-size-sm)" }}>Sign out</button>
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

  if (isPending) return null;
  if (!session) return <Login onAuthed={() => refetch()} />;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: "auto" }}>
        <Routes>
          <Route path="/pages/:branchId" element={<EditorRoute />} />
          <Route path="/settings" element={<AdminSettings />} />
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
