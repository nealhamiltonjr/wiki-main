import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import { useSession, signOut } from "../api/authClient.js";
import { Login } from "./auth/Login.js";
import { Tree } from "./tree/Tree.js";
import { Editor } from "./editor/Editor.js";
import { AdminSettings } from "./settings/AdminSettings.js";

/** The left sidebar: tree, user info, and navigation buttons. */
function Sidebar() {
  const navigate = useNavigate();
  const { branchId } = useParams();
  const location = useLocation();
  const { data: session } = useSession();

  const isSettings = location.pathname.startsWith("/settings");

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Tree selectedBranchId={branchId ?? null} onSelectBranch={(id) => navigate(`/pages/${id}`)} />
      <div style={{ padding: 12, fontSize: 12, borderTop: "1px solid #ddd" }}>
        {session?.user.name} {session?.user.isAdmin ? "(admin)" : ""}
        {session?.user.isAdmin && (
          <button onClick={() => navigate(isSettings ? "/" : "/settings")} style={{ marginLeft: 8 }}>
            {isSettings ? "Back to pages" : "Settings"}
          </button>
        )}
        <button onClick={() => signOut()} style={{ marginLeft: 8 }}>Sign out</button>
      </div>
    </div>
  );
}

/** Wraps Editor so it reads branchId from the URL rather than a prop. */
function EditorRoute() {
  const { branchId } = useParams<{ branchId: string }>();
  return <Editor branchId={branchId!} />;
}

export default function App() {
  const { data: session, isPending, refetch } = useSession();

  if (isPending) return null;
  if (!session) return <Login onAuthed={() => refetch()} />;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui" }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: "auto" }}>
        <Routes>
          <Route path="/pages/:branchId" element={<EditorRoute />} />
          <Route path="/settings" element={<AdminSettings />} />
          <Route path="/" element={<div style={{ padding: 24, color: "#888" }}>Select or create a page</div>} />
        </Routes>
      </div>
    </div>
  );
}
